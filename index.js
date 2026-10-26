// dsh-local-context — a zero-dependency local knowledge base plugin for
// DeepSeek Harness. It registers three native tools:
//
//   ctx_exec    run a shell command; long output is truncated and the full
//               raw text is stored in the local FTS5 database
//   ctx_index   chunk text into the FTS5 database
//   ctx_search  relevance search (trigram MATCH, LIKE fallback for short CJK)
//
// Only Node builtins are used (`node:sqlite`, `node:child_process`, `node:fs`),
// so nothing needs to be compiled and no package has to be installed.

import { statSync } from 'node:fs';
import { isAbsolute, resolve as resolvePath } from 'node:path';
import { chunkText } from './lib/chunk.mjs';
import {
  MAX_INDEX_CHARS,
  MAX_INDEX_CHUNKS,
  closeDb,
  countChunks,
  replaceSource,
  resolveDbPath,
  searchChunks,
} from './lib/db.mjs';
import {
  MAX_OUTPUT_BYTES,
  MAX_TIMEOUT_MS,
  normalizeLanguage,
  normalizeTimeout,
  runCommand,
} from './lib/exec.mjs';
import { TRUNCATION_WARNING, truncateOutput } from './lib/text.mjs';

export const name = 'dsh-local-context';
export const inject = ['tools'];

const OUTPUT = {
  schema: {
    type: 'object',
    properties: {
      text: { type: 'string' },
      isError: { type: 'boolean' },
    },
    required: ['text', 'isError'],
    additionalProperties: false,
  },
  render: (_args, value) => [
    { type: 'text', text: typeof value?.text === 'string' ? value.text : '' },
  ],
};

function makeLogger(ctx) {
  try {
    if (typeof ctx.logger === 'function') {
      const logger = ctx.logger('dsh-local-context');
      if (logger) return logger;
    }
  } catch { /* fall through */ }
  return { info() {}, warn() {}, error() {} };
}

function sessionCwdOf(exec) {
  const candidates = [
    exec?.agent?.session?.header?.cwd,
    exec?.agent?.session?.cwd,
    exec?.cwd,
  ];
  const found = candidates.find((value) => typeof value === 'string' && value.length > 0);
  return found ?? process.cwd();
}

function resolveCwd(requested, exec) {
  const base = sessionCwdOf(exec);
  const explicit = typeof requested === 'string' ? requested.trim() : '';
  if (explicit) {
    const absolute = isAbsolute(explicit) ? explicit : resolvePath(base, explicit);
    try {
      if (statSync(absolute).isDirectory()) return absolute;
    } catch { /* fall through to the error */ }
    throw new Error(`ctx_exec: cwd 不存在或不是目录：${absolute}`);
  }
  try {
    if (statSync(base).isDirectory()) return base;
  } catch { /* fall through */ }
  return process.cwd();
}

function timestampForSource(date) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function storeExecOutput(dbPath, { raw, command, language, now }) {
  const stamp = timestampForSource(now);
  const source = `exec:${stamp}`;
  const chunks = chunkText(raw, {
    title: `exec@${stamp}`,
    target: 2000,
    hardMax: 2400,
    splitHeadings: false,
  });
  const origin = `${language}: ${command.replace(/\s+/g, ' ').slice(0, 120)}`;
  replaceSource(dbPath, {
    source,
    kind: 'exec',
    origin,
    chunks,
    createdAt: now.toISOString(),
  });
  return chunks.length;
}

