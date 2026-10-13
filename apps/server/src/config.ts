import { config as loadEnv } from 'dotenv'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { existsSync, readFileSync } from 'node:fs'

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
loadEnv({ path: resolve(projectRoot, '.env'), quiet: true })
const envSchema = z.object({
  APP_MODE: z.enum(['standalone', 'kook']).default('standalone'),
  SERVER_HOST: z.string().default('127.0.0.1'),
  SERVER_PORT: z.coerce.number().int().min(1).max(65535).default(5188),
  GAME_MAX_PLAYERS: z.coerce.number().int().min(1).max(4).default(4),
  GAME_RECONNECT_GRACE_MS: z.coerce.number().int().min(100).default(60000),
  GAME_SESSION_TTL_MS: z.coerce.number().int().min(1000).default(604800000),
  ENABLE_DEV_FAULTS: z.enum(['true', 'false']).default('true'),
  ALLOWED_GAME_ORIGINS: z
    .string()
    .default(
      'http://localhost:5178,http://127.0.0.1:5178,http://localhost:5188,http://127.0.0.1:5188',
    ),
  DATABASE_URL: z.string().default(''),
})
export function getConfig() {
  const e = envSchema.parse(process.env)
  const localPath = resolve(projectRoot, '.local/database.json')
  const local = existsSync(localPath)
    ? (JSON.parse(readFileSync(localPath, 'utf8')) as { databaseUrl: string })
    : null
  const databaseUrl = e.DATABASE_URL || local?.databaseUrl || ''
  if (!databaseUrl) throw new Error('请先运行 pnpm db:setup，或配置专用 PostgreSQL DATABASE_URL')
  return {
    mode: e.APP_MODE,
    host: e.SERVER_HOST,
    port: e.SERVER_PORT,
    maxPlayers: e.GAME_MAX_PLAYERS,
    graceMs: e.GAME_RECONNECT_GRACE_MS,
    sessionTtlMs: e.GAME_SESSION_TTL_MS,
    devFaults:
      e.ENABLE_DEV_FAULTS === 'true' &&
      e.APP_MODE === 'standalone' &&
      process.env.NODE_ENV !== 'production',
    allowedOrigins: e.ALLOWED_GAME_ORIGINS.split(',').map((x) => new URL(x.trim()).origin),
    databaseUrl,
  }
}
export type Config = ReturnType<typeof getConfig>
