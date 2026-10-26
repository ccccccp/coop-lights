# 协作点灯 · KOOK Co-op Lights

React + TypeScript + Node.js 的 1～4 人协作点灯游戏，使用 PostgreSQL 保存玩家、登录会话和通关记录。

已接入 KOOK 小游戏 SDK，支持登录授权、邀请、平台数据调试、连接恢复与授权撤销。当前可用本地模拟宿主完成自测；真实 KOOK 环境需要补齐应用配置并联调。配置和接入边界见 [SDK 接入说明](docs/sdk-integration.md)。

## 本地准备

需要 Node.js 22.12+、pnpm 10、Docker Desktop（或已有专用 PostgreSQL）、本机 Chrome。模拟宿主生成 HTTPS 证书还需要 OpenSSL，Windows 默认使用 Git for Windows 自带的版本，也可设置 `OPENSSL_BIN`。

开发期间使用旁边 `../kook-minigame-sdk` 工程生成的本地 SDK 发布包。首次安装或更新 SDK 后：

```powershell
# 在 kook-minigame-sdk 目录生成 SDK 包
pnpm --dir ../kook-minigame-sdk release:pack

# 回到 coop-lights 目录安装并启动专用数据库
pnpm install
pnpm db:docker
```

`db:docker` 创建名为 `coop-lights-sdk-postgres` 的独立 PostgreSQL 17 容器，端口为 `127.0.0.1:55432`，使用 `coop-lights-sdk-pgdata` 数据卷。随机凭证保存到忽略提交的 `.local/database.json`。重复执行会启动原容器并执行幂等迁移，停止使用 `pnpm db:docker:stop`，保留数据。

已有数据库时，在 `.env` 配置专用 `DATABASE_URL` 并执行 `pnpm db:migrate`。原生 PostgreSQL 的 `db:setup` / `db:stop` 入口也保留；请先配置实际 `PG_BIN` 路径，勿与 Docker 初始化方式混用。

## SDK 自测

```powershell
pnpm dev:sdk
```

打开 <https://localhost:5190/>。此命令先构建游戏，再启动跨来源 iframe 宿主、游戏后端和本地 OAuth 服务，不需要真实 KOOK 凭证。默认使用本地数据库保存自测记录。

首次手动访问时，需要分别访问 <https://localhost:5190/> 和 <https://127.0.0.1:5190/> 接受本地自签证书，再回到宿主页。证书只存放在 `.sdk-test/`，脚本不更改系统证书信任。

1. 宿主页选择「玩家阿青」，在游戏里点击「使用 KOOK 登录」，创建房间。
2. 用另一浏览器或无痕窗口打开 `https://localhost:5190/?player=bob&room=房间号`，点击登录和加入。
3. 双方准备，由房主开始点灯；每次点击翻转本格及上下左右相邻格，全部点亮即通关。
4. 宿主工具栏可模拟取消授权、撤销授权、断线恢复、参与者变化和实例关闭。
5. 游戏里的「开发与平台调试面板」可追加权限，读取好友、频道成员、参与者和官方服务器信息。

页面明确标注模拟宿主、模拟账号和模拟数据。SDK 使用真实发布包，授权码经游戏后端交换；本地模拟成功不代表真实平台验收完成。

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
- `test:sdk`：真实 SDK + 模拟宿主，覆盖授权、权限、分页、邀请、双人通关、恢复、撤销和关闭。
- 单元测试使用 `lights_test_*` 临时 schema；SDK 浏览器测试使用 `lights_sdk_*` 临时 schema，并在正常退出时清理。强制终止进程可能留下测试 schema。
- 独立模式浏览器测试使用游戏数据库的默认 schema，产生自测账号与通关记录。截图及失败追踪在 `test-results/`；SDK 截图及失败追踪在 `.sdk-test/results/`。

`docs/platform-contract.md`、`docs/development-status.md`、`docs/test-scenarios.md` 和 `DEVELOPMENT_PLAN.md` 保留 2026-10-12 之前的归档快照；本次 SDK 接入以本 README 和 [SDK 接入说明](docs/sdk-integration.md) 为准。
