# SDK 接入说明

更新：2026-10-23。已完成可配置接入与模拟宿主验证，真实 KOOK 宿主和 OAuth 应用凭证尚未提供。

## 前端启动与登录

`apps/web/src/platform.ts` 使用 SDK 的具名导出 `createKookClient`。游戏根据 `/api/health` 返回的模式选择独立或 KOOK 适配器。KOOK 模式先等待可信启动参数，完成 `ready()` 后展示欢迎页并上报加载完成；只有用户点击登录时才调用 `session.get()`。

游戏提供自己的启动入口 `window.startCoopLights(options)`。这是本游戏与启动器的对接点，不是 KOOK SDK 的全局 API。实际启动器须在游戏页面内通过双方确认的可信注入方式调用：

```ts
window.startCoopLights({
  hostOrigin: trustedLaunch.hostOrigin,
  sessionId: trustedLaunch.sessionId,
  generation: trustedLaunch.generation,
})
```

这些参数必须来自平台可信启动链路。游戏不从普通 query、任意 `postMessage` 或用户输入推断绑定。跨来源宿主不能直接访问 iframe 的 JavaScript；本地测试服务器按随机启动路径注入参数，真实环境需对接其实际启动机制。

每页只接受一组绑定，同组重复注入幂等。切换账号或实例需要重新加载页面。未收到启动参数时会提示从宿主重新打开，可在参数到达后重试连接。

新页面不会仅凭已有游戏 cookie 自动恢复 KOOK 身份。用户点击登录并完成本次授权码交换后，后端可恢复相同账号仍在宽限期内的游戏房间。

## 服务端配置

复制 `.env.example` 为 `.env`，根据实际平台应用配置填写：

| 配置                   | 用途                                                                |
| ---------------------- | ------------------------------------------------------------------- |
| `APP_MODE=kook`        | 启用 KOOK 模式，关闭昵称登录和开发作弊接口                          |
| `KOOK_CLIENT_ID`       | OAuth 应用标识，也是游戏账号隔离维度                                |
| `KOOK_CLIENT_SECRET`   | 仅游戏后端持有的应用密钥                                            |
| `KOOK_REDIRECT_URI`    | 与平台发放授权码时一致的回调地址                                    |
| `KOOK_TOKEN_URL`       | 实际授权码交换接口                                                  |
| `KOOK_USERINFO_URL`    | 实际用户信息接口                                                    |
| `KOOK_USER_ID_FIELD`   | 明确选择响应中的稳定身份字段：`user_open_code`、`user_code` 或 `id` |
| `KOOK_USER_NAME_FIELD` | 昵称字段：`username`（默认）或 `nickname`                           |
| `ALLOWED_GAME_ORIGINS` | 允许请求 API / WebSocket 的游戏页面来源，多个用逗号分隔             |
| `DATABASE_URL`         | 游戏专用 PostgreSQL；留空时使用本地配置文件                         |

端点不预填猜测值。当前交换适配器发送 `application/x-www-form-urlencoded` 的 `grant_type=authorization_code`、`client_id`、`client_secret`、`redirect_uri`、`code`，要求 token 响应含 `access_token`、Bearer `token_type`、秒数 `expires_in`；然后用 Bearer token GET 用户信息。支持直接 JSON 对象或 `{ code: 0, data: ... }` 包装。实际平台若采用其他认证方式或响应结构，需要调整 `apps/server/src/platform.ts` 的交换适配器。

生产端点要求 HTTPS；仅允许 loopback HTTP 用于本地模拟。游戏页面也需要 HTTPS，以使用跨站 iframe 的 `Secure; HttpOnly; SameSite=None; Partitioned` 会话 cookie。部署时保持游戏 API 与游戏页面同源，并为 `/ws` 转发 WebSocket Upgrade。真实 KOOK Web/桌面端的 cookie 策略仍需实际联调。

## 授权链路与游戏会话

