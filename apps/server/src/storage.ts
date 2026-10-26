import { randomUUID } from 'node:crypto'

import pg from 'pg'

import type { GameUser } from '@lights/contracts'

export interface Identity {
  appId: string
  openCode: string
  nickname: string
}
export interface Session {
  hash: string
  userId: string
  expiresAt: number
  instanceId: string | null
}
export interface StoredUser extends GameUser {
  appId: string
}
export interface Settlement {
  roundId: string
  roomId: string
  finishedAt: number
  moves: number
  contributions: Record<string, number>
}
export interface Repository {
  kind: 'postgres'
  getUser(id: string): Promise<StoredUser | null>
  upsertUser(identity: Identity): Promise<StoredUser>
  saveSession(session: Session): Promise<void>
  getSession(hash: string): Promise<Session | null>
  deleteSession(hash: string): Promise<void>
  settle(result: Settlement): Promise<void>
  close(): Promise<void>
}
export class PostgresRepository implements Repository {
  kind = 'postgres' as const
  private pool: pg.Pool
  constructor(databaseUrl: string, schema = 'public') {
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(schema)) throw new Error('数据库 schema 不合法')
    this.pool = new pg.Pool({
      connectionString: databaseUrl,
      max: 5,
      options: `-c search_path=${schema}`,
      connectionTimeoutMillis: 5000,
    })
  }
  private user(row: Record<string, unknown>): StoredUser {
    return {
      id: String(row.id),
      appId: String(row.app_id),
      nickname: String(row.nickname),
      completedRounds: Number(row.completed_rounds),
      totalMoves: Number(row.total_moves),
    }
  }
  async init() {
    await this.pool.query('SELECT id FROM lights_users LIMIT 1')
    return this
  }
  async getUser(id: string) {
    const r = await this.pool.query('SELECT * FROM lights_users WHERE id=$1', [id])
    return r.rows[0] ? this.user(r.rows[0]) : null
  }
  async upsertUser(i: Identity) {
    const r = await this.pool.query(
      'INSERT INTO lights_users(id,app_id,open_code,nickname) VALUES($1,$2,$3,$4) ON CONFLICT(app_id,open_code) DO UPDATE SET nickname=EXCLUDED.nickname RETURNING *',
      [randomUUID(), i.appId, i.openCode, i.nickname]
    )
    return this.user(r.rows[0])
  }
  async saveSession(s: Session) {
    await this.pool.query('DELETE FROM lights_sessions WHERE expires_at<=$1', [Date.now()])
    await this.pool.query('INSERT INTO lights_sessions(hash,user_id,expires_at,instance_id) VALUES($1,$2,$3,$4)', [
      s.hash,
      s.userId,
      s.expiresAt,
      s.instanceId,
    ])
  }
  async getSession(hash: string) {
    const r = await this.pool.query('SELECT * FROM lights_sessions WHERE hash=$1 AND expires_at>$2', [
        hash,
        Date.now(),
      ]),
      s = r.rows[0]
    return s
      ? {
          hash: s.hash,
          userId: s.user_id,
          expiresAt: Number(s.expires_at),
          instanceId: s.instance_id,
        }
      : null
  }
  async deleteSession(hash: string) {
    await this.pool.query('DELETE FROM lights_sessions WHERE hash=$1', [hash])
  }
  async settle(s: Settlement) {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const inserted = await client.query(
        'INSERT INTO lights_rounds(round_id,room_id,finished_at,moves,contributions) VALUES($1,$2,$3,$4,$5) ON CONFLICT(round_id) DO NOTHING RETURNING round_id',
        [s.roundId, s.roomId, s.finishedAt, s.moves, s.contributions]
      )
      if (inserted.rowCount)
        for (const [userId, moves] of Object.entries(s.contributions))
          await client.query(
            'UPDATE lights_users SET completed_rounds=completed_rounds+1,total_moves=total_moves+$2 WHERE id=$1',
            [userId, moves]
          )
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    } finally {
      client.release()
    }
  }
  async close() {
    await this.pool.end()
  }
}
