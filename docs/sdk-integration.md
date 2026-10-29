# SDK 接入说明

更新：2026-10-26。游戏已接收 KOOK 宿主启动消息；打开、加载、续期和退出已通过生产宿主代码与实际游戏页面的受控验证。真实测试环境尚受登录风控阻塞，未完成真实后端验收。

## 前端启动与登录

`apps/web/src/platform.ts` 使用 npm 已发布版本 `0.1.0-alpha.2` 的具名导出 `createKookClient`。游戏根据 `/api/health` 返回的模式选择独立或 KOOK 适配器。KOOK 模式接收启动参数后调用 `ready()`，欢迎页可用后报告加载完成；SDK 就绪且基本资料权限可用后自动发起一次登录授权，取消后由用户手动重试。

在游戏根目录 `.env` 配置前端宿主白名单，然后重新构建游戏：

```dotenv
VITE_KOOK_HOST_ORIGINS=https://tttt-www.dev.chuanyuapp.com,https://localhost:3000
```

仅填写实际需要的 HTTPS origin，多个来源用逗号分隔；本地开发结束后移除 localhost。Vite 从游戏根目录加载该配置，不读取 URL 参数或 referrer 作为信任来源。

游戏等待父窗口的消息：

```ts
{
  type: 'KOOK_MINI_GAME_BOOTSTRAP',
  bootstrap: { hostOrigin, sessionId, generation }
}
```

同时校验父窗口、配置白名单以及 `bootstrap.hostOrigin === event.origin`。监听建立后向白名单宿主发送 `KOOK_MINI_GAME_BOOTSTRAP_REQUEST`，避免初始化晚于 iframe load 而漏掉参数。每页只接受一组绑定，成功、取消或超时后移除监听；重新打开游戏使用新的 iframe。

无需再注入 `window.startCoopLights()`。宿主尚未开放 `profile.basic` 时，欢迎页仍能完成加载和续期，登录按钮禁用并说明原因；这不建立游戏账号，也不替代 OAuth。联机游玩仍需真实授权服务。宿主关闭游戏后 SDK 停止探测，页面卸载时销毁适配器与订阅；退出是否成功由宿主的 leave 接口决定。

新页面不会仅凭已有游戏 cookie 自动恢复 KOOK 身份。完成本次 OAuth 授权码交换后，后端可恢复相同账号仍在宽限期内的游戏房间。

## 服务端配置

复制 `.env.example` 为 `.env`，根据实际平台应用配置填写：

| 配置                   | 用途                                                                        |
| ---------------------- | --------------------------------------------------------------------------- |
| `APP_MODE=kook`        | 启用 KOOK 模式，关闭昵称登录和开发作弊接口                                  |
| `KOOK_CLIENT_ID`       | OAuth 应用标识，也是游戏账号隔离维度                                        |
| `KOOK_CLIENT_SECRET`   | 仅游戏后端持有的应用密钥                                                    |
| `KOOK_REDIRECT_URI`    | 与平台发放授权码时一致的回调地址                                            |
| `KOOK_TOKEN_URL`       | 实际授权码交换接口                                                          |
| `KOOK_GAME_CODE`       | 游戏对外编号，点灯默认为 `751wtNQveFXjlVoZ`                                 |
| `KOOK_CONTEXT_URL`     | 可选 context 完整 URL，默认与用户信息接口同源的 `/api/v3/mini-game/context` |
| `KOOK_USERINFO_URL`    | 实际用户信息接口                                                            |
| `KOOK_USER_ID_FIELD`   | 明确选择响应中的稳定身份字段：`user_open_code`、`user_code` 或 `id`         |
| `KOOK_USER_NAME_FIELD` | 昵称字段：`username`（默认）或 `nickname`                                   |
| `ALLOWED_GAME_ORIGINS` | 允许请求 API / WebSocket 的游戏页面来源，多个用逗号分隔                     |
| `DATABASE_URL`         | 游戏专用 PostgreSQL；留空时使用本地配置文件                                 |

