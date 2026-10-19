# AnywhereCoding

在手机或电脑浏览器里，查看并继续本机 AI 编程会话。

支持 **Codex、Claude Code / Claude.app、PI-Desktop 和原生 Pi CLI**。一个 Node.js 服务提供网页、API 和 SSE 实时事件；模型请求仍由本机原生客户端发出，AnywhereCoding 不直接调用模型 API，也不替换客户端的 API 地址、凭据或系统提示词。

当前初始版本：**v0.1.0**。

## 功能

- 手动添加本机连接，默认没有连接；检测不可用时显示具体原因，支持重新检测、重新连接和移除。
- 枚举原生历史，按真实项目目录分组、搜索和继续对话。
- 项目旁的 `＋` 直接进入该项目的新会话页面，不再询问项目目录。
- 全局新会话支持目录浏览、新建子文件夹并自动选中。
- 实时回复、思考内容、停止、工具审批和交互提问。
- 模型、思考程度及客户端支持的权限模式设置。
- 工具完成状态、命令退出码和耗时、文件修改 `+新增 −删除`；文件编辑隐藏耗时。
- 原生图片内容、工具图片结果和 Markdown 图片预览。
- 原生错误详情、重试提示、失败工具自动展开；发送失败保留草稿。
- 手机布局、运行/待审批图标，以及浏览器标题中的活动数量。
- 电脑端侧栏可拖动调宽（双击分隔线恢复默认，拖到最左收起，☰ 恢复），宽度保存在浏览器中。
- macOS 状态栏图标：显示运行/待审批数量，点选进行中的会话直接打开网页。

## 快速开始

需要 **Node.js >=24**、**pnpm 10**，以及至少一个已安装并完成本机配置的原生客户端。

```sh
git clone https://github.com/chilin11/anywherecoding.git
cd anywherecoding
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

默认监听 `http://0.0.0.0:8787`。需要其他端口时：

```sh
ANYWHERE_PORT=8788 pnpm start
```

首次启动会在 `~/.anywherecoding/config.json` 生成登录令牌和 Cookie 签名密钥。查看令牌：

```sh
node scripts/service.mjs token
```

打开网页并登录，然后选择 **连接的 IDE → ＋ 添加**。添加成功后，原生会话会出现在项目列表中；检测不会发送模型提示词。连接选择保存在 `~/.anywherecoding/connections.json`，服务重启后恢复。

## 原生客户端连接

| 连接 | 历史和继续方式 | 交互边界 |
| --- | --- | --- |
| Codex | 本机 `codex app-server`，通过官方协议枚举和恢复同一线程 | 使用独立 app-server；已打开的 GUI 标签可能需要重开刷新 |
| Claude Code | `~/.claude/projects` 原生 JSONL，读取 Claude.app 标题；通过 `claude --resume` 和 stream-json 继续 | 使用原生 CLI 后台进程；Claude.app 已打开的标签可能需要重开刷新 |
| PI-Desktop | 正在运行的桌面 MCP 控制接口，轮询当前查看的会话 | 桌面执行和持久化，网页与桌面操作同一会话 |
| Pi CLI | `~/.pi/agent/sessions` 原生 JSONL 树；通过 `pi --mode rpc --session <file>` 恢复 | 独立于 PI-Desktop；使用原生 Pi 的模型、工具和扩展 |

Codex、Claude Code 和 Pi CLI 是通过原生后台协议进程操作，不能完整接管已经打开的终端/IDE 标签。避免网页与其他客户端同时写同一会话；后台服务继承的环境变量也可能与交互终端不同。网页主动选择模型、思考或权限时，才将对应设置传给客户端。

### PI-Desktop

需要兼容的 PI-Desktop MCP 控制接口。macOS 可在正常退出并重开桌面应用前设置：

```sh
launchctl setenv PI_DESKTOP_MCP_CONTROL 1
```

控制信息默认读取 `~/.pi-desktop/mcp-control.json`。网页审批/提问需要桌面版本开放 `agent/pendingInteractive`；未开放的版本会提示限制。PI-Desktop 不可用时，可独立添加 Pi CLI。

PI-Desktop 约每 1.5 秒轮询当前查看的会话，并定期检查最近更新的 30 个会话的运行状态。审批仅在查看会话后查询，未观察的状态显示未知。上下文用量取最近主会话模型请求的 input + output + cache read + cache write，未知不显示为 0。

### 原生 Pi CLI

当前按 Pi 1.2 的 RPC 协议适配；缺少所需命令的版本会在检测时显示失败。支持当前分支历史、同文件恢复、流式消息、停止和扩展 `confirm/select/input/editor` 交互。

Pi 内置工具直接执行，没有通用的逐次工具审批模式。网页显示这一行为，不提供虚构的权限选项。自定义终端 UI 无法直接渲染在网页中。RPC 只提供当前模型支持的思考等级，其他模型在切换后重新查询；当前上下文 token 数不可得时显示未知。

## 配置

配置文件默认位于 `~/.anywherecoding/config.json`，权限为 `600`。修改时保留已生成的 `token` 和 `cookieSecret`。

可调整的配置示例（合并到现有配置）：

