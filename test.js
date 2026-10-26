// Temporary unit-test harness for dsh-local-context (Node built-in test runner).
// Uses throwaway databases under os.tmpdir(); never touches the production DB.

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test, { after } from 'node:test';

import { apply } from './index.js';
import { chunkText } from './lib/chunk.mjs';
import {
  closeAll,
  countChunks,
  defaultDbPath,
  resolveDbPath,
  searchChunks,
} from './lib/db.mjs';
import {
  MAX_OUTPUT_BYTES,
  decodeBuffer,
  normalizeTimeout,
  runCommand,
  windowsCodePage,
} from './lib/exec.mjs';
import {
  TRUNCATION_WARNING,
  charSafePrefix,
  charSafeSuffix,
  truncateOutput,
} from './lib/text.mjs';

const TMP_ROOT = mkdtempSync(join(tmpdir(), 'dsh-local-context-test-'));
let dbSeq = 0;

function tempDb() {
  dbSeq += 1;
  return join(TMP_ROOT, `db-${dbSeq}.db`);
}

function execCtx() {
  return {
    agent: { session: { header: { cwd: TMP_ROOT } } },
    signal: new AbortController().signal,
  };
}

/** Minimal stand-in for the Host plugin context: tools registry + effect. */
function createHost(config = {}) {
  const tools = new Map();
  const disposers = [];
  const ctx = {
    tools: {
      register(definition) {
        if (tools.has(definition.name)) throw new Error(`duplicate tool: ${definition.name}`);
        tools.set(definition.name, definition);
        const dispose = () => tools.delete(definition.name);
        disposers.push(dispose);
        return dispose;
      },
    },
    effect(callback) {
      const dispose = callback();
      const wrapped = () => {
        if (typeof dispose === 'function') dispose();
      };
      disposers.push(wrapped);
      return wrapped;
    },
    logger() {
      return { info() {}, warn() {}, error() {} };
    },
  };
  apply(ctx, config);
  return { tools, ctx, disposeAll: () => disposers.splice(0).forEach((fn) => fn()) };
}

