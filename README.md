# Mobile Claude Code

手机端远程控制台 + 自托管 Agent 守护进程。在常开电脑上跑 Claude 编程代理，用手机配对、对话、审批工具与 diff。

## 仓库结构

| 包 | 说明 |
|---|---|
| `@mobile-claude/protocol` | 共享 WebSocket 信封、Zod schema、消息类型 |
| `@mobile-claude/agent` | Agent 守护进程（Node.js WebSocket 服务 + CLI） |
| `apps/mobile`（`mobile-claude`） | Expo React Native 客户端 |

---

## 快速开始

### 1. 前置条件

- **Node.js 20+**
- **pnpm 9+**（仓库锁定 `pnpm@9.15.0`）
- **Anthropic API Key**，仅配置在**宿主机**环境变量中（`ANTHROPIC_API_KEY`），**永远不要**通过 WebSocket / 手机端发送

### 2. 安装依赖

在仓库根目录：

```bash
pnpm install
```

建议先构建协议与 agent（或直接 `pnpm build`）：

```bash
pnpm --filter @mobile-claude/protocol build
pnpm --filter @mobile-claude/agent build
```

### 3. 启动 Agent 守护进程

将 `ANTHROPIC_API_KEY` 设到宿主机环境，指定工作区路径：

```bash
# Windows PowerShell
$env:ANTHROPIC_API_KEY = "sk-ant-..."

# macOS / Linux
export ANTHROPIC_API_KEY=sk-ant-...

pnpm --filter @mobile-claude/agent start -- --workspace <你的项目路径>
```

常用可选参数：

```bash
pnpm --filter @mobile-claude/agent start -- --workspace <路径> --port 7820 --host 127.0.0.1
```

| 参数 | 默认 | 含义 |
|---|---|---|
| `--workspace` | 当前目录 / 配置文件 | 沙箱项目根目录（工具读写边界） |
| `--port` | `7820` | 监听端口 |
| `--host` | `127.0.0.1` | 绑定地址（默认仅本机） |
| `--data-dir` | `~/.mobile-claude` | SQLite 与状态目录 |

也可在构建后使用：

```bash
# mobile-claude-agent start --workspace /path/to/project --port 7820
# node packages/agent/dist/cli.js start --workspace . --port 7820
```

### 4. 记下配对码（pairing code）

守护进程启动后会在终端打印 **6 位配对码**（默认约 10 分钟内有效、一次性使用）。

在手机 App 的「配对」页填入：

- 主机地址（见下方网络说明）
- 端口（默认 `7820`）
- 配对码
- 设备名称

配对成功后，App 会安全保存 `deviceToken`，之后重连走 `auth.hello`，无需再次输入配对码。

### 5. 启动 Expo 客户端

```bash
pnpm --filter mobile-claude start
```

按终端提示用 Expo Go 扫码，或启动模拟器：

```bash
pnpm --filter mobile-claude android
# 或
pnpm --filter mobile-claude ios
```

### 6. 手机与电脑如何连上

- **真机**：手机与电脑同一局域网，或使用 **Tailscale / 私有 VPN** 访问电脑的内网 IP。
- 若 daemon 默认绑定 `127.0.0.1`，真机无法直连。需要在**可信局域网或 VPN 内**将 `--host` 改为本机局域网 IP（例如 `0.0.0.0` 或 `192.168.x.x`），并做好安全防护（见下节）。
- **Android 模拟器**访问宿主机上的 daemon：主机地址填 **`10.0.2.2`**（对应宿主的 `127.0.0.1`），端口与 daemon 一致（如 `7820`）。
- **iOS 模拟器**一般可用 `127.0.0.1` 或 `localhost` 访问宿主。

### 7. 安全警告（必读）

- **不要把守护进程端口裸奔到公网**（不要做无鉴权的端口映射 / 公网 `--host 0.0.0.0`）。
- 默认绑定 **`127.0.0.1`**，仅本机可连；跨设备请优先 **Tailscale / WireGuard** 等私有网络。
- API Key 只存在于宿主进程环境；协议 **拒绝** 通过 `config.set` 等方式下发密钥。
- 配对码短时、一次性；设备 token 保存在手机安全存储中。
- Bash 等工具在工作区内仍有破坏力——审批前看清命令与 diff。

---

## 日常使用流程（概要）

1. 电脑上启动 daemon（带 `ANTHROPIC_API_KEY` + `--workspace`）。
2. 手机配对一次，之后自动 `auth.hello` 重连。
3. 创建 / 打开会话 → 发消息 → 流式回复。
4. 高风险工具（写文件、Bash 等）弹出权限表；可「允许一次 / 本会话允许 / 拒绝」。
5. Write / Edit 后可查看 diff。
6. **文件**页浏览工作区；**设置**页切换「自动允许只读工具」、断开配对。
7. 聊天中支持 `/model <name>`、`/clear`。
8. App 杀后台再打开：会 `session.open` 恢复消息；若权限请求仍在等待，服务端会在 **`session.open` / 重新 `auth.hello`** 时重投 `permission.request`。

---

## 开发脚本

```bash
pnpm install
pnpm test        # 全仓测试
pnpm typecheck   # 全仓类型检查
pnpm build       # 构建全部包
```

---

## 配置文件（可选）

`~/.mobile-claude/config.json`（或 `DATA_DIR` 下），可由环境变量覆盖，例如：

`HOST`、`PORT`、`WORKSPACE_ROOT`、`DATA_DIR`、`DEFAULT_MODEL`、`AUTO_ALLOW_READ_TOOLS` 等。  
详见 `@mobile-claude/agent` 的 `loadConfig`。

### 持久化说明

会话与设备信息存在 SQLite（默认 `~/.mobile-claude/data.db`）。Windows 上若 `better-sqlite3` 无法编译，守护进程使用 **sql.js**（WASM）落盘，对外 API 一致。

---

## 协议

线协议版本 `v: 1`。共享类型在 `packages/protocol`。

主要消息类型包括：`auth.pair` / `auth.hello`、`session.*`、`chat.send` / `chat.abort`、`permission.request` / `permission.respond`、`tool.*`、`diff.available`、`fs.list` / `fs.read`、`config.get` / `config.set`、`slash.run` 等。

---

## License

Private / WIP.
