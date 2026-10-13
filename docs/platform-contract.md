# 平台适配与 SDK 过渡契约

> 本文已归档（2026-10-12）。内容已合并到 [KOOK 小游戏开发与对接手册](../../kook/docs/activities/mini-game-project.html)。后续进度、方案、接口和验收只更新该 HTML；本文件保留合并前快照，不再同步维护。

更新：2026-10-10。当前仅完成独立模式，没有假定 KOOK 官方包名、全局变量或未确认的 HTTP 端点。

## 现有边界

| 层               | 实现                                                             | 后续接入点                                                   |
| ---------------- | ---------------------------------------------------------------- | ------------------------------------------------------------ |
| React 游戏       | App、棋盘、房间、结算                                            | 使用统一 SessionResponse 和房间协议                          |
| 游戏前端平台适配 | `apps/web/src/platform.ts`、共享 PlatformAdapter                 | 实现正式 ready／authenticate／invite／context 事件映射       |
| HTTP／WS 客户端  | `apps/web/src/api.ts`、useConnection                             | 继续使用游戏自己的 API、会话及一次性 WS 票据                 |
| 游戏服务端身份   | `apps/server/src/platform.ts` 的 IdentityProvider／VerifiedGrant | 实现服务端换码及可信用户／上下文查询                         |
| 房间引擎         | Rooms                                                            | 只消费游戏 userId 和已验证的 instanceId，不读取原始 SDK 入参 |
| PostgreSQL       | 玩家、会话、结算                                                 | appId + openCode 唯一键隔离各身份命名空间                    |

`window.__LIGHTS_PLATFORM_ADAPTER__` 是本游戏自己的可选注入点，不是 KOOK 官方 SDK。也可以直接在 createPlatformAdapter 中导入正式实现。只注入前端适配器不等于已接通服务端：当前服务端在 `APP_MODE=kook` 时明确拒绝本地身份。

## 过渡步骤

1. 确定正式 SDK 和接口契约，新增真实适配器模块，不将 KOOK 应用源码或旧 ChildWindow 桥 import 到游戏。
2. 在游戏服务端实现 OAuth 登录事务、state 绑定、换码、应用隔离身份及可信活动上下文查询。
3. 统一返回既有 SessionResponse；真实身份通过 appId／openCode 获取游戏内部用户，实例通过已验证上下文绑定到会话。
4. 接入正式 authenticate、原生邀请与能力检测；独立模式仍用于引擎回归，与真实身份隔离。
5. 上下文变化时，游戏服务端查询最新已接受的目标及版本，用户确认后执行游戏内部切房间。前端事件里的 roomId 不直接授权加入。
6. 调整代理后的 API／WS 路径、Cookie 与 HTTPS/WSS 配置，再进行真实 KOOK 双账号验证。

不会直接把本地玩家记录合并到真实 KOOK 用户，不以昵称匹配身份。平台实例不是游戏房间；一个实例允许多个游戏房间，用户在本游戏中同时只加入一个房间。

## 目前未提供的能力

- 官方 SDK ready、session.get、authenticate 及 context 事件。
- 游戏服务端 OAuth／可信上下文接口；计划文档中相关端点只是拟定接口，尚未上线。
- 原生邀请、社交 scope、好友／频道成员读取和官方服务器。
- KOOK 实例的创建、续期、跨端互斥、活动卡片和三种承载形态。
- 广告展示、服务端验奖和分账。

这些能力不返回模拟成功。独立模式的 local.invite 只复制游戏链接，测试面板展示真实模式。

## 不变的游戏协议

协议版本 1。HTTP 创建／加入返回 RoomSnapshot；WS 先用游戏会话换一次性票据，再发送 authenticate 首包，票据不放 URL。收到 connected 后才发送游戏命令。

点灯命令包含 actionId、roomId、roundId、expectedVersion、cell。服务端串行校验，重复 actionId 去重，旧版本明确拒绝并返回新快照。SDK 接入不改变这些规则。

平台错误、游戏准入错误和临时网络错误要保留区别，不能把 SDK 失败转换成本地登录或自动创建另一个实例。授权、连接、游戏加载成功分别确认，不能把 WebSocket 已连接当作平台授权成功。

## 待 KOOK 最终确认

required／optional 授权顺序、SDK 最小接入要求、可信上下文与 contextRevision 绑定、邀请凭证及有效期、断线恢复租约、token 到期／撤销、独立窗口交接、URL Mapping 和受限 PC 承载环境。
