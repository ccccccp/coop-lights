import { randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises'
import { resolve } from 'node:path'
import pg from 'pg'
import { projectRoot } from './config'

// 此脚本只生成数据库运行配置和凭证，不保存游戏业务数据。
const localDir = resolve(projectRoot, '.local'),
  configPath = resolve(localDir, 'database.json')
const dataDir = resolve(projectRoot, '.postgres')
const bin = process.env.PG_BIN || 'D:/Program Files/PostgreSQL/17/bin'
const exe = (name: string) => resolve(bin, `${name}${process.platform === 'win32' ? '.exe' : ''}`)
const run = (name: string, args: string[]) =>
  execFileSync(exe(name), args, {
    windowsHide: true,
    encoding: 'utf8',
    stdio: 'ignore',
    timeout: 20000,
  })
type LocalDatabase = {
  databaseUrl: string
  source: 'isolated' | 'existing'
  port: number
}
let saved: LocalDatabase | null = existsSync(configPath)
  ? (JSON.parse(await readFile(configPath, 'utf8')) as LocalDatabase)
  : null
if (process.argv.includes('--stop')) {
  if (saved?.source !== 'isolated') throw new Error('只允许停止本项目独立 PostgreSQL 实例')
  run('pg_ctl', ['stop', '-D', dataDir, '-m', 'fast', '-w', '-t', '10'])
  console.info('游戏专用 PostgreSQL 已停止，数据保留。')
} else {
  await mkdir(localDir, { recursive: true })
  if (!saved && !process.env.DATABASE_URL) {
    const password = randomBytes(24).toString('hex')
    const port = Number(process.env.GAME_PG_PORT || 55432)
    if (!Number.isInteger(port) || port < 1024 || port > 65535)
      throw new Error('GAME_PG_PORT 不合法')
    const adminUrl = process.env.PG_ADMIN_URL
    if (adminUrl) {
      const admin = new pg.Client({
        connectionString: adminUrl,
        connectionTimeoutMillis: 5000,
      })
      await admin.connect()
      try {
        const exists = await admin.query("SELECT 1 FROM pg_roles WHERE rolname='lights_game'")
        if (exists.rowCount)
          throw new Error('lights_game 账号已存在，请配置其 DATABASE_URL，不覆盖已有密码')
        await admin.query(`CREATE ROLE lights_game LOGIN PASSWORD '${password}'`)
        await admin.query('CREATE DATABASE kook_coop_lights OWNER lights_game')
      } finally {
        await admin.end()
      }
      const u = new URL(adminUrl)
      u.username = 'lights_game'
      u.password = password
      u.pathname = '/kook_coop_lights'
      saved = {
        databaseUrl: u.href,
        source: 'existing',
        port: Number(u.port || 5432),
      }
    } else {
      if (!existsSync(exe('initdb')))
        throw new Error('未找到 PostgreSQL，请设置 PG_BIN 或专用 DATABASE_URL')
      if (existsSync(resolve(dataDir, 'PG_VERSION')))
        throw new Error('独立数据库已存在但连接配置缺失，请恢复 .local/database.json')
      const passwordFile = resolve(localDir, 'init-password.tmp')
      await writeFile(passwordFile, password, { mode: 0o600, flag: 'wx' })
      try {
        run('initdb', [
          '-D',
          dataDir,
          '-U',
          'lights_owner',
          '--auth=scram-sha-256',
          '--encoding=UTF8',
          '--locale=C',
          `--pwfile=${passwordFile}`,
        ])
      } finally {
        await unlink(passwordFile)
      }
      // 初始化账号管理专用实例，应用使用非超级用户 lights_game。
      saved = {
        databaseUrl: `postgresql://lights_owner:${password}@127.0.0.1:${port}/postgres`,
        source: 'isolated',
        port,
      }
      await writeFile(configPath, JSON.stringify(saved), {
        mode: 0o600,
        flag: 'wx',
      })
      run('pg_ctl', [
        'start',
        '-D',
        dataDir,
        '-l',
        resolve(localDir, 'postgres.log'),
        '-o',
        `-p ${port} -h 127.0.0.1`,
        '-w',
        '-t',
        '15',
      ])
      const admin = new pg.Client({
        connectionString: saved.databaseUrl,
        connectionTimeoutMillis: 5000,
      })
      await admin.connect()
      try {
        await admin.query(`CREATE ROLE lights_game LOGIN PASSWORD '${password}'`)
        await admin.query('CREATE DATABASE kook_coop_lights OWNER lights_game')
      } finally {
        await admin.end()
      }
      saved.databaseUrl = `postgresql://lights_game:${password}@127.0.0.1:${port}/kook_coop_lights`
    }
    await writeFile(configPath, JSON.stringify(saved), { mode: 0o600 })
  } else if (saved?.source === 'isolated' && !process.env.DATABASE_URL) {
    try {
      run('pg_ctl', ['status', '-D', dataDir])
    } catch {
      run('pg_ctl', [
        'start',
        '-D',
        dataDir,
        '-l',
        resolve(localDir, 'postgres.log'),
        '-o',
        `-p ${saved.port} -h 127.0.0.1`,
        '-w',
        '-t',
        '15',
      ])
    }
  }
  const databaseUrl = process.env.DATABASE_URL || saved?.databaseUrl
  if (!databaseUrl) throw new Error('没有数据库连接配置')
  // 若首次启动中断在账号创建前，通过专用实例初始化账号继续收尾。
  if (saved?.source === 'isolated' && new URL(databaseUrl).username === 'lights_owner') {
    const owner = new pg.Client({
      connectionString: databaseUrl,
      connectionTimeoutMillis: 5000,
    })
    await owner.connect()
    const password = decodeURIComponent(new URL(databaseUrl).password)
    try {
      if (!(await owner.query("SELECT 1 FROM pg_roles WHERE rolname='lights_game'")).rowCount)
        await owner.query(`CREATE ROLE lights_game LOGIN PASSWORD '${password}'`)
      if (
        !(await owner.query("SELECT 1 FROM pg_database WHERE datname='kook_coop_lights'")).rowCount
      )
        await owner.query('CREATE DATABASE kook_coop_lights OWNER lights_game')
    } finally {
      await owner.end()
    }
    const url = new URL(databaseUrl)
    url.username = 'lights_game'
    url.pathname = '/kook_coop_lights'
    saved.databaseUrl = url.href
    await writeFile(configPath, JSON.stringify(saved), { mode: 0o600 })
  }
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL || saved?.databaseUrl,
    connectionTimeoutMillis: 5000,
  })
  await client.connect()
  try {
    await client.query('BEGIN')
    await client.query(
      await readFile(resolve(projectRoot, 'db/migrations/001_initial.sql'), 'utf8'),
    )
    await client.query('COMMIT')
    const version = await client.query('SHOW server_version')
    console.info(
      `PostgreSQL ${version.rows[0].server_version} 就绪，数据库 kook_coop_lights，端口 ${new URL(databaseUrl).port || '5432'}；凭证保存在 .local/database.json。`,
    )
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  } finally {
    await client.end()
  }
}