function createExecTool({ dbPath, bashPath, pwshPath, logger }) {
  return {
    name: 'ctx_exec',
    description:
      '执行 shell 命令并返回输出。输出超过 5000 字符时保留前 2000 与后 2000 字符，中间用省略标记替换，同时把完整原始输出写入本地 FTS5 知识库，之后可用 ctx_search 检索。language 可选 bash（默认，Git Bash）、pwsh、cmd；cwd 默认当前会话工作目录；timeoutMs 默认 120000，上限 600000。非零退出码与超时都会写进返回值。',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: '要执行的 shell 命令。需要 Python/Node 代码时请直接写 python -c "..." 或 node -e "..."。',
        },
        language: {
          type: 'string',
          enum: ['bash', 'pwsh', 'cmd'],
          description: 'shell 解释器，默认 bash（Git Bash）。',
        },
        cwd: {
          type: 'string',
          description: '工作目录；相对路径按当前会话工作目录解析。默认当前会话工作目录。',
        },
        timeoutMs: {
          type: 'integer',
          description: '超时毫秒数，默认 120000，最小 1000，最大 600000；超时会终止整个进程树。',
        },
      },
      required: ['command'],
    },
    output: OUTPUT,
    timeoutMs: MAX_TIMEOUT_MS + 30_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const command = typeof args?.command === 'string' ? args.command : '';
      if (command.trim() === '') throw new Error('ctx_exec: command 不能为空');
      if (command.includes('\u0000')) throw new Error('ctx_exec: command 含有非法空字符');

      const language = normalizeLanguage(args?.language);
      const timeoutMs = normalizeTimeout(args?.timeoutMs);
      const cwd = resolveCwd(args?.cwd, exec);

      const now = new Date();
      const outcome = await runCommand({
        command,
        language,
        cwd,
        timeoutMs,
        bashPath,
        pwshPath,
        signal: exec?.signal,
      });

      const raw = [outcome.stdout, outcome.stderr ? `[stderr]\n${outcome.stderr}` : '']
        .filter((part) => part.length > 0)
        .join('\n');
      const truncated = truncateOutput(raw);

      const notes = [];
      if (outcome.spawnError) notes.push(`[命令启动失败：${outcome.spawnError}]`);
      if (outcome.aborted) notes.push('[调用已被取消，命令已终止]');
      else if (outcome.timedOut) notes.push(`[命令超时，已在 ${timeoutMs}ms 后终止]`);
      if (outcome.capExceeded) notes.push(`[输出超过 ${MAX_OUTPUT_BYTES / (1024 * 1024)} MiB 上限，命令已被终止]`);
      if (typeof outcome.code === 'number') notes.push(`[exit code: ${outcome.code}]`);
      else if (outcome.signal) notes.push(`[signal: ${outcome.signal}]`);

      let stored = 0;
      let storeError = null;
      if (truncated.truncated && raw.length > 0) {
        try {
          stored = storeExecOutput(dbPath, { raw, command, language, now });
        } catch (error) {
          storeError = error;
          logger.warn?.(`[dsh-local-context] exec 输出入库失败：${error?.message ?? error}`);
        }
      }
      if (truncated.truncated) {
        notes.push(
          stored > 0
            ? TRUNCATION_WARNING
            : `[警告：输出过长已被智能截断，但完整原始输出入库失败：${storeError?.message ?? '未知错误'}]`,
        );
      }

      const body = truncated.text;
      const text = body && notes.length > 0 ? `${body}\n${notes.join('\n')}` : body || notes.join('\n');
      const isError = Boolean(
        outcome.spawnError
        || outcome.timedOut
        || outcome.aborted
        || outcome.capExceeded
        || (typeof outcome.code === 'number' && outcome.code !== 0),
      );
      return { text, isError };
    },
  };
}

