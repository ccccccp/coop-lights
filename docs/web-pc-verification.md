# Web／PC 手动验证清单

本清单交给使用方执行；自动化测试只覆盖原生 HTTPS、游戏服务与受控 SDK 宿主，不代表真实 KOOK Web 或 PC 已验收。

## 启动独立点灯项目

```powershell
cd E:\work\pros\kook-coop-lights
pnpm install --frozen-lockfile
pnpm db:setup
pnpm dev
```

本机 `.env` 需启用 `APP_MODE=kook`、`WEB_HTTPS=true`、`SERVER_HTTPS=false`，配置已信任证书 `GAME_TLS_CERT/GAME_TLS_KEY`。游戏地址为 `https://localhost:5178/`，API 和 WebSocket 经 Vite 同源代理至 loopback 5188。`pnpm dev` 已原生支持 HTTPS，不需要 SDK 示例的 `.local` 启动脚本。

启动前确认 5178、5188 没有被 SDK 仓库里的另一份游戏示例占用。不要同时在相同端口启动两个项目，也不要停止其它 KOOK 或 PM2 服务。

真实宿主 `view.profile.start_url` 必须指向这次验证的游戏地址，`view.client_id` 与游戏后端的 `KOOK_CLIENT_ID` 保持一致；OAuth 授权回调必须与 `KOOK_REDIRECT_URI` 完全一致。`VITE_KOOK_HOST_ORIGINS` 只包含实际 KOOK 宿主的 HTTPS origin，`ALLOWED_GAME_ORIGINS` 包含实际游戏页面 origin。修改前端环境配置后重新启动 Vite或重新构建。

若平台配置仍指向远程游戏站点，请验证该站点已经部署此版本；运行本地代码不会改变远程页面。密钥及数据库凭证保存在忽略提交的本机配置，不从宿主或浏览器取得。

## Web 与 PC 分别执行

1. 从 KOOK 入口打开点灯。确认宿主完成 `open → bootstrap → SDK ready/connected → loaded`，未点击登录时没有强制授权，游戏页面没有超时或重复 iframe。
2. SDK 就绪后应自动发起一次 OAuth，无需填写昵称。先取消一次，确认游戏留在当前页且不反复弹窗；点击重试并同意授权，确认游戏后端完成 `/api/kook/login/start → session.get → /api/kook/login/complete` 并进入大厅。现有路由保持不变。
3. 确认页头显示自己的 KOOK 用户名及头像。创建房间，由另一独立浏览器会话或另一设备授权加入，确认双方玩家列表显示各自的 KOOK 用户名和头像，再准备、点灯并完成一局。确认双方状态一致、结算只保存一次，离开游戏房间不会误退出 KOOK 平台实例。
4. 在目标端禁用第三方 Cookie 后重试登录与点灯。游戏自己的会话通过内存 Bearer 继续工作；页面刷新后需重新授权，不应复用前一 KOOK 账号的游戏身份。
5. 从 KOOK 原生入口关闭游戏，确认平台 `leave` 成功、参与状态清除、SDK 探测停止；重新打开应建立新绑定。关闭 Web 标签、PC 游戏窗口和退出语音等入口分别按产品支持范围验证。
6. PC 还需核对实际 Electron 客户端中的内嵌／独立窗口承载、焦点切换、关闭清理与证书信任，浏览器通过不能替代这一项。

记录实际版本、入口、结果和失败环节。未提供的邀请／社交权限不作为当前基础闭环的前置条件；真实 OAuth 接口、用户身份与 PC 承载失败应按实际结果记录。
