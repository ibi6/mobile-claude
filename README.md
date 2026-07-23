# Mobile Claude Code

**Self-hosted coding agent · Mobile remote console · Structured tool governance**

> 在可信主机上运行具备完整工具循环的 Claude Agent；手机端仅作为**高交互控制面**（流式会话、权限决策、Diff 检视、工作区导航）。  
> 架构取向：**执行面与决策面分离（split-plane）** —— 密钥、文件系统与 Shell 永不离开宿主；手机只持有设备凭证与 UI 状态。

| | |
|---|---|
| **版本** | Agent `0.1.0` · Protocol `v: 1` |
| **仓库** | https://github.com/ibi6/mobile-claude |
| **形态** | Monorepo（pnpm）· Node Agent + Expo RN Client |
| **成熟度** | MVP-B（工作流增强版）· 私有部署优先 |

---

## 目录

1. [设计哲学与问题域](#1-设计哲学与问题域)
2. [系统架构](#2-系统架构)
3. [威胁模型与信任边界](#3-威胁模型与信任边界)
4. [组件与仓库布局](#4-组件与仓库布局)
5. [运行时不变量与容量参数](#5-运行时不变量与容量参数)
6. [部署拓扑](#6-部署拓扑)
7. [快速路径（最小可用）](#7-快速路径最小可用)
8. [Agent 运维手册](#8-agent-运维手册)
9. [客户端接入](#9-客户端接入)
10. [鉴权状态机](#10-鉴权状态机)
11. [Agent 循环与权限闸门](#11-agent-循环与权限闸门)
12. [工具面契约](#12-工具面契约)
13. [会话、幂等与恢复语义](#13-会话幂等与恢复语义)
14. [配置模型](#14-配置模型)
15. [持久化与备份](#15-持久化与备份)
16. [线协议（Protocol v1）](#16-线协议protocol-v1)
17. [可观测性与排障](#17-可观测性与排障)
18. [开发者工作流](#18-开发者工作流)
19. [已知局限与演进](#19-已知局限与演进)
20. [安全基线清单](#20-安全基线清单)

---

## 1. 设计哲学与问题域

### 1.1 为什么不是「手机上的 Claude Code」

Claude Code 类产品的价值密度集中在：

- 对**真实仓库**的读写与搜索  
- 受控 Shell  
- 多轮 tool-use 循环  
- 人机共治的权限点  

手机计算与沙箱无法等价承载上述能力；强行本地化只会得到「聊天机器人 + 玩具文件系统」。

因此本项目采用 **Remote Console** 范式：

| 平面 | 驻留位置 | 职责 |
|---|---|---|
| **Execution plane** | 主机 Agent | LLM 调用、工具执行、沙箱、持久化、审计 |
| **Control plane** | 手机 App | 呈现、决策、导航、轻量缓存 |

### 1.2 与替代方案的比较

| 方案 | 优点 | 结构性缺陷 |
|---|---|---|
| SSH + 原版 TUI | 能力完整 | 移动端交互差；难做结构化审批 / Diff 产品体验 |
| 包装官方 `claude` PTY | 复用现成能力 | 输出半结构化；协议脆弱；升级即碎 |
| 纯手机沙箱 Agent | 部署简单 | 无法服务真实工程仓库 |
| **本项目（自建 Daemon + 结构化协议）** | 可治理、可测、可演进 UI | 需自运维；能力为 Claude Code **子集** |

### 1.3 产品边界（MVP-B）

**在范围内：** 配对鉴权、多会话、流式对话、六工具、权限（一次/会话）、Diff、文件树、`/model` `/clear`、断线权限重投、输出截断、Bash env 消毒、全局并发上限。

**明确不在范围内：** 官方 remote-control/bridge 兼容、MCP 市场、多 Agent Swarm、完整 slash/skills/hooks 生态、应用商店发布流水线、内置 TLS 终结。

---

## 2. 系统架构

### 2.1 逻辑视图

```
                    ┌─────────────────────────────────────┐
                    │           Control Plane             │
                    │  Expo RN · SecureStore · Nav/UI     │
                    │  AgentClient (WS, backoff, id-corr) │
                    └──────────────────┬──────────────────┘
                                       │  WebSocket / JSON
                                       │  Envelope v=1
                    ┌──────────────────▼──────────────────┐
                    │          Execution Plane            │
                    │  ┌──────────┐  ┌─────────────────┐  │
                    │  │  Auth    │  │  SessionStore   │  │
                    │  │  Device  │  │  SQLite/sql.js  │  │
                    │  └────┬─────┘  └────────┬────────┘  │
                    │       │                 │           │
                    │  ┌────▼─────────────────▼────────┐  │
                    │  │     WS Router + Runtime       │  │
                    │  │  busy · abort · idem · fanout │  │
                    │  └────┬─────────────────┬────────┘  │
                    │       │                 │           │
                    │  ┌────▼─────┐    ┌──────▼───────┐   │
                    │  │ Agent    │    │ Permission   │   │
                    │  │ Loop     │◄──►│ Gate + Audit │   │
                    │  └────┬─────┘    └──────────────┘   │
                    │       │                             │
                    │  ┌────▼──────────────────────────┐  │
                    │  │ Tool Runtime (sandboxed)      │  │
                    │  │ Read Write Edit Glob Grep Bash│  │
                    │  └────┬──────────────────────────┘  │
                    └───────┼─────────────────────────────┘
                            │
              ┌─────────────┼──────────────┐
              ▼             ▼              ▼
        Anthropic API   Workspace FS    Host Shell
        (host key)      (realpath)      (scrubbed env)
```

### 2.2 关键数据路径

**Happy path（一次写文件任务）：**

```
chat.send
  → append user message
  → Anthropic stream (tools enabled)
  → tool_use Write
  → resolvePermission → ask
  → permission.request  ──► 手机 Sheet
  → permission.respond allow_once
  → runTool(Write) + diff.available
  → tool_result → 继续 stream
  → message.completed / status idle
```

**Abort path：**

```
chat.abort
  → AbortController.abort()          # 先打断 signal
  → pending permission → deny        # 再释放等待
  → loop raceAbort / deny 语义
  → finally: busy↓ · global gen↓ · status idle
```

### 2.3 模块边界规则

| 规则 | 说明 |
|---|---|
| Mobile ↛ Agent | 客户端不得 import `packages/agent` |
| 共享契约唯一 | 仅通过 `@mobile-claude/protocol` |
| Key never on wire | `config.set` 显式拒绝 apiKey 走私字段 |
| 请求-响应关联 | 服务端响应 envelope **回填请求 `id`**；客户端优先按 id 关联 |

---

## 3. 威胁模型与信任边界

### 3.1 资产

| 资产 | 敏感级 | 驻留 |
|---|---|---|
| `ANTHROPIC_API_KEY` | 极高 | 仅宿主 env / 本地配置 |
| `deviceToken` | 高 | 手机 SecureStore；服务端 **仅 hash** |
| 仓库源码 / 密钥文件 | 高 | workspace（工具可见范围） |
| 会话 transcript | 中高 | DB + 上行 Anthropic |
| 配对短码 | 中 | 短 TTL、一次性 |

### 3.2 攻击面与缓解

| 威胁 | 缓解（已实现） | 残余风险 |
|---|---|---|
| 未鉴权调用工具 | 握手前 reject | 无 |
| Token 库泄露 | 存 sha256，不存明文 | 离线撞库（高熵 token 降低） |
| 路径穿越 | realpath + workspace 边界 | TOCTOU / 奇异 reparse point |
| Bash 读出 API Key | `buildShellEnv` 白名单 + SECRET 剥离 | 用户批准的恶意命令仍可伤本机 |
| 输出炸弹 / OOM | 采集期 cap、截断、超时杀树 | 极端 IO 仍占磁盘 |
| 公网暴露 7820 | 默认 `127.0.0.1`；文档强约束 | 用户误配 `0.0.0.0` + 端口映射 |
| 并发耗尽配额 | 会话 busy + 全局 gen≤2 | 无公平队列 |
| 上游错误信息泄露 | 客户端统一安全文案 | 服务端日志仍含细节 |

### 3.3 明确非隔离声明

**Workspace 沙箱 ≠ 容器 / VM / seccomp。**  
约束对象是：工具路径参数、Bash `cwd`、以及（部分）搜索根。  
一旦用户 **允许** 一条 `Bash`，命令在宿主用户权限下执行——治理靠**人机审批**，不是内核强制。

---

## 4. 组件与仓库布局

```
mobile-claude/
├── apps/mobile/                 # Expo RN 控制面
├── packages/
│   ├── protocol/                # Envelope · Zod · 消息目录
│   └── agent/                   # Daemon · CLI · tools · loop
├── docs/superpowers/
│   ├── specs/                   # 产品设计规格
│   └── plans/                   # 实现计划
├── package.json                 # pnpm workspace root
└── README.md
```

| 包 | 技术选型 | 备注 |
|---|---|---|
| `@mobile-claude/protocol` | TypeScript · Zod · Vitest | 纯契约，无 I/O |
| `@mobile-claude/agent` | Node 20 · `ws` · sql.js · Anthropic SDK | Windows 优先；PowerShell 默认 shell |
| `mobile-claude` (app) | Expo 57 · RN · SecureStore · React Navigation | 中文 UI · 紫靛 SaaS 视觉 |

---

## 5. 运行时不变量与容量参数

| 参数 | 值 | 语义 |
|---|---|---|
| Protocol | `v = 1` | 破坏性变更必须升版本 |
| `MAX_FRAME_BYTES` | 2 MiB | 单帧上限 |
| `PERMISSION_TIMEOUT_MS` | 5 min | 权限等待超时 → deny |
| `CHAT_IDEM_TTL_MS` | 5 min | `chat.send` envelope id 幂等窗 |
| `MAX_GLOBAL_GENERATIONS` | 2 | 进程内并行 generation 上限 |
| `DEFAULT_MAX_ROUNDS` | 25 | 单次 user turn 最大 tool 轮次 |
| `BASH_TIMEOUT_MS` | 60 s | Shell 超时 |
| `MAX_TOOL_OUTPUT_CHARS` | 200_000 | 工具输出采集/回传上限 |
| `MAX_READ_BYTES` | 1_000_000 | 单文件读上限（工具侧） |
| Pairing TTL | 600_000 ms | 配对码默认 10 分钟 |
| Server version | `0.1.0` | `auth.ok` 下发 |

---

## 6. 部署拓扑

### 6.1 本机开发（最低权限）

```
[Expo Go / Simulator] ──WS──► 127.0.0.1:7820 ──► Anthropic
                                 │
                            workspace on disk
```

- Android Emulator → 宿主：`10.0.2.2:7820`  
- iOS Simulator → `127.0.0.1:7820`

### 6.2 局域网真机

```
Phone ──Wi‑Fi──► Host LAN IP:7820 (--host 0.0.0.0)
```

配合系统防火墙 **Private profile only**。

### 6.3 外出（推荐）

```
Phone ──Tailscale/WireGuard──► Home lab node:7820
                                      │
                               ANTHROPIC_API_KEY
                               private workspace
```

**反模式：** 路由器 DMZ / 无鉴权 TLS 的公网 7820。当前协议无传输层加密，依赖网络平面私有性。

### 6.4 进阶：TLS 终结（可选，自建）

若必须跨不可信网络，在 Agent 前挂反向代理（Caddy/Nginx）做 TLS + 访问控制，上游仍指向 `127.0.0.1:7820`。App 侧需改为 `wss://`（当前开发默认 `ws://`，改造属后续工作）。

---

## 7. 快速路径（最小可用）

```bash
# 0) 依赖
pnpm install && pnpm build

# 1) Agent（PowerShell 示例）
$env:ANTHROPIC_API_KEY = "sk-ant-..."
pnpm --filter @mobile-claude/agent start -- `
  --workspace "D:\code\my-project" `
  --port 7820 `
  --host 0.0.0.0

# 2) 记下终端 6 位配对码

# 3) Mobile
pnpm --filter mobile-claude start
# Expo Go 扫码 → 填 主机/端口/配对码/设备名
```

验证任务建议：

> 「在工作区创建 `mobile-claude-smoke.txt`，内容为 ok，然后用 Read 读回。」

期望：Write 触发权限 → 允许一次 → Diff 可见 → 文件页可见。

---

## 8. Agent 运维手册

### 8.1 启动

```bash
pnpm --filter @mobile-claude/agent start -- [options]
# 或
node packages/agent/dist/cli.js start -- [options]
```

| Flag | Default | 说明 |
|---|---|---|
| `--workspace` | cwd / config | 沙箱根；所有工具边界锚点 |
| `--port` | `7820` | 监听端口；`0` 可系统分配 |
| `--host` | `127.0.0.1` | 绑定地址 |
| `--data-dir` | `~/.mobile-claude` | DB 与状态根 |

### 8.2 环境变量

| Variable | 作用 |
|---|---|
| `ANTHROPIC_API_KEY` | 上游鉴权（必填于生产对话路径） |
| `HOST` `PORT` `WORKSPACE_ROOT` `DATA_DIR` | 覆盖绑定与路径 |
| `DEFAULT_MODEL` | 默认模型 ID |
| `AUTO_ALLOW_READ_TOOLS` | 只读工具是否免确认 |
| `SHELL` | `powershell` \| `bash` \| `cmd` |
| `PAIRING_CODE_TTL_MS` | 配对码 TTL |

**合并优先级：** CLI > Env > `config.json` > 内置默认。

### 8.3 进程生命周期

- 单进程、有状态（内存：pending permissions、runtime busy、idem map）  
- 优雅退出：中止 in-flight abort controllers、deny pending、关闭 WSS、flush DB  
- 崩溃恢复：会话落盘；**进行中的 turn 不保证续跑**（需客户端重新 `chat.send`）

### 8.4 Windows 注意

- 默认 shell：PowerShell（`-NoProfile -NonInteractive -Command`）  
- Bash 超时杀树：`taskkill /PID /T /F`  
- 持久化：sql.js + 临时文件 rename（规避非原子 truncate）  
- 路径：盘符与 junction 场景依赖 `realpath` 语义  

---

## 9. 客户端接入

### 9.1 启动

```bash
pnpm --filter mobile-claude start
pnpm --filter mobile-claude android
pnpm --filter mobile-claude ios
```

### 9.2 配对表单

| 字段 | 语义 |
|---|---|
| Host | 见部署拓扑 |
| Port | 与 Agent 一致 |
| Pairing code | 一次性短码 |
| Device name | 审计/展示用标签 |

### 9.3 客户端运行时行为

| 能力 | 实现要点 |
|---|---|
| 连接 | `ws://host:port` |
| 重连 | 指数退避；恢复后 `auth.hello` |
| 请求关联 | 优先 `env.id === requestId`；auth 类保留窄 type fallback |
| 会话恢复 | 认证成功 / 聚焦 Chat → `session.open` |
| 权限 UI | 非 dismissible sheet；决策 → `permission.respond` |
| 敏感存储 | SecureStore：`deviceToken` + endpoint |

### 9.4 用户命令面

| 输入 | 通道 | 效果 |
|---|---|---|
| 自然语言 | `chat.send` | 触发 agent loop |
| `/clear` | `slash.run` | 清空 transcript |
| `/model` | `slash.run` | 查询当前 model（status） |
| `/model <id>` | `slash.run` | 设置会话 model |
| 停止 | `chat.abort` | 中止 turn + deny pending |

---

## 10. 鉴权状态机

```
                ┌──────────────┐
                │ Unauthenticated │
                └───────┬────────┘
           pair OK      │      hello OK
         ┌──────────────┼──────────────┐
         ▼                             ▼
   device enrolled               session resumed
   token issued once             pending perms redelivered
         │                             │
         └──────────► Authenticated ◄──┘
                          │
                    any business RPC
```

| 消息 | 前置 | 后置 |
|---|---|---|
| `auth.pair` | 有效 pairing code | `deviceToken` 明文一次；DB hash；`auth.ok` |
| `auth.hello` | 有效 token | `auth.ok`；**重投全部 pending permission** |
| 其他 type | 必须已认证 | 否则 `unauthorized` + 可关连接 |

---

## 11. Agent 循环与权限闸门

### 11.1 Loop 算法（简化）

```
append user message
for round in 1..MAX_ROUNDS:
  stream Anthropic(messages, tools)
  on text delta → message.delta
  on tool_uses:
    for each tool_use:
      pattern = patternForTool(...)
      if resolvePermission == allow: execute
      else:
        await permission (raced with AbortSignal)
        deny → synthetic tool error
        allow_session → persist rule then execute
        allow_once → execute
      emit tool.* / diff.*
      append tool_result
  if stop without tool_use: break
persist assistant · status idle
```

### 11.2 权限决策表

| 工具类 | 默认 | 风险展示 |
|---|---|---|
| Read / Glob / Grep | auto-allow（可关） | low |
| Write / Edit | ask | medium |
| Bash | ask | high |

**规则匹配（v1）：** 精确 `tool + pattern`（文件路径或完整 command 字符串），无 glob 规则、无 always-bypass UI。

### 11.3 Audit

权限路径写入 `audit_log`（auto_allow / session_rule / allow_once / allow_session / deny），供事后追责与调试。

---

## 12. 工具面契约

| Tool | Input schema（要点） | 失败语义 |
|---|---|---|
| `Read` | `path`, `offset?`, `limit?` | 越界 / 超限 throw |
| `Write` | `path`, `content` | 越界 throw；产出 diff |
| `Edit` | `path`, `old_string`, `new_string` | 无匹配 throw；单次替换 |
| `Glob` | `pattern` | 受限遍历 |
| `Grep` | `pattern`, `path?`, `glob?` | rg 超时回退；丢弃区外行 |
| `Bash` | `command`, `cwd?` | 非 0 退出不 throw，stdout 标注 exit |

**Bash 执行策略：**

- 禁止 `shell: true` 字符串拼接  
- 命令作为单一 argv（`-Command` / `-c` / `/c`）  
- env = `buildShellEnv()`  
- 输出双通道 cap + 超时杀进程树  

---

## 13. 会话、幂等与恢复语义

### 13.1 会话模型

- Session：标题、model、时间戳  
- Messages：有序 `content_json`  
- Tool runs：与 message 关联的执行记录  
- Permission rules：会话级 allowlist  

### 13.2 幂等

`chat.send` 在**校验通过并接受执行后**记录 `envelope.id`，5 分钟内重复 id **静默忽略**（防弱网重试双跑）。  
校验失败（如 session 不存在）**不**占用幂等槽，允许修正后重试。

### 13.3 恢复矩阵

| 事件 | 消息 | Pending 权限 | 工具时间线 UI | In-flight stream |
|---|---|---|---|---|
| App 冷启动 + open | ✅ snapshot | ✅ 重投 | ⚠️ 可能不完整 | ❌ |
| WS 重连 + hello | 需再 open | ✅ 全量重投 | ⚠️ | ❌ |
| `chat.abort` | 保留已落盘 | deny 释放 | 已推送的保留 | 中止 |

---

## 14. 配置模型

### 14.1 `~/.mobile-claude/config.json` 示例

```json
{
  "host": "127.0.0.1",
  "port": 7820,
  "workspaceRoot": "D:\\code\\my-app",
  "defaultModel": "claude-sonnet-4-20250514",
  "shell": "powershell",
  "autoAllowReadTools": true,
  "pairingCodeTtlMs": 600000
}
```

### 14.2 远程可写配置（`config.set`）

允许：`model?` · `autoAllowReadTools?`（`.strict()`）  
拒绝：任何 `apiKey` / `ANTHROPIC_API_KEY` / 同类走私键 → `forbidden`

---

## 15. 持久化与备份

| 存储 | 路径 | 内容 |
|---|---|---|
| 主库 | `$DATA_DIR/data.db` | devices · sessions · messages · tool_runs · rules · audit |
| 手机 | SecureStore | endpoint + deviceToken |

**备份：** 停写窗口复制整个 `$DATA_DIR`。  
**轮换设备信任：** 删除 devices 相关数据或重置 data-dir 后重新 pair（会丢失登记设备；会话数据是否保留取决于你是否只清 devices 表——当前无一等公民 CLI，建议整目录备份后操作）。

**引擎：** sql.js（WASM）为主路径（Windows 友好）；写路径为 export → temp → rename。

---

## 16. 线协议（Protocol v1）

### 16.1 Envelope

```ts
type Envelope<T = unknown> = {
  v: 1
  id: string
  type: string
  ts: number           // unix ms
  sessionId?: string
  payload: T
}
```

### 16.2 错误

```ts
type ErrorPayload = {
  code:
    | 'unauthorized' | 'forbidden' | 'not_found' | 'validation'
    | 'busy' | 'aborted' | 'upstream' | 'tool_failed' | 'internal'
  message: string      // UI-safe
  details?: unknown    // 不得含密钥
  replyTo?: string
}
```

### 16.3 消息目录（摘要）

**Client → Server：**  
`auth.pair` · `auth.hello` · `session.{list,create,open,delete}` · `chat.{send,abort}` · `permission.respond` · `slash.run` · `fs.{list,read}` · `config.{get,set}`

**Server → Client：**  
`auth.{ok,pair_result}` · `session.{list_result,snapshot}` · `message.{delta,completed}` · `tool.{started,progress,completed}` · `permission.request` · `diff.available` · `status` · `error` · `fs.{list_result,read_result}` · `config`

实现源码：`packages/protocol`。  
产品规格：`docs/superpowers/specs/2026-07-23-mobile-claude-code-design.md`。

---

## 17. 可观测性与排障

### 17.1 信号

| 信号 | 来源 |
|---|---|
| 终端 `[server] agent loop error:` | 上游/循环异常（细节在宿主） |
| `status.phase` | 客户端 chip |
| `error.code` | 结构化失败 |
| `audit_log` | 权限决策轨迹 |
| `truncated: true` | 输出被裁剪 |

### 17.2 诊断树

```
连不上
 ├─ host/port 是否与 bind 一致？
 ├─ 127.0.0.1 vs 0.0.0.0 vs 10.0.2.2？
 ├─ 防火墙 / 隔离网络？
 └─ 代理污染（系统/Git 7897 失效等）？

配对失败
 ├─ 码过期/已用？
 ├─ daemon 是否重启导致新码？
 └─ 时钟严重偏移？（TTL 基于宿主 now）

对话失败
 ├─ ANTHROPIC_API_KEY 是否在同一 shell？
 ├─ model id 是否有效？
 └─ 是否 busy / 全局 gen 打满？

工具失败
 ├─ PathEscape？
 ├─ 权限 deny？
 └─ Bash 超时 / 输出截断？
```

### 17.3 网络与 Git 代理提示

若本机依赖 HTTP 代理访问 GitHub/外网，确保代理端口存活（例如 `http://127.0.0.1:10808`）。失效的 `7897` 会导致 `git push` / 依赖下载失败，与 Agent 本身无关。

---

## 18. 开发者工作流

```bash
pnpm install
pnpm test          # protocol + agent
pnpm typecheck
pnpm build

pnpm --filter @mobile-claude/agent test
pnpm --filter @mobile-claude/agent start -- --workspace . --port 7820
pnpm --filter mobile-claude start
```

**质量门禁建议：**

- 沙箱与权限变更必须带单测  
- 协议字段变更同步 Zod + 客户端关联逻辑  
- 禁止提交 `.env`、token、`.superpowers/` 本地草稿  

设计与计划文档：

- `docs/superpowers/specs/2026-07-23-mobile-claude-code-design.md`  
- `docs/superpowers/plans/2026-07-23-mobile-claude-code.md`  

---

## 19. 已知局限与演进

| 领域 | 现状 | 可能演进 |
|---|---|---|
| 传输安全 | 明文 WS | `wss` + 反向代理；可选 mTLS |
| 设备生命周期 | 无一等 `pair-reset` | CLI 吊销 / 设备列表 |
| Snapshot 保真 | 消息为主 | tool_runs + diff 进入 snapshot |
| 心跳 | 依赖 TCP/重连 | 应用层 ping/pong |
| 模型治理 | 弱 allowlist | 强制目录 + 策略包 |
| 隔离强度 | 用户级沙箱 | 可选 container backend |
| 生态 | 无 MCP | 选择性 MCP bridge |

---

## 20. 安全基线清单

运维前自检：

- [ ] `ANTHROPIC_API_KEY` 仅在宿主，不在手机、不在仓库、不在截图  
- [ ] 默认或生产绑定策略已理解（`127.0.0.1` vs Tailscale）  
- [ ] **无**公网裸映射 7820  
- [ ] workspace 指向正确仓库（避免指到 `$HOME`）  
- [ ] 审批 Bash/Write 前阅读参数  
- [ ] 定期备份 `$DATA_DIR`  
- [ ] 设备丢失后轮换信任（清 token / 重 pair）  
- [ ] 合规：对话与代码片段会进入模型供应商处理边界  

---

## License

Private / WIP.

**Repository:** https://github.com/ibi6/mobile-claude  
**Inspired by** Claude Code interaction patterns — **reimplemented cleanly**, not a source dump port.
