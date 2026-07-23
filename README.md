# Mobile Claude Code

**手机远程控制台 + 自托管编程 Agent**

在常开电脑 / VPS 上运行 Agent 守护进程（真正读写项目、执行命令、调用 Claude API），用手机 App 作为**控制台**：流式对话、工具时间线、权限审批、Diff 预览、文件浏览、会话恢复。

> 这不是把桌面 Claude Code 的终端 UI 原样搬到手机，也不是在手机沙箱里「假写代码」。  
> 核心模型是：**执行在远端，决策与观察在手机**。

---

## 目录

1. [它解决什么问题](#1-它解决什么问题)
2. [系统架构](#2-系统架构)
3. [仓库结构](#3-仓库结构)
4. [前置条件](#4-前置条件)
5. [安装与构建](#5-安装与构建)
6. [启动 Agent 守护进程（电脑端）](#6-启动-agent-守护进程电脑端)
7. [启动手机客户端](#7-启动手机客户端)
8. [网络与连接方式（进阶）](#8-网络与连接方式进阶)
9. [配对与鉴权机制](#9-配对与鉴权机制)
10. [日常使用详解](#10-日常使用详解)
11. [权限与安全模型](#11-权限与安全模型)
12. [工具能力说明](#12-工具能力说明)
13. [配置参考](#13-配置参考)
14. [数据持久化](#14-数据持久化)
15. [协议概要（开发者）](#15-协议概要开发者)
16. [开发、测试与脚本](#16-开发测试与脚本)
17. [故障排查](#17-故障排查)
18. [限制与路线图](#18-限制与路线图)
19. [安全声明](#19-安全声明)

---

## 1. 它解决什么问题

| 场景 | 传统做法 | Mobile Claude Code |
|---|---|---|
| 出门后想继续让 Agent 改代码 | SSH 进电脑敲终端，手机上难用 | 手机 App 对话 + 点选审批 |
| 需要确认「写文件 / 跑命令」 | 终端里看不清、易误触 | 权限卡片：拒绝 / 一次 / 本会话 |
| 查看改动 | `git diff` 在 SSH 里滚屏 | 手机 Diff 视图 |
| 密钥与执行环境 | 手机上放 Key、权限失控 | **API Key 只在电脑**；工具在 workspace 沙箱内 |

**适合：** 有一台常开开发机、希望手机「遥控」编程 Agent。  
**不适合：** 完全没有远端机器、指望手机本地独立完成完整工程构建。

---

## 2. 系统架构

```
┌──────────────────────┐         WebSocket JSON (v:1)        ┌────────────────────────────┐
│  apps/mobile         │  ◄────────────────────────────────► │  packages/agent            │
│  Expo / React Native │   鉴权 · 会话 · 流式消息 · 权限     │  Node.js 守护进程          │
│                      │   工具事件 · Diff · 文件浏览         │                            │
│  · 配对 / 会话列表   │                                     │  · Anthropic Messages API  │
│  · 聊天 + 工具卡片   │                                     │  · 工具循环 + 权限闸门     │
│  · 权限 Sheet        │                                     │  · Read/Write/Edit/…/Bash  │
│  · Diff / 文件 / 设置│                                     │  · 路径沙箱 + 输出截断     │
└──────────────────────┘                                     │  · SQLite 会话与设备       │
                                                             └─────────────┬──────────────┘
                                                                           │
                                                    ANTHROPIC_API_KEY（仅宿主）
                                                    workspace 文件系统 / Shell
```

**信任边界：**

- 手机 **永远不** 持有长期 API Key，也 **不** 本地执行写文件 / Bash。
- 所有危险操作必须经权限闸门（或已有会话规则）后，才在电脑上执行。
- 协议层拒绝通过 WebSocket 下发 `apiKey` 等字段。

---

## 3. 仓库结构

| 路径 | 包名 | 职责 |
|---|---|---|
| `packages/protocol` | `@mobile-claude/protocol` | 信封格式、Zod schema、消息类型（手机与 Agent 共用） |
| `packages/agent` | `@mobile-claude/agent` | 守护进程：WS 服务、鉴权、会话、工具、模型循环、CLI |
| `apps/mobile` | `mobile-claude` | Expo 客户端 UI |
| `docs/superpowers/specs/` | — | 产品设计规格 |
| `docs/superpowers/plans/` | — | 实现计划 |

Monorepo 使用 **pnpm workspaces**。手机端只依赖 `protocol`，**不**直接 import agent 代码。

---

## 4. 前置条件

### 电脑（Agent 宿主）

| 项 | 要求 |
|---|---|
| OS | Windows 10/11（一等公民）、macOS、Linux |
| Node.js | **20+** |
| 包管理 | **pnpm 9+**（仓库 `packageManager`: `pnpm@9.15.0`） |
| API | 有效的 **Anthropic API Key** |
| 网络 | 能访问 Anthropic API；手机需能访问本机 Agent 端口 |

### 手机

| 项 | 要求 |
|---|---|
| 客户端 | **Expo Go**（开发期）或后续自建开发包 |
| 网络 | 与电脑同一局域网，或 **Tailscale / WireGuard** 等私有网 |
| 系统 | iOS / Android（Expo SDK 57） |

### 不需要

- 不需要 Docker（本机 Docker 不可用也可开发）
- 不需要在手机上安装 Node / 编译环境

---

## 5. 安装与构建

```bash
# 进入仓库根目录
cd mobile-claude   # 或你的本地路径

pnpm install

# 构建 protocol + agent（CLI 依赖 dist）
pnpm build
# 等价于：
# pnpm --filter @mobile-claude/protocol build
# pnpm --filter @mobile-claude/agent build
```

确认：

```bash
pnpm test        # 当前约 90+ 自动化测试
pnpm typecheck
```

---

## 6. 启动 Agent 守护进程（电脑端）

### 6.1 最小命令

**Windows PowerShell：**

```powershell
$env:ANTHROPIC_API_KEY = "sk-ant-你的密钥"

pnpm --filter @mobile-claude/agent start -- `
  --workspace "D:\path\to\your\project" `
  --port 7820 `
  --host 127.0.0.1
```

**macOS / Linux：**

```bash
export ANTHROPIC_API_KEY=sk-ant-你的密钥

pnpm --filter @mobile-claude/agent start -- \
  --workspace /path/to/your/project \
  --port 7820 \
  --host 127.0.0.1
```

构建后也可直接：

```bash
node packages/agent/dist/cli.js start --workspace . --port 7820
# 或（若 bin 已链上）
# mobile-claude-agent start --workspace . --port 7820
```

### 6.2 CLI 参数

| 参数 | 默认 | 说明 |
|---|---|---|
| `--workspace <path>` | 当前目录或配置文件 | **沙箱根目录**。所有文件工具与 Bash `cwd` 必须落在此树内 |
| `--port <n>` | `7820` | WebSocket 监听端口 |
| `--host <addr>` | `127.0.0.1` | 绑定地址。仅本机用默认；手机连局域网需 `0.0.0.0` 或具体网卡 IP |
| `--data-dir <path>` | `~/.mobile-claude`（Windows: `%USERPROFILE%\.mobile-claude`） | 数据库与本地状态 |
| `-h, --help` | — | 帮助 |

### 6.3 启动成功后你会看到什么

终端会打印类似信息：

- 监听地址与端口  
- **6 位配对码（pairing code）**  
- 工作区路径  

请**立刻抄下配对码**。默认约 **10 分钟**有效，且 **一次性**（用过后作废）。超时或失败请重启 daemon 拿新码。

### 6.4 环境变量（与 CLI 叠加）

| 变量 | 作用 |
|---|---|
| `ANTHROPIC_API_KEY` | **必需**（真实对话）。只放宿主环境，禁止经 WS 下发 |
| `HOST` / `PORT` | 覆盖绑定 |
| `WORKSPACE_ROOT` | 默认工作区 |
| `DATA_DIR` | 数据目录 |
| `DEFAULT_MODEL` | 默认模型 ID（见配置节） |
| `AUTO_ALLOW_READ_TOOLS` | 是否自动允许 Read/Glob/Grep |
| `SHELL` | `powershell` \| `bash` \| `cmd` |
| `PAIRING_CODE_TTL_MS` | 配对码有效期（毫秒） |

优先级（由高到低）：**CLI 参数 > 环境变量 > 配置文件 > 内置默认**。

---

## 7. 启动手机客户端

另开终端（保持 Agent 进程不关）：

```bash
pnpm --filter mobile-claude start
```

然后：

1. 手机安装 **Expo Go**  
2. 扫描终端二维码  
3. 或：

```bash
pnpm --filter mobile-claude android   # Android 模拟器 / 设备
pnpm --filter mobile-claude ios       # 需 macOS + Xcode
```

### 配对页字段

| 字段 | 填什么 |
|---|---|
| 主机 | 见 [§8](#8-网络与连接方式进阶) |
| 端口 | 与 daemon 一致，默认 `7820` |
| 配对码 | 电脑终端打印的 6 位码 |
| 设备名 | 任意标识，如 `Pixel-7` / `我的 iPhone` |

成功后：

- 手机 **SecureStore** 保存 `host` / `port` / `deviceToken`  
- 之后启动自动 `auth.hello` 重连，无需重复配对  

---

## 8. 网络与连接方式（进阶）

### 8.1 场景对照表

| 场景 | `--host` | 手机「主机」填 | 备注 |
|---|---|---|---|
| 仅本机、iOS 模拟器 | `127.0.0.1` | `127.0.0.1` | 最安全 |
| Android 模拟器访问本机 daemon | `127.0.0.1` | **`10.0.2.2`** | 模拟器访问宿主回环的标准地址 |
| 真机 + 同一 Wi‑Fi | `0.0.0.0` 或局域网 IP | 电脑的局域网 IP（如 `192.168.1.8`） | 需防火墙放行端口 |
| 真机 + 外出 | 建议 **Tailscale** IP | 电脑的 Tailscale IP（如 `100.x.y.z`） | **推荐** 远程方案 |
| 公网端口映射 | **强烈不推荐** | — | 无 TLS、易被扫端口爆破配对 |

### 8.2 查看电脑局域网 IP

```powershell
# Windows
ipconfig
# 看「无线局域网」或「以太网」的 IPv4
```

```bash
# macOS / Linux
ip addr   # 或 ifconfig / ipconfig getifaddr en0
```

### 8.3 Windows 防火墙

首次允许 Node 入站，或手动放行 TCP `7820`（仅专用网络）：

```powershell
# 示例：放行 7820（按需调整）
New-NetFirewallRule -DisplayName "Mobile Claude Agent" -Direction Inbound -Protocol TCP -LocalPort 7820 -Action Allow -Profile Private
```

### 8.4 为什么默认是 127.0.0.1？

默认最小暴露面：未改 host 时，局域网设备 **连不上** 是正常的。  
要用手机真机，必须**主动**放宽绑定，并接受局域网内的攻击面（见安全节）。

### 8.5 推荐远程拓扑（外出）

```
手机 ──Tailscale──► 家中电脑:7820 (daemon --host 0.0.0.0 或 tailscale0)
                         │
                         ▼
                   Anthropic API
```

不要用「路由器裸映射 7820 到公网」代替 VPN。

---

## 9. 配对与鉴权机制

```
首次：
  手机 auth.pair(code, deviceName)
    → 服务端校验短码未过期
    → 生成 deviceToken（只回传一次明文）
    → 服务端仅存 sha256(token)
    → 返回 auth.pair_result + auth.ok

之后：
  手机 auth.hello(deviceToken)
    → 校验 hash
    → auth.ok（含 workspaceRoot、serverVersion）
    → 若有等待中的权限请求，会重投 permission.request
```

| 概念 | 说明 |
|---|---|
| 配对码 | 短码、TTL、一次性；仅用于「登记设备」 |
| deviceToken | 长期设备凭证；手机 SecureStore；服务端只存哈希 |
| 未鉴权连接 | 除 `auth.pair` / `auth.hello` 外一律 `unauthorized` |

**设备丢失时：** 当前 CLI 尚无 `pair-reset` 一键命令；可删除 data-dir 中设备表/整库后重启，或清空 `~/.mobile-claude` 后重新配对（会丢本地会话元数据，请先备份）。

---

## 10. 日常使用详解

### 10.1 推荐操作顺序

1. 电脑启动 daemon（Key + workspace）  
2. 手机配对（首次）  
3. **会话** → 新建或打开历史  
4. 输入自然语言任务（例如：「给 README 加一节安装说明，并跑一下类型检查」）  
5. 出现权限弹窗时阅读工具名、参数摘要、风险级别  
6. Write/Edit 完成后点工具卡片 **查看 Diff**  
7. 需要中断时点 **停止**（`chat.abort`）  

### 10.2 聊天界面元素

| UI | 含义 |
|---|---|
| 用户 / 助手气泡 | 对话内容；助手支持流式增量 |
| 工具卡片 | `tool.started` / `tool.completed` 时间线 |
| 状态 chip | `idle` / `thinking` / `tool` / `awaiting_permission` |
| 停止按钮 | 中止当前回合；等待权限时也会按 deny 解除阻塞 |
| 权限 Sheet | 拒绝 / 允许一次 / 本会话允许（遮罩不可点穿取消） |

### 10.3 Slash 命令

在输入框发送（会走 `slash.run`，不是普通 chat）：

| 命令 | 行为 |
|---|---|
| `/clear` | 清空当前会话消息（会话 id 保留） |
| `/model` | 查询当前模型（返回 status） |
| `/model <model-id>` | 设置**该会话**模型 |

示例：

```text
/model claude-sonnet-4-20250514
```

具体可用模型 ID 以你的 Anthropic 账号与官方文档为准；错误 ID 会导致上游请求失败。

### 10.4 文件页

- 从 workspace 根目录列出目录项  
- 进入子目录、返回上级  
- 打开文本文件预览；二进制会提示「二进制文件」  
- 所有路径服务端做 **workspace 沙箱** 校验  

### 10.5 设置页

- 连接状态、主机、工作区路径、默认模型  
- **自动允许只读工具**：关闭后 Read/Glob/Grep 也要确认  
- **断开配对**：清除 SecureStore，回到配对页  

### 10.6 会话恢复（杀 App / 断线）

| 状态 | 行为 |
|---|---|
| 消息历史 | `session.open` → `session.snapshot` 恢复 |
| 等待中的权限 | 重连 / open / hello 后服务端 **重投** `permission.request` |
| 进行中的流式输出 | 断线后需依赖重连；建议用「停止」后再发 |
| 工具卡片 / Diff 缓存 | 当前 MVP：**未必**完整进入 snapshot（文本消息会在） |

### 10.7 并发限制

- **同一会话**同时只能有一轮 generation（再发会 `busy`）  
- **全局**最多 **2** 路 concurrent generation（多会话并行时）  

---

## 11. 权限与安全模型

### 11.1 默认策略

| 工具 | 默认 |
|---|---|
| `Read` / `Glob` / `Grep` | **自动允许**（可配置关闭；写 audit） |
| `Write` / `Edit` | **每次确认** |
| `Bash` | **每次确认**（v1 无「看起来只读就自动」启发式） |

### 11.2 用户决策

| 选项 | 效果 |
|---|---|
| 拒绝 | 向模型返回 permission denied，回合可继续 |
| 允许一次 | 仅本轮该 tool_use |
| 本会话允许 | 写入 session 规则：`tool + 精确 pattern`（路径或完整命令字符串） |

### 11.3 路径沙箱

- 所有用户路径经 `realpath` / 祖先解析  
- 必须落在 `workspaceRoot` 下，否则 `PathEscapeError`  
- 注意：沙箱约束的是 **路径参数与 Bash cwd**，**不是**完整 OS 隔离。  
  用户批准的 Bash 仍可能用命令读工作区外路径——**审批时务必读命令**。

### 11.4 Bash 环境消毒

子进程 **不会** 继承完整 `process.env`：

- 仅白名单变量（PATH、HOME、SystemRoot…）  
- 剥离匹配 `SECRET|TOKEN|PASSWORD|API_KEY|CREDENTIAL` 等键  
- 明确去除 `ANTHROPIC_API_KEY`  

防止「允许一条 Bash 就把 API Key echo 回会话」。

### 11.5 输出与帧限制

- 工具输出默认上限约 **200_000** 字符，超出会截断并标记 `truncated`  
- Bash / rg 有超时（默认 60s）与进程树杀死（Windows `taskkill /T`）  
- 读文件有大小上限，避免整库塞进内存  

---

## 12. 工具能力说明

| 工具 | 输入要点 | 副作用 | 手机表现 |
|---|---|---|---|
| **Read** | `path`, 可选 `offset`/`limit` | 无 | 通常自动执行 |
| **Write** | `path`, `content` | 创建/覆盖 | 权限 + Diff |
| **Edit** | `path`, `old_string`, `new_string` | 首次匹配替换 | 权限 + Diff |
| **Glob** | `pattern` | 无 | 通常自动 |
| **Grep** | `pattern`, 可选 `path`/`glob` | 无 | 优先 ripgrep，否则 TS 回退 |
| **Bash** | `command`, 可选 `cwd` | 任意 shell 能力 | **始终确认**；Windows 默认 PowerShell |

Agent 系统提示倾向于：能用专用文件工具就不要用 Bash 改文件。

---

## 13. 配置参考

### 13.1 配置文件

路径：`~/.mobile-claude/config.json`（或 `DATA_DIR/config.json`）

示例：

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

### 13.2 内置默认（摘要）

| 项 | 默认 |
|---|---|
| host | `127.0.0.1` |
| port | `7820` |
| defaultModel | `claude-sonnet-4-20250514` |
| shell | Windows → `powershell`；其它 → `bash` |
| autoAllowReadTools | `true` |
| pairingCodeTtlMs | `600000`（10 分钟） |

### 13.3 手机侧可改配置

经 `config.set`（**不能**设 API Key）：

- `model`（影响默认/展示侧，会话级 `/model` 另算）  
- `autoAllowReadTools`  

---

## 14. 数据持久化

| 数据 | 位置 |
|---|---|
| SQLite / sql.js 库 | `DATA_DIR/data.db`（默认 `~/.mobile-claude/data.db`） |
| 设备 token 哈希、会话、消息、tool_runs、权限规则、audit | 同上 |
| 手机连接信息 | Expo SecureStore |

**Windows 说明：** 若 `better-sqlite3` 原生编译失败，自动使用 **sql.js**（WASM）+ 原子写盘（临时文件 rename）。语义一致，极端崩溃窗口见实现注释。

**备份建议：** 定期复制整个 `DATA_DIR`；升级前备份 `data.db`。

---

## 15. 协议概要（开发者）

- 传输：WebSocket 文本帧，JSON  
- 信封：

```ts
{
  v: 1,
  id: string,        // 请求/事件 id；响应应回填请求 id 以便客户端关联
  type: string,
  ts: number,
  sessionId?: string,
  payload: unknown
}
```

| 方向 | 类型（部分） |
|---|---|
| C→S | `auth.pair`, `auth.hello`, `session.list/create/open/delete`, `chat.send`, `chat.abort`, `permission.respond`, `slash.run`, `fs.list`, `fs.read`, `config.get`, `config.set` |
| S→C | `auth.ok`, `auth.pair_result`, `session.*`, `message.delta`, `message.completed`, `tool.*`, `permission.request`, `diff.available`, `status`, `error`, `fs.*_result`, `config` |

共享实现：`packages/protocol`。  
设计全文：`docs/superpowers/specs/2026-07-23-mobile-claude-code-design.md`。

---

## 16. 开发、测试与脚本

```bash
pnpm install
pnpm test          # protocol + agent 单测 / 集成测
pnpm typecheck
pnpm build

# 单包
pnpm --filter @mobile-claude/agent test
pnpm --filter @mobile-claude/agent start -- --workspace . --port 7820
pnpm --filter mobile-claude start
```

**贡献约定简述：**

- 协议变更必须升 `v` 或保持向后兼容  
- 危险路径变更需带沙箱测试  
- 不要把 API Key、配对 token、`.superpowers/` 本地草稿提交进库  

---

## 17. 故障排查

| 现象 | 可能原因 | 处理 |
|---|---|---|
| 手机连不上 | host 仍是 127.0.0.1；防火墙；IP 填错；不在同一网 | `--host 0.0.0.0`；查 IP；放行端口；用 Tailscale |
| Android 模拟器连不上 | 填了 127.0.0.1 | 改填 **`10.0.2.2`** |
| 配对码无效 | 过期、已使用、daemon 已重启换码 | 看终端新码；10 分钟内完成 |
| `ANTHROPIC_API_KEY is not configured` | 启动 shell 未 export/set | 在**同一终端会话**设置后重启 daemon |
| 一直 busy | 上一轮未结束；全局 2 路占满 | 点停止；等其它会话结束 |
| 权限弹窗不消失 / 卡住 | 旧版 abort 问题 | 更新到含 abort+deny 的版本；点停止 |
| 工具失败 Path escapes | 路径越出 workspace | 检查 `--workspace`；勿用 `../` 逃逸 |
| Bash 找不到命令 | PATH 消毒后环境较瘦 | 用完整路径或保证系统 PATH 在白名单内仍可用 |
| Expo 扫码失败 | 手机与电脑不在同网；代理干扰 | 同 Wi‑Fi；tunnel 模式；关错误系统代理 |
| `git push` 失败 443 | 本机 HTTP 代理端口不对 | 将 git `http.proxy` 指到可用代理端口（如 10808） |

**日志：** Agent 在终端打印 `[server] agent loop error:` 等；手机错误以协议 `error.message` 展示（上游细节默认不回传，避免泄露）。

---

## 18. 限制与路线图

### 当前 MVP 已有

- 配对与设备 token  
- 多会话 + 流式对话  
- 六大工具 + 权限 + Diff  
- 文件浏览、设置、`/model` `/clear`  
- 重连重投 pending 权限  
- chat.send 幂等、输出截断、Bash env 消毒、全局并发 2  

### 明确非目标 / 未做（v1）

- 官方 Claude.ai bridge 协议兼容  
- MCP / 插件市场 / Skills 商店  
- 多 Agent Swarm / 完整 Plan Mode 产品面  
- 全量 slash 与桌面 Claude Code 1:1  
- 应用商店上架流水线  
- 内置 TLS（请用 VPN 或反向代理自行终结 TLS）  

### 可能后续

- CLI `pair-reset` / `status`  
- snapshot 携带完整 tool 时间线与 diff  
- WebSocket 应用层心跳  
- 模型 allowlist 强制校验  

---

## 19. 安全声明

1. **不要**将 Agent 端口无防护暴露在公网。  
2. API Key **仅**存在于宿主环境变量或宿主本地配置，**禁止**写入手机或协议。  
3. 审批 Bash / Write 前请阅读参数；本会话允许会放宽后续同类精确 pattern。  
4. Workspace 沙箱 ≠ 虚拟机；恶意或误批准的命令仍可能影响本机（在批准范围内）。  
5. 在公司网络使用时，遵守数据与代码外发政策（对话内容会发往 Anthropic API）。  

---

## License

Private / WIP.  
仓库：https://github.com/ibi6/mobile-claude
