import { randomUUID } from 'node:crypto'

import pg from 'pg'

import type { GameUser } from '@lights/contracts'

import type { CallLog, CallLogInput, CallLogQuery, CallLogRepository } from './callLogs'

export interface Identity {
  appId: string
  openCode: string
  nickname: string
  avatarUrl?: string | null
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
export interface Repository extends CallLogRepository {
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
      avatarUrl: typeof row.avatar_url === 'string' ? row.avatar_url : null,
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
      'INSERT INTO lights_users(id,app_id,open_code,nickname,avatar_url) VALUES($1,$2,$3,$4,$5) ON CONFLICT(app_id,open_code) DO UPDATE SET nickname=EXCLUDED.nickname,avatar_url=EXCLUDED.avatar_url RETURNING *',
      [randomUUID(), i.appId, i.openCode, i.nickname, i.avatarUrl ?? null]
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

  async saveCallLog(entry: CallLogInput) {
    await this.pool.query(
      'INSERT INTO lights_call_logs(id,started_at,kind,method,endpoint,status,ok,request_id,entry) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [
        randomUUID(),
        entry.startedAt,
        entry.kind,
        entry.method,
        entry.endpoint,
        entry.status,
        entry.ok,
        entry.requestId,
        JSON.stringify(entry),
      ]
    )
  }
  async listCallLogs(query: CallLogQuery): Promise<CallLog[]> {
    const args: unknown[] = [query.from, query.to],
      where = ['started_at >= $1', 'started_at <= $2']
    const add = (value: unknown) => {
      args.push(value)
      return '$' + args.length
    }
    if (query.kind) where.push('kind=' + add(query.kind))
    if (query.errorsOnly) where.push('ok=false')
    if (query.search) {
      const parameter = add('%' + query.search + '%')
      where.push('(endpoint ILIKE ' + parameter + ' OR request_id ILIKE ' + parameter + ')')
    }
    if (query.cursor) where.push('(started_at,id) < (' + add(query.cursor.startedAt) + ',' + add(query.cursor.id) + ')')
    const limit = add(query.limit)
    const rows = await this.pool.query(
      'SELECT id,entry FROM lights_call_logs WHERE ' +
        where.join(' AND ') +
        ' ORDER BY started_at DESC,id DESC LIMIT ' +
        limit,
      args
    )
    return rows.rows.map((row) => ({ ...row.entry, id: row.id }))
  }
  async pruneCallLogs(before: number) {
    await this.pool.query('DELETE FROM lights_call_logs WHERE started_at<$1', [before])
  }
  async close() {
    await this.pool.end()
  }
}
