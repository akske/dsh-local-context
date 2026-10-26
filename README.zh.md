# dsh-local-context

**给 DeepSeek Harness（DSH）的零原生依赖本地知识库。**

不用再为了把超长工具输出拿出上下文窗口，去装 Visual Studio、编译 C++。`dsh-local-context` 使用 Node 内置的 `node:sqlite`，把完整命令输出存进本地 SQLite + FTS5：没有原生插件、没有预编译二进制、没有任何构建步骤。

[English](README.md) · [为什么做它](#为什么做它) · [特性](#特性) · [安装](#安装) · [三个工具](#三个工具) · [工作原理](#工作原理) · [配置](#配置) · [开发](#开发) · [License](#license)

![license](https://img.shields.io/badge/license-MIT-blue)
![node](https://img.shields.io/badge/node-%3E%3D24-brightgreen)
![dependencies](https://img.shields.io/badge/dependencies-0-success)
![platform](https://img.shields.io/badge/platform-Windows-lightgrey)

---

## 为什么做它

Agent 的工具结果会持续吃掉上下文：一次 `npm test`、一段 `git diff`、一份 JSON dump，动辄几千 token，而且直到会话结束都在计费。常见解法是 context-mode 类插件——把完整输出存进可检索的库，只把有用的部分返回给模型。

但这些插件大多依赖**原生 SQLite 绑定**。在 Windows 上，这意味着 Visual Studio Build Tools、Python、编译器工具链，以及一次就能耗掉一下午的构建失败。

这个插件选择另一条路：用 Node 24 / Electron **已经自带**的能力，搭一套够用的检索栈。你只需要装一个文件夹，没有任何东西需要编译。

- 无原生插件、无预编译二进制下载
- 无需 Visual Studio、Python 或 C++ 工具链
- `package.json` 不声明任何 npm 依赖
- 已在 DSH 桌面端实测：**Electron 44.7.0 / Node 24.21.0 / SQLite 3.53.4**

## 特性

- **智能截断**：输出超过 5000 字符时保留前 2000 + 后 2000，中间替换为精确的省略标记（`... [省略 N 个字符的输出] ...`）。
- **完整原文仍可检索**：只要发生截断，完整原始输出会先写入 FTS5；模型随后可用 `ctx_search` 找回任意细节。
- **FTS5 + trigram + LIKE**：trigram 支持中英文子串；1–2 个字的纯中文查询自动降级到 `LIKE`，弥补 trigram 无法命中短词的短板。
- **bm25 相关度排序**：标题权重 5、正文 1，默认返回前 3 条；默认给约 400 字高亮片段，`full=true` 可取完整块。
- **超时真的杀进程**：默认 120 秒、上限 600 秒；Windows 上用 `taskkill /T /F` 结束整棵进程树。
- **4 MiB 输出硬上限**：`cat` 大文件也不会撑爆内存；命令被终止，已收到的内容仍会入库。
- **Markdown 感知分块**：识别标题层级、代码围栏不拆开；默认 1200 字符一块、硬上限 1600。
- **同 title 覆盖**：重复索引同一标题会替换旧块，build-fix-build 不会越积越多。
- **加载安全**：数据库懒初始化、WAL、busy_timeout；库坏了也不会拖垮 DSH profile 启动。
- **运行时 JS 不到 40 KB**：5 个文件，无打包器、无转译器。

## 安装

要求：Windows 10/11 上的 DSH 桌面端、Node 24+（当前 DSH 桌面端已内置），推荐安装 Git Bash（`language: "bash"` 默认使用它）。

```bash
git clone https://github.com/akske/dsh-local-context.git
```

把目录作为 DSH bundle 安装（官方路径）：

```text
plugin_manager(action: "install_bundle", target: "<绝对路径>/dsh-local-context")
```

可以在 DSH 插件管理器中安装本地 bundle（若你的版本提供该入口），也可以直接让 DSH agent 安装这个路径的 bundle。profile 的包管理器健康时，CLI 方式同样可用：

```bash
dsh plugin --profile desktop add "<绝对路径>/dsh-local-context"
```

通常三个工具会立即出现；如果没有，重启一次 DSH。

验证：

```text
ctx_exec({ command: "echo hello from ctx_exec" })
→ hello from ctx_exec
  [exit code: 0]
```

## 三个工具

| 工具 | 作用 |
| --- | --- |
| `ctx_exec` | 执行 shell 命令；智能截断超长输出并归档完整原文 |
| `ctx_index` | 把文本分块写入本地知识库 |
| `ctx_search` | 在已存内容中按相关度检索 |

### `ctx_exec`

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `command` | 是 | shell 命令。需要 Python/Node 时直接写 `python -c "..."` / `node -e "..."` |
| `language` | 否 | `bash`（默认，Git Bash）、`pwsh`、`cmd` |
| `cwd` | 否 | 工作目录；相对路径按会话目录解析 |
| `timeoutMs` | 否 | `1000`–`600000`，默认 `120000`；超时会终止进程树 |

```text
ctx_exec({ command: "git log --oneline -20" })
ctx_exec({ command: "npm test", timeoutMs: 300000 })
ctx_exec({ command: "python -c 'print(sum(range(10)))'" })
```

截断行为：

- 仅当输出**严格大于 5000** 字符时触发。
- 保留 2000 头 + 2000 尾，`N = 总长 - 4000`。
- 末尾附固定警告语，提示模型用 `ctx_search` 找细节。
- 退出码、超时、输出超限、启动失败都会写进返回值；非零退出标记为错误，但正文不丢。

```text
ctx_exec({ command: "printf 'A%.0s' {1..6000}; printf 'NEEDLE'; printf 'B%.0s' {1..6000}" })
→ AAAAAAAA...（2000 字符）
  ... [省略 8020 个字符的输出] ...
  BBBBBBBB...（2000 字符）
  [exit code: 0]
  [警告：输出过长已被智能截断，完整原始输出已存入本地知识库。你可以使用 ctx_search 工具搜索关键信息]
```

之后 `ctx_search({ query: "NEEDLE" })` 就能命中被省略的中段。

### `ctx_index`

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `text` | 是 | 要索引的文本，单次上限 100 万字符 |
| `title` | 否 | 来源标题；再次索引同一标题会覆盖旧块 |

Markdown 标题会变成块标题（`文档 > 小节`），代码围栏保持完整，返回值只报告块数。

### `ctx_search`

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `query` | 是 | 检索词；支持 1–2 个字的纯中文 |
| `full` | 否 | `true` 返回命中块完整正文，默认只给片段 |
| `limit` | 否 | 1–10，默认 `3` |

```text
ctx_search({ query: "trigram" })
ctx_search({ query: "开发" })                      # 短中文 → LIKE 兜底
ctx_search({ query: "UNIQUE_TOKEN", full: true })  # 取完整块
ctx_search({ query: "timeout", limit: 5 })
```

## 工作原理

```text
               ┌────────────────────────────┐
 ctx_exec ───► │ shell（bash/pwsh/cmd）      │
               │  └─ 超时 → taskkill /T     │
               └────────────┬───────────────┘
                            │ stdout + stderr（≤ 4 MiB）
                            ▼
               ┌────────────────────────────┐
               │ 截断：2000 + 2000          │──► 返回给模型
               └────────────┬───────────────┘
                            │ 仅截断时写完整原文
                            ▼
               ┌────────────────────────────┐
               │ FTS5 chunks（trigram）     │◄── ctx_index
               │ node:sqlite · WAL          │
               └────────────┬───────────────┘
                            ▼
               ┌────────────────────────────┐
               │ ctx_search：bm25 → 片段    │
               │ 短查询 → LIKE 兜底         │
               └────────────────────────────┘
```

检索策略刻意保持简单：

1. 按空白拆词并剔除 FTS 语法字符。
2. trigram `MATCH`：先全词 `AND`，再任一 `OR`。
3. 查询太短（1–2 字）或 FTS 解析失败时，降级为 `LIKE` 子串。
4. `bm25(chunks, 5.0, 1.0)` 排序，返回片段或完整块。

数据库完全运行在 DSH Host 进程内，没有额外服务、端口或子进程。

## 配置

所有键都是可选的，写在 `cordis.patch.yml` 的 bundle row 里：

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `dbPath` | `$DSH_HOME/local-context/local_context.db`（即 `~/.dsh/local-context/local_context.db`） | SQLite 文件的绝对路径 |
| `bashPath` | 自动探测 | PATH 与常见 Git 安装位置都找不到时，显式指定 bash |
| `pwshPath` | 自动探测 | 显式指定 `pwsh` / `powershell` |

环境变量 `DSH_LOCAL_CONTEXT_DB` 可覆盖默认路径；`dbPath` 优先级高于环境变量。

```yaml
- insert:
    - id: local-context
      name: dsh-local-context
      config:
        dbPath: 'D:/data/dsh-local-context.db'
```

请使用绝对路径：相对 `dbPath` 会按 DSH 进程的工作目录解析。

## 数据与隐私

- 知识库就是本地一个 SQLite 文件（以及临时的 `-wal` / `-shm`）。数据不出本机，没有遥测。
- 内容以明文存储——不要把你不愿落盘的密钥索引进库。
- 删除数据库文件即可清空知识库。
- 同一台机器上的所有会话、profile 共用一个库；每条块记录保留 `source`、`origin` 与时间戳。
- `ctx_exec` 以 DSH Host 权限执行命令且**没有沙箱**；不要用它执行由不可信输入拼接出的命令。

## 开发

```bash
npm test          # node --test test.js
```

测试在系统临时目录创建一次性数据库，绝不触碰真实知识库。覆盖：截断边界（4999/5000/5001/12000）、代理对、Markdown/围栏分块、exec 成功/stderr/退出码、截断→入库→检索、中文双字查询、覆盖索引、`limit`/`full`、非法 FTS 语法、4 MiB 上限、超时杀树、缺失解释器、cmd OEM 代码页解码。

依赖审计（刻意保持简单）：`package.json` 没有任何依赖字段；所有 `import` 只允许 `node:*` 或相对路径。

```
index.js              插件入口：apply()、工具注册、结果格式化
lib/text.mjs          字符安全截断、片段、高亮
lib/chunk.mjs         Markdown / 代码围栏感知分块
lib/exec.mjs          shell 启动、超时、杀进程树、输出上限、解码
lib/db.mjs            node:sqlite 建表、按来源覆盖、bm25/LIKE 检索
locale/{en,zh}.json   插件管理器的显示元数据
icon.svg              插件图标
test.js               node:test 测试（不随包发布）
```

## 兼容性

- **Windows 10/11** 是主要目标：支持 Git Bash、`pwsh`、`cmd`，超时用 `taskkill`。
- Linux/macOS 在具备 `bash` 且显式设置绝对 `dbPath` 时可用；shell 自动探测偏 Windows。
- 需要 Node 24+（`node:sqlite` 无需实验开关）。已在 Electron 44.7.0（Node 24.21.0、SQLite 3.53.4）验证。

## 限制

- 工具描述目前是中文；参数 schema 与语言无关。欢迎提交本地化 PR。
- `cmd` 在管道下无法切换代码页，输出按 Windows OEM 代码页（中文系统为 936/GBK）解码；在 `cmd` 内强制输出 UTF-8 的程序仍可能乱码，优先用 `bash` 或 `pwsh`。
- SQLite 是同步 API：一次超大的 `ctx_index` 可能短暂阻塞 Host 事件循环（已有上限约束）。
- 不加密、不限额、不自动清理。

## 致谢

灵感来自两个优秀项目：

- [mksglu/context-mode](https://github.com/mksglu/context-mode) — 上下文窗口工具与 FTS5 设计思路的源头。
- [icanfinish11/dsh-context-mode](https://github.com/icanfinish11/dsh-context-mode) — DSH bundle 形态与进程内工具注册模式。

本项目是**独立重写**：不包含上述项目的代码，运行时不依赖它们，并用 `node:sqlite` 替换了原生数据库层。若仍有相似之处，仅停留在工具命名与总体架构层面。

## License

[MIT](LICENSE) © 2026 dsh-local-context contributors
