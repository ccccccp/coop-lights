# 协作点灯 · KOOK Co-op Lights

React + TypeScript + Node.js 的 1～4 人协作点灯游戏，使用 PostgreSQL 保存玩家、登录会话和通关记录。

本独立项目同步维护旁边 `../kook-minigame-sdk/examples/coop-lights` 的游戏实现，SDK 运行库使用 npmjs 已发布包。

SDK 固定使用 npmjs 已发布的 `0.1.0-alpha.2`，采用 `createKookClient` 具名导入。

已接入 KOOK 小游戏 SDK，支持登录授权、邀请、平台数据调试、连接恢复与授权撤销。当前可用本地模拟宿主完成自测；真实 KOOK 环境需要补齐应用配置并联调。配置和接入边界见 [SDK 接入说明](docs/sdk-integration.md)。

## KOOK 账号与头像

KOOK 模式下，SDK 连接就绪且具备基本资料权限后，页面自动发起一次 OAuth 授权；无需输入昵称。取消或失败时保留手动重试入口，主动退出登录后不会立即再次弹出授权。独立模式继续使用手动昵称。

用户名和头像由游戏后端从 OAuth 用户资料读取。头像保存到 PostgreSQL 并随房间快照同步，自己和其他已授权玩家均显示 KOOK 用户名与头像；资料更新后重新授权会同步现有房间。头像缺失或加载失败时显示昵称首字。

升级现有数据库时执行 pnpm db:migrate，幂等增加 avatar_url 列，保留用户标识和累计成绩。

## 本地准备

需要 Node.js 22.18+、pnpm 10.26.0、本机 PostgreSQL 17（也可选用 Docker Desktop）、本机 Chrome。模拟宿主生成 HTTPS 证书还需要 OpenSSL，Windows 默认使用 Git for Windows 自带的版本，也可设置 `OPENSSL_BIN`。

游戏保留独立 pnpm workspace 和锁文件，SDK 运行库从 npmjs 安装。浏览器目标和模拟宿主开发工具仍复用旁边 `../kook-minigame-sdk/scripts` 中的脚本。首次安装时，在本项目根目录执行：

```powershell
pnpm install --frozen-lockfile
$env:PG_BIN = 'D:/Program Files/PostgreSQL/17/bin'
pnpm db:setup
```

`PG_BIN` 请改成本机 PostgreSQL 的实际安装目录。`db:setup` 启动本项目原生 PostgreSQL，凭证和数据保存在忽略提交的 `.local/`、`.postgres/`；已有配置会继续复用。需要 Docker 时可改用 `pnpm db:docker`。

`db:docker` 创建名为 `coop-lights-sdk-postgres` 的独立 PostgreSQL 17 容器，端口为 `127.0.0.1:55432`，使用 `coop-lights-sdk-pgdata` 数据卷。随机凭证保存到忽略提交的 `.local/database.json`。重复执行会启动原容器并执行幂等迁移，停止使用 `pnpm db:docker:stop`，保留数据。

本机已有的 `.env`、数据库配置和证书沿用当前项目设置。勿提交本地数据库凭证、`.env` 或证书。

已有数据库时，在 `.env` 配置专用 `DATABASE_URL` 并执行 `pnpm db:migrate`。原生 PostgreSQL 的 `db:setup` / `db:stop` 入口也保留；请先配置实际 `PG_BIN` 路径，勿与 Docker 初始化方式混用。

## 原生 HTTPS 联调

在游戏根目录 `.env` 配置 `WEB_HTTPS=true`、`GAME_TLS_CERT` 和 `GAME_TLS_KEY`，执行 `pnpm dev` 即可使用 `https://localhost:5178/`。Vite 同源代理 `/api` 与 `/ws` 到游戏后端；默认 `SERVER_HTTPS=false`，后端仅监听 loopback HTTP。

构建后需要后端直接提供 HTTPS 时，将 `WEB_HTTPS=false`、`SERVER_HTTPS=true`，然后运行 `pnpm build`、`pnpm start`。证书路径可以是绝对路径或相对游戏根目录的路径。HTTPS 上游代理使用配置证书进行校验，不关闭 TLS 校验。

Cookie 受限时，游戏沿用现有登录协议，以随机 nonce 绑定登录事务，并使用仅驻留内存的游戏 Bearer 会话。KOOK 应用凭证、OAuth token 和数据库身份映射保持现有实现。真实 Web／PC 的打开—游玩—关闭验收由使用方执行，步骤见 [手动验证清单](docs/web-pc-verification.md)。

## SDK 自测

```powershell
$env:VITE_KOOK_HOST_ORIGINS = 'https://localhost:5190'
pnpm dev:sdk
```

打开 <https://localhost:5190/>。此命令先构建游戏，再启动跨来源 iframe 宿主、游戏后端和本地 OAuth 服务，不需要真实 KOOK 凭证。默认使用本地数据库保存自测记录。

首次手动访问时，需要分别访问 <https://localhost:5190/> 和 <https://127.0.0.1:5190/> 接受本地自签证书，再回到宿主页。证书只存放在 `.sdk-test/`，脚本不更改系统证书信任。

