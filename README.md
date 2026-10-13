# 协作点灯 · KOOK Co-op Lights

> 本文已归档（2026-10-12）。内容已合并到 [KOOK 小游戏开发与对接手册](../kook/docs/activities/mini-game-project.html)。后续进度、方案、接口和验收只更新该 HTML；本文件保留合并前快照，不再同步维护。

React + TypeScript + Node.js 的 1～4 人联机解谜游戏。当前版本可以独立运行，使用真实 PostgreSQL 保存玩家、登录会话、通关与贡献记录；KOOK SDK 尚未接入。

## 本地启动

需要 Node.js 22+、pnpm 10、PostgreSQL。当前机器使用本机 PostgreSQL 17.10 程序，游戏专用实例监听 `127.0.0.1:55432`，数据库 `kook_coop_lights`，应用账号 `lights_game`。

```powershell
cd E:\work\pros\kook-coop-lights
pnpm install
pnpm db:setup
pnpm dev
```

打开 <http://localhost:5178/>。服务端默认 <http://127.0.0.1:5188/api/health>。

`db:setup` 会生成随机密码的专用实例和账号并执行迁移；重复运行只启动／检查已有实例及迁移，不重置数据。现有 5432 实例使用密码认证，在未提供管理凭证的情况下不会修改它。游戏专用 PostgreSQL 不是 Windows 开机服务，电脑重启后先执行 `pnpm db:setup`。

凭证保存在忽略提交的 `.local/database.json` 中；`.postgres/` 是 PostgreSQL 数据目录。这里不存 JSON 格式游戏数据，也没有文件存储降级方案。不要删除这两个目录来“清缓存”。

可通过 `.env` 中的 `DATABASE_URL` 使用现有实例的专用游戏数据库，再执行 `pnpm db:migrate`。如需要自动在既有实例中创建账号和数据库，可以在首次初始化前提供 `PG_ADMIN_URL`；不会覆盖已有 `lights_game` 账号密码。模板见 [.env.example](.env.example)，真实凭证不要提交。

## 双人测试

1. 普通浏览器输入昵称，创建房间。
2. 用另一浏览器或无痕窗口进入，以另一位玩家登录，输入房间号并加入。邀请链接会预填房间号，仍需点击加入。
3. 两人点击「我准备好了」，房主点击「开始点灯」。
4. 点击灯会同时切换该格及上下左右相邻格，全部点亮即通关。
5. 结算显示「记录已保存」后，双方可准备并开始下一关。

同一浏览器普通标签页共享登录态，新页面连接会替代旧页面；这用于验证刷新交接，不能作为两位独立玩家。

进行中可以加入。异常断线保留席位 60 秒，刷新后自动恢复；主动离开立即释放席位，房主离开后转交给加入最早的剩余成员。不同玩家在同一旧版本同时点击，后到命令明确拒绝，请查看更新后的棋盘再操作，不自动重放。

「开发与平台测试面板」支持指定下一关种子、下一步提示、断线重连与刷新快照。真实平台能力显示未接入，不伪造好友、授权、邀请或广告成功。

## 构建和检查

```powershell
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
```

- 协议测试使用真实 PostgreSQL，在游戏数据库内建立独立 `lights_test_*` schema，结束后仅清理这些测试 schema。
- E2E 使用本机 Chrome、两个隔离的浏览器上下文，启动临时的 5198 服务，验证真实页面与真实数据库；执行前需要构建。测试账号和通关记录保留在游戏数据库中。
- E2E 截图与失败追踪位于忽略提交的 `test-results/`。
- `pnpm build` 后，`pnpm start` 在 5188 同时提供页面、API 和 WebSocket，可直接打开 <http://localhost:5188/>。

开发服务用 Ctrl+C 停止。`pnpm db:stop` 只停止本项目独立数据库，保留数据；不会停止系统的 5432 实例。

## 后续接 SDK

游戏操作协议不依赖 KOOK。前端通过 `PlatformAdapter` 接入，服务端通过已验证身份和上下文接入；核心房间引擎、棋盘与结算保持不变。

详见 [平台过渡契约](docs/platform-contract.md)、[开发进度](docs/development-status.md)、[测试记录](docs/test-scenarios.md) 和 [开发计划](DEVELOPMENT_PLAN.md)。

实时房间目前在 Node.js 内存中，服务端重启结束房间；已保存的玩家、会话和通关记录留在 PostgreSQL。此版本用于本地测试，不代表真实 KOOK 完整流程已验收。
