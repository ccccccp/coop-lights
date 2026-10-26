import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const require = createRequire(resolve(root, 'apps/server/package.json'))
const pg = require('pg')
const path = resolve(root, '.local/database.json')
const container = 'coop-lights-sdk-postgres'
const volume = 'coop-lights-sdk-pgdata'
const label = 'coop-lights.managed'
const port = 55432
let saved = null
try {
  saved = JSON.parse(await readFile(path, 'utf8'))
} catch (error) {
  if (error.code !== 'ENOENT') throw error
}
if (saved && saved.source !== 'docker') throw new Error('已有数据库配置，请继续使用其初始化方式；不会覆盖现有配置。')

function docker(args) {
  return execFileSync('docker', args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120000,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim()
}
docker(['info', '--format', '{{.ServerVersion}}'])
const exists =
  docker(['container', 'ls', '-a', '--filter', `name=^/${container}$`, '--format', '{{.Names}}']) === container
if (exists) {
  if (docker(['inspect', '--format', '{{index .Config.Labels "coop-lights.managed"}}', container]) !== 'true') {
    throw new Error('同名容器不属于本项目，不会操作。')
  }
  if (!saved) throw new Error('数据库容器已存在但本地凭证缺失，请恢复 .local/database.json。')
}
if (process.argv.includes('--stop')) {
  if (exists) docker(['stop', container])
  console.info('游戏专用 PostgreSQL 已停止，数据卷与配置保留。')
} else {
  if (!exists) {
    if (saved) throw new Error('已有凭证但数据库容器缺失，请检查原数据卷；不会创建或重置。')
    if (docker(['volume', 'ls', '--filter', `name=^${volume}$`, '--format', '{{.Name}}'])) {
      throw new Error('已有同名数据卷，请先恢复原配置；不会覆盖数据。')
    }
    console.info('准备本项目独立的 PostgreSQL 17 容器…')
    if (!docker(['image', 'ls', '--filter', 'reference=postgres:17', '--format', '{{.ID}}']))
      docker(['pull', 'postgres:17'])
    const password = randomBytes(32).toString('hex')
    docker([
      'run',
      '--detach',
      '--name',
      container,
      '--label',
      `${label}=true`,
      '--publish',
      `127.0.0.1:${port}:5432`,
      '--mount',
      `type=volume,source=${volume},target=/var/lib/postgresql/data`,
      '--env',
      'POSTGRES_DB=kook_coop_lights',
      '--env',
      'POSTGRES_USER=lights_game',
      '--env',
      `POSTGRES_PASSWORD=${password}`,
      'postgres:17',
    ])
    saved = {
      source: 'docker',
      port,
      container,
      databaseUrl: `postgresql://lights_game:${password}@127.0.0.1:${port}/kook_coop_lights`,
    }
    await mkdir(resolve(root, '.local'), { recursive: true })
    await writeFile(path, JSON.stringify(saved), { flag: 'wx', mode: 0o600 })
  } else {
    docker(['start', container])
  }
  let connected = false
  for (let attempt = 0; attempt < 60; attempt++) {
    const client = new pg.Client({ connectionString: saved.databaseUrl, connectionTimeoutMillis: 1000 })
    try {
      await client.connect()
      await client.query(await readFile(resolve(root, 'db/migrations/001_initial.sql'), 'utf8'))
      connected = true
    } catch {
      if (attempt === 59) throw new Error('游戏数据库未就绪，请检查项目容器日志。')
    } finally {
      await client.end()
    }
    if (connected) break
    await new Promise((done) => setTimeout(done, 500))
  }
  console.info(`游戏数据库就绪：127.0.0.1:${port}；凭证已保存到忽略提交的 .local/database.json。`)
}