function createIndexTool({ dbPath }) {
  return {
    name: 'ctx_index',
    description:
      '把一段文本分块写入本地 FTS5 知识库（trigram 索引，支持中文与英文子串检索），之后可用 ctx_search 找回原文。同一 title 再次索引会覆盖旧块。单次文本上限 100 万字符，目标块长 1200 字符，代码围栏不会被拆开。返回索引块数，不回显正文。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要索引的原文（Markdown 或纯文本）。' },
        title: {
          type: 'string',
          description: '来源标题；同一标题重复索引会覆盖。缺省为 untitled@时间戳。',
        },
      },
      required: ['text'],
    },
    output: OUTPUT,
    timeoutMs: 120_000,
    isConcurrencySafe: () => false,
    async execute(args) {
      const text = typeof args?.text === 'string' ? args.text : '';
      if (text.trim() === '') throw new Error('ctx_index: text 不能为空');
      if (text.length > MAX_INDEX_CHARS) {
        throw new Error(`ctx_index: text 长度 ${text.length}，超过单次上限 ${MAX_INDEX_CHARS}，请分批索引`);
      }

      const fallbackTitle = `untitled@${timestampForSource(new Date())}`;
      const title = typeof args?.title === 'string' && args.title.trim() ? args.title.trim() : fallbackTitle;
      const chunks = chunkText(text, { title });
      if (chunks.length === 0) throw new Error('ctx_index: 文本分块结果为空');
      if (chunks.length > MAX_INDEX_CHUNKS) {
        throw new Error(`ctx_index: 将产生 ${chunks.length} 块，超过单次上限 ${MAX_INDEX_CHUNKS}，请分批索引`);
      }

      try {
        const stored = replaceSource(dbPath, {
          source: title,
          kind: 'index',
          origin: 'ctx_index',
          chunks,
          createdAt: new Date().toISOString(),
        });
        const total = countChunks(dbPath);
        return { text: `已索引 ${stored} 块（来源：${title}）；知识库共 ${total} 块。`, isError: false };
      } catch (error) {
        throw new Error(`ctx_index: 写入知识库失败：${error?.message ?? error}`);
      }
    },
  };
}

function createSearchTool({ dbPath }) {
  return {
    name: 'ctx_search',
    description:
      '从本地知识库按相关度检索（bm25，默认返回前 3 条）。默认每条返回约 400 字命中片段、标题与来源；full=true 时返回该块完整正文。1–2 个字的中文查询会自动降级为 LIKE 子串匹配。知识库内容来自 ctx_exec 的超长输出与 ctx_index 的文本。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索词；中文 1–2 个字也可命中。' },
        full: { type: 'boolean', description: 'true 时返回命中块的完整正文，默认 false 只给片段。' },
        limit: { type: 'integer', description: '返回条数，默认 3，最大 10。' },
      },
      required: ['query'],
    },
    output: OUTPUT,
    timeoutMs: 30_000,
    isConcurrencySafe: () => true,
    async execute(args) {
      const query = typeof args?.query === 'string' ? args.query.trim() : '';
      if (query === '') throw new Error('ctx_search: query 不能为空');

      let result;
      try {
        result = searchChunks(dbPath, query, { limit: args?.limit, full: args?.full === true });
      } catch (error) {
        throw new Error(`ctx_search: 检索失败：${error?.message ?? error}`);
      }

      if (result.rows.length === 0) {
        return {
          text: `未找到匹配「${query}」的内容（知识库共 ${result.total} 块）。`,
          isError: false,
        };
      }

      const lines = [`命中 ${result.rows.length} 条（知识库共 ${result.total} 块）：`];
      result.rows.forEach((row, index) => {
        lines.push(`${index + 1}. ${row.title}`);
        const attribution = [row.source, row.origin].filter(Boolean).join(' | ');
        lines.push(`   来源：${attribution} | 时间：${row.createdAt ?? '未知'}`);
        if (result.full && typeof row.content === 'string') {
          lines.push('   正文：');
          lines.push(row.content);
        } else {
          lines.push(`   片段：${row.snippet}`);
        }
      });
      return { text: lines.join('\n'), isError: false };
    },
  };
}

export function apply(ctx, config = {}) {
  const logger = makeLogger(ctx);
  const dbPath = resolveDbPath(config);
  const bashPath = typeof config.bashPath === 'string' && config.bashPath.trim() ? config.bashPath.trim() : undefined;
  const pwshPath = typeof config.pwshPath === 'string' && config.pwshPath.trim() ? config.pwshPath.trim() : undefined;

  ctx.effect(() => {
    const disposers = [
      ctx.tools.register(createExecTool({ dbPath, bashPath, pwshPath, logger })),
      ctx.tools.register(createIndexTool({ dbPath })),
      ctx.tools.register(createSearchTool({ dbPath })),
    ];
    logger.info?.(`[dsh-local-context] 已注册 ctx_exec / ctx_index / ctx_search，知识库：${dbPath}`);
    return () => {
      for (const dispose of disposers) {
        try { dispose(); } catch { /* ignore */ }
      }
      try { closeDb(dbPath); } catch { /* ignore */ }
    };
  });
}