1. 游戏调用 `/api/kook/login/start`，后端签发随机 state，并用 HttpOnly cookie 绑定当前浏览器。
2. 用户操作触发 `sdk.session.get({ state, scopes })`；取消作为正常结果返回。
3. 游戏只提交 `code` 和 `state` 到 `/api/kook/login/complete`。
4. 后端一次性消费 state，向配置的 OAuth 服务交换 token、读取用户身份，并创建自己的游戏会话。token 和应用密钥不会返回浏览器。
5. 游戏继续使用已有的房间 HTTP API、一次性 WebSocket 票据及服务端点灯协议。

事务有效期为 5 分钟，旧事务、跨浏览器 state、重复使用、伪造身份字段和取消后到达的响应均被拒绝。追加权限会重新验证身份并更新游戏会话，WebSocket 随之重新认证。

`ready().instanceId` 只用于展示，不能作为游戏后端已验证身份或实例成员资格的凭证。当前房间由游戏后端自己管理，通过邀请房间号加入；没有伪造平台实例校验接口。授权失效、实例关闭时，游戏清除本地登录和房间状态，并注销后端会话。

## 已接入的 SDK 能力

| 能力                                | 游戏行为                                                               |
| ----------------------------------- | ---------------------------------------------------------------------- |
| `ready()` / `onConnectionChanged()` | 读取能力和启动上下文；恢复期间暂停游戏连接，恢复后重新读取上下文       |
| `session.get()`                     | 用户主动授权，默认只请求 `profile.basic`；调试面板可追加好友、频道权限 |
| `lifecycle.reportLoadResult()`      | 欢迎页可用后上报加载成功，每个适配器只成功上报一次                     |
| `auth.onStateChanged()`             | 同步权限；撤销后退出游戏会话                                           |
| `lifecycle.onStateChanged()`        | 实例关闭后清除会话并停用操作                                           |
| `instance.onParticipantsChanged()`  | 显示参与者快照版本                                                     |
| `ui.openInviteModal()`              | 携带游戏房间号打开邀请；受邀启动只预填房间号，用户确认后加入           |
| 好友、频道成员、参与者查询          | 按能力与权限启用按钮，支持 cursor 分页                                 |
| 官方服务器查询及弹窗                | 展示 SDK 返回结果，正常处理取消                                        |
| `destroy()` / 取消订阅              | 页面卸载、重试时清理旧适配器与连接                                     |

广告 SDK 能力尚未提供，因此不显示虚构成功结果。平台窗口的完整交互仍由实际宿主负责。

## 模拟宿主与测试

`pnpm dev:sdk` 构建并运行本地自测环境：

- 宿主：`https://localhost:5190/`。
- 游戏 iframe：`https://127.0.0.1:5190/launch/...`，与宿主不同来源。
- 游戏服务：loopback 5191，经 HTTPS 入口转发。
- OAuth 服务：随机 loopback 端口，使用一次性测试授权码、短期 token 和明确标注的测试用户。

宿主使用 scoped bridge 与真实 SDK 通信。`tests/support/host.ts`、模拟 OAuth、宿主 HTML 只由自测脚本加载，不进入 `apps/web/dist`。模拟服务器使用独立生成的测试凭证，不会向真实平台发送邀请或修改账号。

宿主工具栏可触发取消、撤销、连接中断、参与者变化和关闭。双人测试使用两个独立浏览器上下文；`player=alice/bob` 与 `room` 是模拟宿主的测试选项，游戏实际从 `ready().context.roomId` 接收邀请。

自动验证命令见 [README](../README.md)。`pnpm test:sdk` 自动忽略仅本地测试证书，使用隔离 schema；桌面和窄屏截图输出到 `.sdk-test/results/`。手动测试需要先分别接受两个 HTTPS 来源的本地证书。

后续真实联调需提供应用配置、可信启动参数注入方式和宿主环境，验证实际 OAuth 响应、账号切换、邀请、权限撤销、恢复和 iframe cookie 行为。本地测试不覆盖真实客户端或平台服务实现。
