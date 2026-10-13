import { resolve } from 'node:path'
import { getConfig, projectRoot } from './config'
import { PostgresRepository } from './storage'
import { createApp } from './app'

const config = getConfig()
const repo = await new PostgresRepository(config.databaseUrl).init()
const { app } = await createApp(config, repo, resolve(projectRoot, 'apps/web/dist'))
await app.listen({ host: config.host, port: config.port })
app.log.info({ mode: config.mode, storage: repo.kind }, '协作点灯服务已启动')
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    void app.close().then(() => process.exit(0))
  })