端点不预填猜测值。当前交换适配器发送 `application/x-www-form-urlencoded` 的 `grant_type=authorization_code`、`client_id`、`client_secret`、`redirect_uri`、`code`，要求 token 响应含 `access_token`、Bearer `token_type`、秒数 `expires_in`；然后用 Bearer token GET 用户信息。支持直接 JSON 对象或 `{ code: 0, data: ... }` 包装。实际平台若采用其他认证方式或响应结构，需要调整 `apps/server/src/platform.ts` 的交换适配器。

生产端点要求 HTTPS；仅允许 loopback HTTP 用于本地模拟。游戏页面需要 HTTPS，保留跨站 iframe 的 `Secure; HttpOnly; SameSite=None; Partitioned` 会话 Cookie，并兼容完全禁用第三方 Cookie 的环境。部署时保持游戏 API 与游戏页面同源，并为 `/ws` 转发 WebSocket Upgrade。`WEB_HTTPS=true` 启用 Vite 原生 HTTPS；`SERVER_HTTPS=true` 启用游戏后端原生 HTTPS，二者使用 `GAME_TLS_CERT/GAME_TLS_KEY`。静态生产构建不读取证书；HTTPS 代理保持证书与主机名校验。

## 授权链路与游戏会话

1. 游戏生成仅驻留内存的随机 `clientNonce`，调用原有 `/api/kook/login/start`；后端签发随机 state，以 nonce 哈希和请求来源绑定本次事务。未传 nonce 的旧调用继续使用 HttpOnly Cookie 绑定。
2. SDK 就绪后自动调用一次 `sdk.session.get({ state, scopes })`；取消作为正常结果返回，页面保留重试入口且不会循环弹出授权。
3. 游戏提交 code、state、clientNonce 到原有 /api/kook/login/complete，instanceId 为兼容的可选字段，不触发实例查询。普通打开仅申请 get_user_info。
4. 后端一次性消费 state，交换 token 并读取用户身份后即创建游戏会话，不调用 context。OAuth token 仅保存在游戏后端内存，游戏前端只持有自己的游戏会话。
5. 游戏继续使用已有的房间 HTTP API、一次性 WebSocket 票据及服务端点灯协议。

`/api/kook/login/complete` 的 OAuth 错误通过 `message` 返回具体原因，并在 `details` 中提供失败阶段 `stage`（`token` 换码、`userinfo` 用户资料或 `context` 实例上下文）、接口 `endpoint`、上游 `http_status`、`upstream_code` 和 `upstream_message`；网络失败提供 `network_code`，响应字段错误提供 `invalid_fields`；context 字段校验失败额外返回固定白名单字段的 `received_types`（只有类型，不回显上游值），用于区分扁平／嵌套结构和类型错误。仅返回对应错误的字段，接口地址不含查询参数，凭证均脱敏。例如：`{"code":"PLATFORM_LOGIN_FAILED","message":"KOOK 换码失败：HTTP 400；invalid_grant；Redirect URI mismatch","details":{"stage":"token","endpoint":"https://kook.example/api/oauth2/token","http_status":400,"upstream_code":"invalid_grant","upstream_message":"Redirect URI mismatch"}}`。

事务有效期为 5 分钟，旧事务、跨浏览器 state、重复使用、伪造身份字段和取消后到达的响应均被拒绝。追加权限会重新验证身份并更新游戏会话，WebSocket 随之重新认证。

`/api/kook/login/cancel` 同样支持 nonce，能够在 Cookie 缺失时取消在途换码或注销它已创建的会话。Bearer 无效时不会退回 Cookie 冒用另一会话；WebSocket 仍只使用原有一次性票据。退出登录、撤销、关闭或登录响应迟到时清理游戏自己的会话；页面刷新后重新由用户授权。数据库中的应用命名空间、身份字段、会话期限和现有三个登录路由均保留。

受邀启动在基本登录成功后，独立调用 /api/kook/invite/resolve 核验 context。room_id 为空显示主页；解析或网络失败提示原因并保留基本登录。服务端以本次 OAuth 用户身份核验请求实例和邀请房间，绝不使用 SDK 或 URL 房间号补齐可信数据。普通建房、手动输入房间号及基本登录不依赖 context。

## 已接入的 SDK 能力

