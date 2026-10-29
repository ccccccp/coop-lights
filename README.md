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

普通打开只进行 OAuth 换码和用户资料读取，不请求 context，也不要求 mini_game.context 权限作为基本登录前置。登录结果成功后立即保留用户身份和主页。

受邀启动（SDK launchSource=invite）登录成功后，另行调用游戏后端 POST /api/kook/invite/resolve。后端使用仅驻留内存的 OAuth token 查询 KOOK /api/v3/mini-game/context，按 data.instance 核对游戏／实例和 data.invite.status，并读取 data.room。只有 invite.status=joined_by_invite 且 room.room_source=invite 时，才按 room.room_id 自动加入点灯房间；room_source=instance 时 room_id 是平台实例回退值，不用于游戏入房。实例／频道／私信编号和旧平铺房间字段均不替代正式游戏房间号。查询失败提示原因并保留登录与主页；房间满员或已结束时同样回主页。主动离房不会重复自动入房。

KOOK 后端须部署 POST /api/v3/mini-game/invite-send 和 context 接口，邀请核验需要 mini_game.context 授权；上下文格式错误只影响接受邀请。普通房间继续使用游戏身份和六位房间号，平台实例 ID 不再是基本登录或游玩的必经校验；服务器内存中保存核验成功的邀请目标，不以浏览器 roomId 自报作为邀请依据。重启后接受邀请可能需要重新授权，已有基本登录不受影响。

## 接口调用日志

访问 /log（例如 https://cp-coop-lights.vanillacake.cn/log），或点击游戏右上角“调用日志”。部署前执行 pnpm db:migrate，在服务端环境变量配置 LOG_ACCESS_KEY，重启游戏服务后用同一访问密钥查询。密钥仅在日志页面内存驻留，不写入 URL、浏览器存储或日志。

默认查询最近 3 天（72 小时），按调用开始时间倒序，最新在前。可按时间范围、KOOK／游戏接口、失败记录以及接口／请求编号筛选，并加载更早记录。详情包含方法、接口地址、入参、返回、HTTP 状态码、业务码、耗时、错误和请求关联编号。KOOK 换码、用户信息、context 请求均记录在游戏后端；失败登录也能通过日志查询，不要求先登录游戏。

日志在 PostgreSQL 的 lights_call_logs 表持久化，默认保留 7 天，可通过 LOG_RETENTION_DAYS 设置（3～90天）。日志查询本身和健康检查不写调用记录。记录入库前屏蔽授权码、state、nonce、OAuth token、Cookie、游戏会话与应用密钥，保留定位问题所需的字段结构；超长字符串／数组／深层对象有大小限制。日志写入失败不使游戏请求报错。

配置示例：

```dotenv
LOG_ACCESS_KEY=请设置独立的随机访问密钥
LOG_RETENTION_DAYS=7
```