```json
{
  "host": "127.0.0.1",
  "port": 8788,
  "roots": ["/path/to/projects"],
  "claudeHiddenCwds": ["magpie-claude-work"]
}
```

- `roots`：可浏览、创建文件夹和新建会话的目录边界，使用 realpath 校验符号链接；已有会话按原生历史列出。
- `codexBin`、`claudeBin`、`piBin`：可选的 CLI 可执行文件路径；默认自动查找。Codex 也支持 macOS ChatGPT.app 内的 CLI。
- `piDesktopDataDir`：PI-Desktop 控制文件所在目录。
- `piAgentDir`：原生 Pi 的配置目录，默认使用 `PI_CODING_AGENT_DIR` 或 `~/.pi/agent`；`PI_CODING_AGENT_SESSION_DIR` 可指定其会话根目录。
- `claudeHiddenCwds`：隐藏工作目录包含指定字符串的 Claude 会话。

环境变量 `ANYWHERE_HOME` 可切换 AnywhereCoding 配置目录；`ANYWHERE_HOST` / `ANYWHERE_PORT` 覆盖监听设置。

## macOS 登录自启

先完成安装和构建，再执行：

```sh
node scripts/service.mjs install
node scripts/service.mjs status
node scripts/service.mjs restart
```

安装当前项目为 LaunchAgent `io.github.chilin11.anywherecoding`，日志保存在 `~/.anywherecoding/logs/`。停止并取消自启：

```sh
node scripts/service.mjs uninstall
```

卸载保留配置和原生会话。服务重启会停止它拥有的 Codex、Claude Code 和 Pi CLI 进程，请在任务完成后操作。移除 PI-Desktop 连接只断开网页控制，不停止桌面任务。

macOS 后台 Node 访问 Downloads 等受保护目录需要单独授权；终端能读取不代表 LaunchAgent 已获授权。系统提示访问文件夹时选择允许，或在“隐私与安全性 → 文件与文件夹”中启用。图片读取超时会显示不可用，其他网页请求继续响应。

## macOS 状态栏图标

需要 Xcode Command Line Tools（`swiftc`）。构建、ad-hoc 签名并安装到 `~/Applications/AnywhereCodingBar.app`，同时设为登录自启：

```sh
node scripts/menubar.mjs install
node scripts/menubar.mjs status
node scripts/menubar.mjs uninstall   # 移除应用和自启，服务与配置不受影响
```

图标每 3 秒读取一次 `GET /api/status`（使用 `~/.anywherecoding/config.json` 中的令牌，令牌不会写入应用包）：

- `</>`：服务正常、无活动；`◎ N`：N 个会话运行中；橙色 `✋ N!`：N 个会话待审批；灰色闪电：服务未连接或令牌无效。
- 菜单列出进行中的会话（点选打开对应网页会话），以及连接状态、错误、打开网页、复制登录令牌、重启服务。

`/api/status` 需要登录 Cookie 或 `Authorization: Bearer <token>`，返回运行/待审批计数、最多 20 个活动会话、连接可用性和读取错误。

## 远程访问

可通过已有 HTTPS 反向代理或 Cloudflare Tunnel 访问，例如：

```sh
cloudflared tunnel --url http://127.0.0.1:8787
```

目标端口应与服务实际端口一致。保留浏览器原始 Host，不要覆盖成 localhost，否则 Origin 校验会拒绝写入请求。

网页使用令牌登录、HttpOnly / SameSite Cookie 和 Origin 校验；HTTPS 代理场景使用 Secure Cookie。SSE 每 20 秒保活。令牌不要放进 URL，也不要提交配置、凭据或会话文件。

## 图片与错误记录

本地图片经登录鉴权和 HMAC 签名接口读取，限制在配置根目录或系统临时目录，校验常见栅格格式和大小。支持 PNG、JPEG、GIF、WebP、AVIF、原生 base64 图片及远程图片链接。文件已删除或没有访问权限时会提示不可用。网页暂不提供附件上传。

模型失败、进程退出和重试提示显示在聊天错误卡片中，失败工具自动展开。原生历史中的错误按原生记录保留；中继补充错误仅存服务内存（每会话最多 30 条、最多 200 个会话），页面刷新/重连可恢复，服务重启后清空。显示错误不会改变原生客户端的请求或重试方式。

## 开发与验证

```sh
pnpm test
pnpm typecheck
pnpm build
```

开发前端使用 `pnpm dev:web`，开发服务使用 `pnpm dev`；Vite 默认代理到本机 8787。

自动化测试覆盖连接管理、四种适配器的协议/配置、原生 Pi JSONL 分支和进程生命周期、工具终态与行数、图片目录边界、错误详情和审批恢复。大部分测试使用隔离协议夹具，不调用模型；安装了本机 Pi 的 macOS 环境额外执行不发送提示词的 RPC 探针。

本地集成验证覆盖过 Codex/Claude/PI-Desktop 的收发、审批和停止，以及 390px/1280px 浏览器交互；原生 Pi 的真实探针覆盖检测、文件恢复和配置，模型流式执行使用协议夹具验证。不同原生客户端版本可能存在协议差异。

## 致谢

本项目独立实现，参考 magpie 的原生会话索引思路和 hapi 的协议与移动交互设计，未复制 hapi 的 AGPL 源码。