| 能力                                | 游戏行为                                                                                   |
| ----------------------------------- | ------------------------------------------------------------------------------------------ |
| `ready()` / `onConnectionChanged()` | 读取能力和启动上下文；恢复期间暂停游戏连接，恢复后重新读取上下文                           |
| `session.get()`                     | 用户主动授权，默认只请求 `profile.basic`；调试面板可追加好友、频道权限                     |
| `lifecycle.reportLoadResult()`      | 欢迎页可用后上报加载成功，每个适配器只成功上报一次                                         |
| `auth.onStateChanged()`             | 同步权限；撤销后退出游戏会话                                                               |
| `lifecycle.onStateChanged()`        | 实例关闭后清除会话并停用操作                                                               |
| `instance.onParticipantsChanged()`  | 显示参与者快照版本                                                                         |
| `ui.openInviteModal()`              | 携带游戏房间号打开邀请；登录后按后端 context 确认的 room_id 自动加入，满员或结束时显示主页 |
| 好友、频道成员、参与者查询          | 按能力与权限启用按钮，支持 cursor 分页                                                     |
| 官方服务器查询及弹窗                | 展示 SDK 返回结果，正常处理取消                                                            |
| `destroy()` / 取消订阅              | 页面卸载、重试时清理旧适配器与连接                                                         |

广告 SDK 能力尚未提供，因此不显示虚构成功结果。平台窗口的完整交互仍由实际宿主负责。

## 模拟宿主与测试

`VITE_KOOK_HOST_ORIGINS=https://localhost:5190 pnpm dev:sdk` 构建并运行本地自测环境（PowerShell 先设置对应环境变量）：

- 宿主：`https://localhost:5190/`。
- 游戏 iframe：`https://127.0.0.1:5190/launch/...`，与宿主不同来源；通过同一启动消息协议接收绑定。
- 游戏服务：loopback 5191，经 HTTPS 入口转发。
- OAuth 服务：随机 loopback 端口，使用一次性测试授权码、短期 token 和明确标注的测试用户。

宿主使用 scoped bridge 与真实 SDK 通信。`tests/support/host.ts`、模拟 OAuth、宿主 HTML 只由自测脚本加载，不进入 `apps/web/dist`。模拟服务器使用独立生成的测试凭证，不会向真实平台发送邀请或修改账号。

宿主工具栏可触发取消、撤销、连接中断、参与者变化和关闭。双人测试使用两个独立浏览器上下文；`player=alice/bob` 与 `room` 是模拟宿主的测试选项，游戏实际从 `ready().context.roomId` 接收邀请。

自动验证命令见 [README](../README.md)。`pnpm test:sdk` 自动忽略仅本地测试证书，使用隔离 schema；桌面和窄屏截图输出到 `.sdk-test/results/`。手动测试需要先分别接受两个 HTTPS 来源的本地证书。

后续真实联调需提供可登录的测试环境和应用配置，验证实际 OAuth 响应、账号切换、邀请、权限撤销、恢复和 iframe cookie 行为。本地测试不覆盖真实客户端或平台服务实现。

## OAuth 用户资料与房间头像

游戏后端只从 OAuth 用户信息响应读取用户名和头像，客户端不能提交或覆盖这些身份资料。nickname 保持现有 API 字段名，承载 KOOK 用户名；新增可空的 avatarUrl 从 avatar／avatarUrl／avatar_url 读取有效 HTTPS 地址。头像不可用时不阻断登录。

用户资料保存于 lights_users.avatar_url，房间玩家快照同步 avatarUrl；重新授权更新资料时广播给同房间玩家。迁移脚本幂等补充头像列，不改变应用命名空间、用户标识、会话协议或累计成绩。已有数据库执行 pnpm db:migrate 后再启动服务。

实例核验依赖平台 OAuth 的 `mini_game.context` 权限；宿主授权应包含既有基本资料权限和该权限，游戏后端凭 token 读取 context，SDK 不接收 token。

## 日志查询

/log 页面及游戏内“调用日志”入口读取 /api/logs。需服务端 LOG_ACCESS_KEY，以 x-log-key 请求头访问，支持登录失败前查询。默认最近3天倒序，记录 KOOK／游戏请求参数、脱敏响应、HTTP状态、业务码、耗时、错误及关联编号；PostgreSQL持久化，默认保留7天（LOG_RETENTION_DAYS）。部署执行 pnpm db:migrate。
