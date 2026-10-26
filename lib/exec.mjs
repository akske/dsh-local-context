// Command execution with timeout, process-tree kill, output cap and UTF-8 decoding.
// Pure Node builtins; no dependencies.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

export const DEFAULT_TIMEOUT_MS = 120_000;
export const MIN_TIMEOUT_MS = 1_000;
export const MAX_TIMEOUT_MS = 600_000;
export const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

const LANGUAGES = new Set(['bash', 'pwsh', 'cmd']);

const BASH_CANDIDATES = [
  String.raw`C:\Program Files\Git\bin\bash.exe`,
  String.raw`C:\Program Files\Git\usr\bin\bash.exe`,
  String.raw`C:\Program Files (x86)\Git\bin\bash.exe`,
];

const PWSH_CANDIDATES = [
  String.raw`C:\Program Files\PowerShell\7\pwsh.exe`,
  String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`,
];

const PS_UTF8_PREFIX =
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $OutputEncoding = [System.Text.Encoding]::UTF8; ';

export function normalizeLanguage(value) {
  return typeof value === 'string' && LANGUAGES.has(value) ? value : 'bash';
}

export function normalizeTimeout(value) {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, numeric));
}

function dedupe(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    if (typeof value !== 'string' || value.trim() === '') continue;
    const key = value.trim();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

// --- Windows console decoding -------------------------------------------
// `cmd` writes its output in the console output code page; `chcp 65001`
// cannot change that for a piped (non-console) child, so Chinese Windows
// emits GBK bytes. Detect the active code page once and decode accordingly.

const CODE_PAGE_DECODERS = new Map([
  [936, 'gbk'],
  [54936, 'gb18030'],
  [65001, 'utf-8'],
  [1252, 'windows-1252'],
]);

let cachedCodePage;

export function windowsCodePage() {
  if (cachedCodePage !== undefined) return cachedCodePage;
  cachedCodePage = 0;
  if (process.platform !== 'win32') return cachedCodePage;
  try {
    const exe = typeof process.env.ComSpec === 'string' && process.env.ComSpec.trim()
      ? process.env.ComSpec.trim()
      : 'cmd.exe';
    const probe = spawnSync(exe, ['/d', '/c', 'chcp'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const text = new TextDecoder('gbk').decode(probe.stdout ?? Buffer.alloc(0));
    const match = /(\d{3,5})/.exec(text);
    if (match) cachedCodePage = Number(match[1]);
  } catch { /* keep 0 (unknown) */ }
  return cachedCodePage;
}

/** Decode captured command bytes for the shell that produced them. */
export function decodeBuffer(buffer, language) {
  const data = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? []);
  if (language === 'cmd') {
    const decoderName = CODE_PAGE_DECODERS.get(windowsCodePage());
    if (decoderName) {
      try {
        return new TextDecoder(decoderName).decode(data).replace(/^\uFEFF/, '');
      } catch { /* fall back to UTF-8 */ }
    }
  }
  return data.toString('utf8').replace(/^\uFEFF/, '');
}

function buildAttempts({ command, language, bashPath, pwshPath }) {
  if (language === 'cmd') {
    const exe = typeof process.env.ComSpec === 'string' && process.env.ComSpec.trim()
      ? process.env.ComSpec.trim()
      : 'cmd.exe';
    return [{ exe, args: ['/d', '/s', '/c', command] }];
  }

  if (language === 'pwsh') {
    const candidates = dedupe([
      pwshPath,
      'pwsh',
      ...PWSH_CANDIDATES.filter((candidate) => existsSync(candidate)),
      'powershell.exe',
    ]);
    return candidates.map((exe) => ({
      exe,
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', PS_UTF8_PREFIX + command],
    }));
  }

  const candidates = dedupe([
    bashPath,
    'bash',
    ...BASH_CANDIDATES.filter((candidate) => existsSync(candidate)),
    'bash.exe',
  ]);
  return candidates.map((exe) => ({ exe, args: ['-c', command] }));
}

function emptyResult(spawnError = null) {
  return {
    stdout: '',
    stderr: '',
    code: null,
    signal: null,
    timedOut: false,
    capExceeded: false,
    aborted: false,
    spawnError,
  };
}

function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } catch { /* ignore */ }
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ }
  }
}

function spawnOnce(attempt, { cwd, timeoutMs, signal, language }) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    let child;
    try {
      child = spawn(attempt.exe, attempt.args, {
        cwd,
        env: {
          ...process.env,
          PAGER: 'cat',
          GIT_PAGER: 'cat',
          GIT_TERMINAL_PROMPT: '0',
          NO_COLOR: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        detached: process.platform !== 'win32',
      });
    } catch (error) {
      finish(emptyResult(`无法启动 ${attempt.exe}: ${error.message}`));
      return;
    }

    const outChunks = [];
    const errChunks = [];
    let outBytes = 0;
    let errBytes = 0;
    let capExceeded = false;
    let timedOut = false;
    let aborted = false;
    let killed = false;

    const killNow = () => {
      if (killed) return;
      killed = true;
      killTree(child.pid);
    };

    const collect = (chunk, sink, isStdout) => {
      if (capExceeded) return;
      if (outBytes + errBytes + chunk.length > MAX_OUTPUT_BYTES) {
        capExceeded = true;
        killNow();
        return;
      }
      sink.push(chunk);
      if (isStdout) outBytes += chunk.length;
      else errBytes += chunk.length;
    };

    child.stdout?.on('data', (chunk) => collect(chunk, outChunks, true));
    child.stderr?.on('data', (chunk) => collect(chunk, errChunks, false));

    const timer = setTimeout(() => {
      timedOut = true;
      killNow();
    }, timeoutMs);

    const onAbort = () => {
      aborted = true;
      killNow();
    };

    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    const cleanup = () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    };

    child.on('error', (error) => {
      cleanup();
      const detail = `${attempt.exe}: ${error.code ? `${error.code} ` : ''}${error.message}`.trim();
      finish(emptyResult(detail));
    });

    child.on('close', (code, childSignal) => {
      cleanup();
      const stdout = decodeBuffer(Buffer.concat(outChunks), language);
      const stderr = decodeBuffer(Buffer.concat(errChunks), language);
      finish({
        stdout,
        stderr,
        code: typeof code === 'number' ? code : null,
        signal: childSignal ?? null,
        timedOut,
        capExceeded,
        aborted,
        spawnError: null,
      });
    });
  });
}

/**
 * Run `command` with the requested shell. Falls through candidate interpreters
 * only when spawning fails with ENOENT, so a missing `pwsh` can fall back to
 * Windows PowerShell without hiding real execution errors.
 */
export async function runCommand(options) {
  const command = typeof options?.command === 'string' ? options.command : '';
  const language = normalizeLanguage(options?.language);
  const timeoutMs = normalizeTimeout(options?.timeoutMs);
  const attempts = buildAttempts({
    command,
    language,
    bashPath: options?.bashPath,
    pwshPath: options?.pwshPath,
  });

  let lastError = null;
  for (const attempt of attempts) {
    const result = await spawnOnce(attempt, {
      cwd: options?.cwd,
      timeoutMs,
      signal: options?.signal,
      language,
    });
    if (!result.spawnError) {
      return { ...result, timeoutMs, exe: attempt.exe, language };
    }
    lastError = result.spawnError;
    if (!/ENOENT|not found/i.test(result.spawnError)) break;
  }

  return { ...emptyResult(lastError ?? '无法启动命令'), timeoutMs, exe: attempts[0]?.exe ?? null, language };
}
