import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { config as loadEnv } from 'dotenv'
import { z } from 'zod'

import { readGameTls } from '../../../scripts/tls'

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
loadEnv({ path: resolve(projectRoot, '.env'), quiet: true })
const envSchema = z.object({
  APP_MODE: z.enum(['standalone', 'kook']).default('standalone'),
  SERVER_HOST: z.string().default('127.0.0.1'),
  SERVER_HTTPS: z.enum(['true', 'false']).default('false'),
  GAME_TLS_CERT: z.string().default(''),
  GAME_TLS_KEY: z.string().default(''),
  SERVER_PORT: z.coerce.number().int().min(1).max(65535).default(5188),
  ENABLE_DEV_FAULTS: z.enum(['true', 'false']).default('true'),
  ALLOWED_GAME_ORIGINS: z
    .string()
    .default('http://localhost:5178,http://127.0.0.1:5178,http://localhost:5188,http://127.0.0.1:5188'),
  DATABASE_URL: z.string().default(''),
  LOG_ACCESS_KEY: z.string().default(''),
  LOG_RETENTION_DAYS: z.coerce.number().int().min(3).max(90).default(7),
  KOOK_CLIENT_ID: z.string().default(''),
  KOOK_CLIENT_SECRET: z.string().default(''),
  KOOK_REDIRECT_URI: z.string().default(''),
  KOOK_API_ORIGIN: z
    .string()
    .refine((value) => {
      try {
        const url = new URL(value)
        return url.protocol === 'https:' && url.origin === value
      } catch {
        return false
      }
    }, 'KOOK_API_ORIGIN 必须是 HTTPS origin，不含路径、查询参数或末尾斜杠')
    .default('https://www.kookapp.cn'),
  KOOK_GAME_CODE: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,32}$/)
    .default('751wtNQveFXjlVoZ'),
})
export function getConfig() {
  const e = envSchema.parse(process.env)
  const localPath = resolve(projectRoot, '.local/database.json')
  const local = existsSync(localPath) ? (JSON.parse(readFileSync(localPath, 'utf8')) as { databaseUrl: string }) : null
  const databaseUrl = e.DATABASE_URL || local?.databaseUrl || ''
  if (!databaseUrl) throw new Error('请先运行 pnpm db:docker / pnpm db:setup，或配置专用 PostgreSQL DATABASE_URL')
  return {
    mode: e.APP_MODE,
    host: e.SERVER_HOST,
    port: e.SERVER_PORT,
    // 点灯规则固定：最多 4 人，断线保留 60 秒，游戏会话最长 7 天。
    maxPlayers: 4,
    graceMs: 60000,
    sessionTtlMs: 604800000,
    devFaults: e.ENABLE_DEV_FAULTS === 'true' && e.APP_MODE === 'standalone' && process.env.NODE_ENV !== 'production',
    allowedOrigins: e.ALLOWED_GAME_ORIGINS.split(',').map((x) => new URL(x.trim()).origin),
    databaseUrl,
    logAccessKey: e.LOG_ACCESS_KEY,
    logRetentionDays: e.LOG_RETENTION_DAYS,
    tls: readGameTls(e.SERVER_HTTPS === 'true', e.GAME_TLS_CERT, e.GAME_TLS_KEY, projectRoot),
    kook: {
      clientId: e.KOOK_CLIENT_ID,
      clientSecret: e.KOOK_CLIENT_SECRET,
      redirectUri: e.KOOK_REDIRECT_URI,
      // KOOK 接口路径固定，切换正式／测试环境只需替换服务 origin。
      tokenUrl: new URL('/api/oauth2/token', e.KOOK_API_ORIGIN).href,
      userInfoUrl: new URL('/api/v3/user/me', e.KOOK_API_ORIGIN).href,
      gameCode: e.KOOK_GAME_CODE,
      contextUrl: new URL('/api/v3/mini-game/context', e.KOOK_API_ORIGIN).href,
    },
  }
}
export type Config = ReturnType<typeof getConfig>