1. 宿主页选择「玩家阿青」，在游戏里点击「使用 KOOK 登录」，创建房间。
2. 用另一浏览器或无痕窗口打开 `https://localhost:5190/?player=bob&room=房间号`，点击登录和加入。
3. 双方准备，由房主开始点灯；每次点击翻转本格及上下左右相邻格，全部点亮即通关。
4. 宿主工具栏可模拟取消授权、撤销授权、断线恢复、参与者变化和实例关闭。
5. 游戏里的「开发与平台调试面板」可追加权限，读取好友、频道成员、参与者和官方服务器信息。

页面明确标注模拟宿主、模拟账号和模拟数据。SDK 使用真实构建产物，授权码经游戏后端交换；本地模拟成功不代表真实平台验收完成。

SDK 运行库由本项目的 npm 依赖版本和锁文件确定；更新依赖后重新构建游戏。`pnpm dev:sdk` 使用当前安装的 npm 包。

## 独立游戏模式

默认 `APP_MODE=standalone`：

```powershell
pnpm dev
```

打开 <http://localhost:5178/>。输入昵称后即可创建或加入房间，邀请按钮复制游戏链接。后端默认 <http://127.0.0.1:5188/api/health>。

同一浏览器的普通标签页共享会话，新连接会接替旧连接；双人测试请使用独立浏览器上下文。异常断线保留席位 60 秒，主动退出立即释放。游戏房间保存在服务端内存，服务重启后房间消失，已保存记录仍在 PostgreSQL。

构建后可用 `pnpm start` 在 5188 同时提供页面、API 和 WebSocket。

## 验证

```powershell
pnpm check
pnpm test:e2e
pnpm test:sdk
```

- `check`：类型检查、服务端协议与 OAuth 测试、生产构建。
- `test:e2e`：独立模式的双人协作、刷新恢复、结算和退出。
- `test:sdk`：真实 SDK + 模拟宿主，覆盖启动消息重投、无 OAuth 加载、授权、权限、分页、邀请、双人通关、恢复、撤销及关闭后停止探测。
- HTTPS 和 Cookie 兼容回归：`pnpm check` 覆盖原生 HTTPS 监听及 nonce／Bearer 绑定，`pnpm test:sdk` 额外在请求／响应均无 Cookie 的条件下验证授权、游玩和注销；不替代真实 KOOK Web／PC 验收。
- 单元测试使用 `lights_test_*` 临时 schema；SDK 浏览器测试使用 `lights_sdk_*` 临时 schema，并在正常退出时清理。强制终止进程可能留下测试 schema。
- 独立模式浏览器测试使用游戏数据库的默认 schema，产生自测账号与通关记录。截图及失败追踪在 `test-results/`；SDK 截图及失败追踪在 `.sdk-test/results/`。

`docs/platform-contract.md`、`docs/development-status.md`、`docs/test-scenarios.md` 和 `DEVELOPMENT_PLAN.md` 保留 2026-10-12 之前的归档快照；本次 SDK 接入以本 README 和 [SDK 接入说明](docs/sdk-integration.md) 为准。

## KOOK 实例邀请

房间内点击“邀请好友”会调用 npm SDK 的 `ui.openInviteModal({ roomId })`，由 KOOK 的原生邀请弹框选人发送，游戏只显示成功／失败人数。宿主需支持 `ui.openInviteModal`；没有该能力时按钮禁用。

受邀者从 KOOK 接受邀请、启动同一平台实例并完成 OAuth 登录后，游戏后端使用 OAuth token 查询 `/api/v3/mini-game/context`，核对游戏与实例，并读取 `data.room_id`。前端只按这份已核验结果自动加入邀请房间，每次启动仅尝试一次。房间满员或已结束时提示并显示游戏主页；主动离房后不会自动再次加入。房间容量仍由游戏后端串行检查。

KOOK 后端须部署 `POST /api/v3/mini-game/invite-send`，并在受邀用户的 context 响应中返回 `room_id`。宿主仍可通过 connected 的邀请字段提供 SDK 展示上下文，点灯自动入房使用游戏后端直接查询的 context 结果。文字／语音来源仍须具备创建频道邀请权限，不能降级到私信。平台实例满员可能在游戏启动前由 KOOK 拦截；游戏房间满员由本项目显示主页。真实 Web、PC、多账号投递仍需联调。

当前游戏后端已将 context 确认的 `instance_id` 绑定到游戏会话，建房和加入均使用该绑定，拒绝跨实例加入。`ready.instanceId` 只作为查询选择器；游戏编号使用后端 `KOOK_GAME_CODE`（点灯默认为 `751wtNQveFXjlVoZ`）。context 默认与 `KOOK_USERINFO_URL` 同源，也可设置 `KOOK_CONTEXT_URL`。`data.room_id` 为空时显示主页，不回退使用 SDK、URL 或浏览器提交的房间号；接口失败或实例不匹配时不建立登录会话。KOOK 授权必须包含 `mini_game.context`，OAuth token 始终留在后端。
