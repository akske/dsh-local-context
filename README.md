# dsh-local-context

**A local knowledge base for DeepSeek Harness (DSH) with zero native dependencies.**

Stop compiling C++ and installing Visual Studio just to keep long tool output out of your context window. `dsh-local-context` saves full command output into a local SQLite **FTS5** database using Node's built-in `node:sqlite` — no native addons, no prebuilt binaries, no build step.

[中文文档](README.zh.md) · [Why](#why-this-exists) · [Features](#features) · [Install](#install) · [Tools](#tools) · [How it works](#how-it-works) · [Configuration](#configuration) · [Development](#development) · [License](#license)

![license](https://img.shields.io/badge/license-MIT-blue)
![node](https://img.shields.io/badge/node-%3E%3D24-brightgreen)
![dependencies](https://img.shields.io/badge/dependencies-0-success)
![platform](https://img.shields.io/badge/platform-Windows-lightgrey)

---

## Why this exists

Agent tool results are context poison: a single `npm test`, `git diff`, or JSON dump can add thousands of tokens that you keep paying for until the session ends. The usual fix is a context-mode style plugin that extracts what matters into a searchable store.

Most of those plugins depend on **native SQLite bindings**. On Windows that means Visual Studio Build Tools, Python, a compiler toolchain, and the occasional native build failure that eats an entire afternoon.

This plugin makes the opposite trade: a simpler search stack built only on what already ships inside Node 24 / Electron. You install a folder; there is nothing to compile.

- No native addons, no prebuilt binary downloads
- No Visual Studio, Python, or C++ toolchain
- No npm dependencies at all — `package.json` declares none
- Verified on DSH desktop: **Electron 44.7.0 / Node 24.21.0 / SQLite 3.53.4**

## Features

- **Smart truncation** — output longer than 5,000 characters keeps the first 2,000 and the last 2,000; the middle is replaced by an exact omission marker (`... [省略 N 个字符的输出] ...`).
- **Full output, still searchable** — whenever truncation happens, the complete raw output is written to FTS5 first, so the model can recover any detail with `ctx_search`.
- **FTS5 + trigram + LIKE** — trigram indexing supports English and CJK substrings; 1–2 character Chinese queries automatically fall back to `LIKE`, where a pure trigram index cannot match.
- **bm25 ranking** — title weighted 5×, content 1×, top 3 by default, with highlighted ~400-character snippets and `full=true` for the complete chunk.
- **Timeout with a real kill** — default 120 s (max 600 s); on Windows the whole process tree is terminated with `taskkill /T /F`.
- **4 MiB output cap** — a runaway `cat` cannot exhaust memory; the command is stopped and what arrived is still stored.
- **Markdown-aware chunking** — headings and code fences are respected; chunks are 1,200 characters by default with a 1,600 hard cap.
- **Overwrite by title** — re-indexing the same `title` replaces its chunks, so build-fix-build loops do not accumulate stale data.
- **Safe to load** — lazy database init, WAL, `busy_timeout`; a broken database never prevents the DSH profile from booting.
- **Under 40 KB of runtime JavaScript** — five files, no bundler, no transpiler.

## Install

Requirements: DSH desktop on Windows 10/11, Node 24+ (bundled with current DSH desktop builds), Git Bash recommended for `language: "bash"`.

```bash
git clone https://github.com/akske/dsh-local-context.git
```

Install the folder as a DSH bundle (official path):

```text
plugin_manager(action: "install_bundle", target: "<absolute-path-to>/dsh-local-context")
```

Run this through the DSH plugin manager if your build exposes local bundle installation, or simply ask your DSH agent to install the bundle at that path. The CLI route also works where the profile's package manager is healthy:

```bash
dsh plugin --profile desktop add "<absolute-path-to>/dsh-local-context"
```

The three tools usually appear immediately. If they do not, restart DSH once.

Verify:

```text
ctx_exec({ command: "echo hello from ctx_exec" })
→ hello from ctx_exec
  [exit code: 0]
```

## Tools

| Tool | Purpose |
| --- | --- |
| `ctx_exec` | Run a shell command; truncate long output and archive the full text |
| `ctx_index` | Chunk text into the local knowledge base |
| `ctx_search` | Relevance search across everything stored |

### `ctx_exec`

| Parameter | Required | Description |
| --- | --- | --- |
| `command` | yes | Shell command. For Python/Node, write `python -c "..."` / `node -e "..."` |
| `language` | no | `bash` (default, Git Bash), `pwsh`, `cmd` |
| `cwd` | no | Working directory; relative paths resolve against the session directory |
| `timeoutMs` | no | `1000`–`600000`, default `120000`; timeout kills the process tree |

```text
ctx_exec({ command: "git log --oneline -20" })
ctx_exec({ command: "npm test", timeoutMs: 300000 })
ctx_exec({ command: "python -c 'print(sum(range(10)))'" })
```

Truncation contract:

- Triggers only when output is **strictly longer than 5,000** characters.
- Keeps 2,000 head + 2,000 tail; `N = total - 4000`.
- Appends the fixed warning telling the model to use `ctx_search`.
- Exit code, timeout, cap, and spawn failures are reported in the returned text; non-zero exits are marked as tool errors without hiding the output.

```text
ctx_exec({ command: "printf 'A%.0s' {1..6000}; printf 'NEEDLE'; printf 'B%.0s' {1..6000}" })
→ AAAAAAAA... (2000 chars)
  ... [省略 8020 个字符的输出] ...
  BBBBBBBB... (2000 chars)
  [exit code: 0]
  [警告：输出过长已被智能截断，完整原始输出已存入本地知识库。你可以使用 ctx_search 工具搜索关键信息]
```

`ctx_search({ query: "NEEDLE" })` then finds the omitted middle.

### `ctx_index`

| Parameter | Required | Description |
| --- | --- | --- |
| `text` | yes | Text to index; up to 1,000,000 characters per call |
| `title` | no | Source title; re-indexing the same title replaces old chunks |

Markdown headings become chunk titles (`doc > section`), code fences stay intact, and the response reports only counts.

### `ctx_search`

| Parameter | Required | Description |
| --- | --- | --- |
| `query` | yes | Search terms; 1–2 character Chinese queries are supported |
| `full` | no | `true` returns the complete matched chunk instead of a snippet |
| `limit` | no | 1–10, default `3` |

```text
ctx_search({ query: "trigram" })
ctx_search({ query: "开发" })                     # short CJK → LIKE fallback
ctx_search({ query: "UNIQUE_TOKEN", full: true }) # complete chunk
ctx_search({ query: "timeout", limit: 5 })
```

## How it works

```text
               ┌────────────────────────────┐
 ctx_exec ───► │ shell (bash/pwsh/cmd)      │
               │  └─ timeout → taskkill /T  │
               └────────────┬───────────────┘
                            │ stdout + stderr (≤ 4 MiB)
                            ▼
               ┌────────────────────────────┐
               │ truncate: 2000 + 2000      │──► returned to the model
               └────────────┬───────────────┘
                            │ full raw text (only when truncated)
                            ▼
               ┌────────────────────────────┐
               │ FTS5 chunks (trigram)      │◄── ctx_index
               │ node:sqlite · WAL          │
               └────────────┬───────────────┘
                            ▼
               ┌────────────────────────────┐
               │ ctx_search: bm25 → snippets│
               │ short query → LIKE fallback│
               └────────────────────────────┘
```

Search strategy is deliberately small:

1. Split the query on whitespace and strip FTS syntax characters.
2. Trigram `MATCH` with all terms (`AND`), then with any term (`OR`).
3. If the query is unindexable (1–2 characters) or FTS parsing fails, fall back to `LIKE` substring matching.
4. Rank with `bm25(chunks, 5.0, 1.0)`; return snippets or full chunks.

Everything runs in the DSH Host process; there is no server, socket, or subprocess for the database.

## Configuration

All keys are optional. Configure them in the bundle row in `cordis.patch.yml`:

| Key | Default | Description |
| --- | --- | --- |
| `dbPath` | `$DSH_HOME/local-context/local_context.db` (`~/.dsh/local-context/local_context.db`) | Absolute path to the SQLite file |
| `bashPath` | auto-detect | Explicit bash executable when PATH and common Git installs fail |
| `pwshPath` | auto-detect | Explicit `pwsh`/`powershell` executable |

The environment variable `DSH_LOCAL_CONTEXT_DB` overrides the default path; `dbPath` wins over the environment variable.

```yaml
- insert:
    - id: local-context
      name: dsh-local-context
      config:
        dbPath: 'D:/data/dsh-local-context.db'
```

Use an absolute path: a relative `dbPath` resolves against the DSH process working directory.

## Data & privacy

- The knowledge base is a single local SQLite file (plus transient `-wal` / `-shm` files). Nothing leaves your machine; there is no telemetry.
- Data is stored as plain text — do not index secrets you would not keep on disk.
- Delete the database file to reset the knowledge base.
- One database is shared by every session and profile on the machine; attribution is kept per chunk (`source`, `origin`, timestamp).
- `ctx_exec` runs commands with the DSH Host's privileges and **no sandbox**; never feed it untrusted, concatenated input.

## Development

```bash
npm test          # node --test test.js
```

The suite creates throwaway databases under the OS temp directory and never touches your real knowledge base. It covers truncation boundaries (4999/5000/5001/12000), surrogate pairs, chunking and code fences, exec success/stderr/exit codes, truncation → archive → search, Chinese 2-character queries, re-index replacement, `limit`/`full`, malformed FTS queries, the 4 MiB cap, timeout process-tree kill, missing interpreters, and the cmd OEM code-page decoder.

Dependency audit (intentionally trivial): `package.json` has no dependency fields, and every `import` is either `node:*` or a relative path.

```
index.js              plugin entry: apply(), tool registration, result formatting
lib/text.mjs          char-safe truncation, snippets, highlighting
lib/chunk.mjs         markdown/fence-aware chunker
lib/exec.mjs          shell spawning, timeout, process-tree kill, output cap, decoding
lib/db.mjs            node:sqlite schema, replace-by-source, bm25/LIKE search
locale/{en,zh}.json   plugin-manager display metadata
icon.svg              plugin icon
test.js               node:test suite (not shipped)
```

## Compatibility

- **Windows 10/11** is the primary target: Git Bash, `pwsh`, and `cmd` are supported; `taskkill` is used for timeouts.
- Linux/macOS work if `bash` is available and you set an absolute `dbPath`; the shell auto-detection is Windows-oriented.
- Requires Node 24+ where `node:sqlite` is available without a flag. Verified with Electron 44.7.0 (Node 24.21.0, SQLite 3.53.4).

## Limitations

- Tool descriptions are currently written in Chinese; the parameter schemas are language-neutral. Localization PRs are welcome.
- `cmd` output is decoded with the Windows OEM code page (936/GBK on Chinese systems) because a piped child cannot switch code pages. Programs that force UTF-8 inside `cmd` may still garble; prefer `bash` or `pwsh`.
- SQLite here is synchronous: a single very large `ctx_index` call can briefly block the Host event loop (caps keep this bounded).
- No encryption, no quota, no automatic purge.

## Acknowledgements

Inspired by two excellent projects:

- [mksglu/context-mode](https://github.com/mksglu/context-mode) — the original context-window tooling and FTS5 design ideas.
- [icanfinish11/dsh-context-mode](https://github.com/icanfinish11/dsh-context-mode) — the DSH bundle shape and in-process tool registration pattern.

This project is an **independent rewrite**. It vendors no code from either project, depends on neither at runtime, and replaces the native database layer with `node:sqlite`. Any remaining similarity is at the level of tool names and general architecture.

## License

[MIT](LICENSE) © 2026 dsh-local-context contributors
