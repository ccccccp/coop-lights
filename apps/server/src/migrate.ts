import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import pg from 'pg'
import { getConfig, projectRoot } from './config'

const config = getConfig()
if (!config.databaseUrl) throw new Error('请配置专用游戏数据库 DATABASE_URL')
const client = new pg.Client({ connectionString: config.databaseUrl })
await client.connect()
try {
  await client.query('BEGIN')
  await client.query(await readFile(resolve(projectRoot, 'db/migrations/001_initial.sql'), 'utf8'))
  await client.query('COMMIT')
  console.info('游戏数据库迁移完成（001_initial）')
} catch (e) {
  await client.query('ROLLBACK')
  throw e
} finally {
  await client.end()
}