after(() => {
  closeAll();
  try { rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ---------------------------------------------------------------- truncation

test('truncate: exactly 5000 chars is not truncated', () => {
  const result = truncateOutput('x'.repeat(5000));
  assert.equal(result.truncated, false);
  assert.equal(result.omitted, 0);
  assert.equal(result.text.length, 5000);
});

test('truncate: 5001 chars yields the exact marker and omitted count', () => {
  const result = truncateOutput('a'.repeat(5001));
  assert.equal(result.truncated, true);
  assert.equal(result.omitted, 1001);
  assert.equal(result.text.slice(0, 2000), 'a'.repeat(2000));
  assert.ok(result.text.includes('\n... [省略 1001 个字符的输出] ...\n'));
});

test('truncate: 12000 chars keeps head and tail', () => {
  const source = `${'H'.repeat(2000)}${'m'.repeat(8000)}${'T'.repeat(2000)}`;
  const result = truncateOutput(source);
  assert.equal(result.omitted, 8000);
  assert.equal(result.text.slice(0, 2000), 'H'.repeat(2000));
  assert.equal(result.text.slice(-2000), 'T'.repeat(2000));
  assert.ok(result.text.includes('省略 8000 个字符'));
});

test('truncate: the required warning text is exact', () => {
  assert.equal(
    TRUNCATION_WARNING,
    '[警告：输出过长已被智能截断，完整原始输出已存入本地知识库。你可以使用 ctx_search 工具搜索关键信息]',
  );
});

test('truncate: surrogate pairs are never split', () => {
  const prefix = charSafePrefix(`${'a'.repeat(1999)}😀`, 2000);
  assert.equal(prefix.length, 1999);
  const suffix = charSafeSuffix(`😀${'b'.repeat(1999)}`, 2000);
  assert.equal(suffix.length, 1999);
  const single = truncateOutput(`${'a'.repeat(1999)}😀${'b'.repeat(2000)}`);
  assert.ok(!/[\uD800-\uDBFF]$/.test(single.text));
});

// ------------------------------------------------------------------ chunking

test('chunk: markdown headings and fences are respected', () => {
  const text = [
    '# 标题A',
    '第一段内容。',
    '## 小节B',
    '```js',
    'const x = 1;',
    'console.log(x);',
    '```',
    '正'.repeat(1500),
  ].join('\n');
  const chunks = chunkText(text, { title: '文档' });
  assert.ok(chunks.length >= 3, `expected >=3 chunks, got ${chunks.length}`);
  assert.ok(chunks[0].title.includes('标题A'));
  assert.ok(chunks.some((chunk) => chunk.title.includes('小节B')));
  for (const chunk of chunks) {
    assert.ok(chunk.content.length <= 1600, `chunk too long: ${chunk.content.length}`);
    const fences = chunk.content.split('\n').filter((line) => line.trimStart().startsWith('```')).length;
    assert.equal(fences % 2, 0, 'code fence must not be split across chunks');
  }
});

test('chunk: an overlong single line is hard-split', () => {
  const chunks = chunkText('x'.repeat(4000), { title: 'long' });
  assert.equal(chunks.length, 3);
  assert.deepEqual(chunks.map((chunk) => chunk.content.length), [1600, 1600, 800]);
});

// ------------------------------------------------------- plugin registration

test('plugin: apply() registers the three tools with valid schemas', () => {
  const { tools } = createHost({ dbPath: tempDb() });
  assert.deepEqual([...tools.keys()].sort(), ['ctx_exec', 'ctx_index', 'ctx_search']);
  for (const tool of tools.values()) {
    assert.equal(typeof tool.description, 'string');
    assert.ok(tool.description.length > 40);
    assert.equal(tool.parameters.type, 'object');
    assert.equal(tool.output.schema.type, 'object');
    assert.equal(typeof tool.output.render, 'function');
    assert.equal(typeof tool.execute, 'function');
  }
  assert.deepEqual(tools.get('ctx_exec').parameters.required, ['command']);
  assert.equal(tools.get('ctx_index').parameters.required[0], 'text');
  assert.equal(tools.get('ctx_search').parameters.required[0], 'query');
  assert.deepEqual(tools.get('ctx_search').parameters.properties.limit.type, 'integer');
  assert.equal(tools.get('ctx_search').parameters.properties.full.type, 'boolean');
});

// ---------------------------------------------------------------------- exec

test('exec: short output is returned verbatim with exit code', async () => {
  const { tools } = createHost({ dbPath: tempDb() });
  const result = await tools.get('ctx_exec').execute({ command: 'echo hello-ctx' }, execCtx());
  assert.equal(result.isError, false);
  assert.match(result.text, /hello-ctx/);
  assert.match(result.text, /\[exit code: 0\]/);
  assert.ok(!result.text.includes('警告：输出过长'));
});

test('exec: Chinese output survives the pipe', async () => {
  const { tools } = createHost({ dbPath: tempDb() });
  const result = await tools.get('ctx_exec').execute({ command: 'echo 你好，世界' }, execCtx());
  assert.match(result.text, /你好，世界/);
  assert.equal(result.isError, false);
});

test('exec: stderr and non-zero exit are reported as an error result', async () => {
  const { tools } = createHost({ dbPath: tempDb() });
  const result = await tools.get('ctx_exec').execute(
    { command: 'printf "oops\\n" >&2; exit 3' },
    execCtx(),
  );
  assert.equal(result.isError, true);
  assert.match(result.text, /\[stderr\]/);
  assert.match(result.text, /oops/);
  assert.match(result.text, /\[exit code: 3\]/);
});

test('cmd: OEM code page bytes decode back to Chinese', { skip: windowsCodePage() !== 936 }, () => {
  assert.equal(decodeBuffer(Buffer.from([0xd6, 0xd0, 0xce, 0xc4]), 'cmd'), '中文');
});

test('cmd: Chinese echo stays readable through the real shell', { skip: windowsCodePage() !== 936 }, async () => {
  const result = await runCommand({ command: 'echo 中文cmd', language: 'cmd', cwd: TMP_ROOT });
  assert.equal(result.spawnError, null);
  assert.match(result.stdout, /中文cmd/);
});

test('exec: long output is truncated, stored, and searchable', { timeout: 60000 }, async () => {
  const dbPath = tempDb();
  const { tools } = createHost({ dbPath });
  const command = [
    "printf 'A%.0s' {1..6000}",
    "printf 'MIDDLE_TOKEN_XYZ'",
    "printf 'B%.0s' {1..6000}",
  ].join('; ');

  const result = await tools.get('ctx_exec').execute({ command }, execCtx());
  assert.equal(result.isError, false);
  assert.ok(!result.text.includes('MIDDLE_TOKEN_XYZ'), 'middle of the output must be omitted');
  assert.ok(result.text.includes(TRUNCATION_WARNING));
  assert.match(result.text, /省略 \d+ 个字符的输出/);
  assert.ok(existsSync(dbPath), 'database file should exist');

  const found = await tools.get('ctx_search').execute({ query: 'MIDDLE_TOKEN_XYZ' }, execCtx());
  assert.match(found.text, /MIDDLE_TOKEN_XYZ/);
  assert.match(found.text, /exec@/);
});

// ---------------------------------------------------------------- index/search

test('index + search: trigram lookup returns the stored title', async () => {
  const { tools } = createHost({ dbPath: tempDb() });
  const indexed = await tools.get('ctx_index').execute(
    {
      title: '设计说明',
      text: '# 知识库设计\n\n本地知识库使用 trigram 索引，支持中英文子串检索，数据落在本地 SQLite 文件中。',
    },
    execCtx(),
  );
  assert.match(indexed.text, /已索引 1 块/);

  const found = await tools.get('ctx_search').execute({ query: 'trigram' }, execCtx());
  assert.match(found.text, /设计说明/);
  assert.match(found.text, /命中 1 条/);
});

test('index + search: 2-character Chinese query uses the LIKE fallback', async () => {
  const { tools } = createHost({ dbPath: tempDb() });
  await tools.get('ctx_index').execute(
    { title: '中文测试', text: '插件开发需要零依赖，使用 node:sqlite 完成全文检索。' },
    execCtx(),
  );
  const found = await tools.get('ctx_search').execute({ query: '开发' }, execCtx());
  assert.match(found.text, /中文测试/);
  assert.match(found.text, /插件\*\*开发\*\*需要零依赖|插件开发需要零依赖/);
});

test('index: re-indexing the same title replaces the old chunks', async () => {
  const dbPath = tempDb();
  const { tools } = createHost({ dbPath });
  await tools.get('ctx_index').execute({ title: '同一个来源', text: '第一版内容 alpha' }, execCtx());
  const first = countChunks(dbPath);
  await tools.get('ctx_index').execute({ title: '同一个来源', text: '第二版内容 beta' }, execCtx());
  assert.equal(countChunks(dbPath), first);

  const old = await tools.get('ctx_search').execute({ query: 'alpha' }, execCtx());
  assert.match(old.text, /未找到/);
  const fresh = await tools.get('ctx_search').execute({ query: 'beta' }, execCtx());
  assert.match(fresh.text, /同一个来源/);
});

test('search: limit is honoured', async () => {
  const { tools } = createHost({ dbPath: tempDb() });
  for (let i = 0; i < 3; i += 1) {
    await tools.get('ctx_index').execute(
      { title: `文档${i}`, text: `sharedterm 出现在第 ${i} 篇文档。` },
      execCtx(),
    );
  }
  const found = await tools.get('ctx_search').execute({ query: 'sharedterm', limit: 2 }, execCtx());
  assert.match(found.text, /命中 2 条/);
});

test('search: full=true returns the complete chunk body', async () => {
  const { tools } = createHost({ dbPath: tempDb() });
  const body = `alpha ${'x'.repeat(900)} UNIQUE_FULL_42 ${'y'.repeat(1000)}`;
  await tools.get('ctx_index').execute({ title: '全文测试', text: body }, execCtx());

  const snippet = await tools.get('ctx_search').execute({ query: 'alpha' }, execCtx());
  assert.ok(!snippet.text.includes('UNIQUE_FULL_42'), 'snippet should not reach the far end');

  const full = await tools.get('ctx_search').execute({ query: 'alpha', full: true }, execCtx());
  assert.match(full.text, /UNIQUE_FULL_42/);
});

test('search: empty knowledge base and invalid FTS syntax are safe', async () => {
  const { tools } = createHost({ dbPath: tempDb() });
  const empty = await tools.get('ctx_search').execute({ query: 'nothing-here' }, execCtx());
  assert.match(empty.text, /未找到/);
  assert.equal(empty.isError, false);

  const sketchy = await tools.get('ctx_search').execute({ query: 'foo" OR *' }, execCtx());
  assert.equal(sketchy.isError, false);
  assert.match(sketchy.text, /未找到/);
});

// ------------------------------------------------------------ infrastructure

test('db: path precedence is config > env > default', () => {
  const previous = process.env.DSH_LOCAL_CONTEXT_DB;
  const configPath = join(TMP_ROOT, 'from-config.db');
  const envPath = join(TMP_ROOT, 'from-env.db');
  process.env.DSH_LOCAL_CONTEXT_DB = envPath;
  try {
    assert.equal(resolveDbPath({ dbPath: configPath }), resolve(configPath));
    assert.equal(resolveDbPath({}), resolve(envPath));
    delete process.env.DSH_LOCAL_CONTEXT_DB;
    assert.equal(resolveDbPath({}), resolve(defaultDbPath()));
  } finally {
    if (previous === undefined) delete process.env.DSH_LOCAL_CONTEXT_DB;
    else process.env.DSH_LOCAL_CONTEXT_DB = previous;
  }
});

test('db: default lives under DSH_HOME and never inside the package', () => {
  const fakeHome = join(TMP_ROOT, 'fake-home');
  assert.equal(
    defaultDbPath({ DSH_HOME: fakeHome }),
    join(fakeHome, 'local-context', 'local_context.db'),
  );
});

test('exec: timeout is normalised into [1000, 600000]', () => {
  assert.equal(normalizeTimeout(Number.NaN), 120000);
  assert.equal(normalizeTimeout(500), 1000);
  assert.equal(normalizeTimeout(999999), 600000);
  assert.equal(normalizeTimeout(30000), 30000);
});

test('runCommand: timeout kills the process tree and reports it', { timeout: 30000 }, async () => {
  const started = Date.now();
  const result = await runCommand({
    command: 'sleep 5',
    language: 'bash',
    cwd: TMP_ROOT,
    timeoutMs: 1000,
  });
  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - started < 8000, 'must not wait for the full sleep');
});

test('runCommand: output beyond 4 MiB is capped and the command is killed', { timeout: 60000 }, async () => {
  const result = await runCommand({
    command: "head -c 5000000 /dev/zero | tr '\\0' 'x'",
    language: 'bash',
    cwd: TMP_ROOT,
    timeoutMs: 30000,
  });
  assert.equal(result.capExceeded, true);
  assert.ok(result.stdout.length <= MAX_OUTPUT_BYTES);
});

test('runCommand: missing interpreter surfaces a spawn error', async () => {
  const previous = process.env.ComSpec;
  process.env.ComSpec = join(TMP_ROOT, 'definitely-missing', 'cmd.exe');
  try {
    const result = await runCommand({ command: 'echo hi', language: 'cmd', cwd: TMP_ROOT });
    assert.ok(result.spawnError, 'expected spawnError');
  } finally {
    if (previous === undefined) delete process.env.ComSpec;
    else process.env.ComSpec = previous;
  }
});

test('index: oversized text is rejected before writing', async () => {
  const { tools } = createHost({ dbPath: tempDb() });
  await assert.rejects(
    () => tools.get('ctx_index').execute({ text: 'x'.repeat(1_000_001) }, execCtx()),
    /超过单次上限/,
  );
});

test('exec: empty command is rejected', async () => {
  const { tools } = createHost({ dbPath: tempDb() });
  await assert.rejects(
    () => tools.get('ctx_exec').execute({ command: '   ' }, execCtx()),
    /command 不能为空/,
  );
});

test('searchChunks: direct API respects limit and reports mode', () => {
  const dbPath = tempDb();
  const { tools } = createHost({ dbPath });
  return tools.get('ctx_index').execute(
    { title: '接口测试', text: 'direct-api keyword here' },
    execCtx(),
  ).then(() => {
    const result = searchChunks(dbPath, 'keyword', { limit: 1, full: false });
    assert.equal(result.limit, 1);
    assert.equal(result.rows.length, 1);
    assert.equal(result.mode, 'fts');
    assert.ok(result.rows[0].snippet.includes('keyword'));
    assert.equal(result.rows[0].content, undefined);
  });
});
