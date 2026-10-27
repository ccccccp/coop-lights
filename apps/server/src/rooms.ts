import { randomInt, randomUUID } from 'node:crypto'

import type { Command, GameUser, RoomSnapshot, ServerEvent } from '@lights/contracts'

import { generateBoard, solve, toggle } from './board'
import { GameError, check } from './errors'
import type { Repository, Settlement } from './storage'

interface Room {
  snapshot: RoomSnapshot
  connections: Map<string, string>
  contributions: Record<string, number>
  commands: Map<string, { payload: string; event: ServerEvent }>
  pendingSettlement: Settlement | null
  saveAttempts: number
  nextSaveAt: number
}
export class Rooms {
  private rooms = new Map<string, Room>()
  private members = new Map<string, string>()
  private tails = new Map<string, Promise<unknown>>()
  constructor(
    private repo: Repository,
    private maxPlayers: number,
    private graceMs: number,
    private broadcast: (id: string, event: ServerEvent) => void
  ) {}
  private queue<T>(id: string, job: () => Promise<T> | T): Promise<T> {
    const previous = this.tails.get(id) ?? Promise.resolve()
    const result = previous.catch(() => undefined).then(job)
    this.tails.set(id, result)
    void result
      .finally(() => {
        if (this.tails.get(id) === result) this.tails.delete(id)
      })
      .catch(() => undefined)
    return result
  }
  snapshot(id: string) {
    const r = this.rooms.get(id)
    return r ? structuredClone(r.snapshot) : null
  }
  forUser(userId: string) {
    const id = this.members.get(userId)
    return id ? this.snapshot(id) : null
  }
  private requireRoom(id: string) {
    const r = this.rooms.get(id)
    check(r, 'ROOM_NOT_FOUND', '房间已结束或不存在', 404)
    return r
  }
  private publish(r: Room) {
    r.snapshot.version++
    this.broadcast(r.snapshot.id, {
      type: 'room.snapshot',
      room: structuredClone(r.snapshot),
    })
  }
  private add(r: Room, user: GameUser) {
    const s = r.snapshot
    check(!this.members.has(user.id), 'ALREADY_IN_ROOM', '请先离开当前房间')
    check(s.players.length < this.maxPlayers, 'ROOM_FULL', '房间已满（包含等待重连的成员）')
    if (s.players.length === 0) s.hostId = user.id
    s.players.push({
      id: user.id,
      nickname: user.nickname,
      avatarUrl: user.avatarUrl ?? null,
      joinedAt: Date.now(),
      ready: false,
      online: false,
      reconnectUntil: Date.now() + this.graceMs,
      contribution: r.contributions[user.id] ?? 0,
    })
    if (s.round) r.contributions[user.id] ??= 0
    this.members.set(user.id, s.id)
    this.publish(r)
  }
  create(user: GameUser, instanceId: string | null) {
    check(!this.members.has(user.id), 'ALREADY_IN_ROOM', '请先离开当前房间')
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
    let id: string
    do {
      id = Array.from({ length: 6 }, () => alphabet[randomInt(alphabet.length)]).join('')
    } while (this.rooms.has(id))
    const r: Room = {
      snapshot: {
        id,
        platformInstanceId: instanceId,
        hostId: user.id,
        maxPlayers: this.maxPlayers,
        status: 'waiting',
        version: 0,
        players: [],
        round: null,
        lastMove: null,
      },
      connections: new Map(),
      contributions: {},
      commands: new Map(),
      pendingSettlement: null,
      saveAttempts: 0,
      nextSaveAt: 0,
    }
    this.rooms.set(id, r)
    this.add(r, user)
    return this.snapshot(id)!
  }
  join(id: string, user: GameUser, instanceId: string | null) {
    return this.queue(id, () => {
      const r = this.requireRoom(id)
      check(r.snapshot.platformInstanceId === instanceId, 'INSTANCE_MISMATCH', '房间不属于当前平台实例', 403)
      if (this.members.get(user.id) !== id) this.add(r, user)
      return this.snapshot(id)!
    })
  }
  async updateProfile(user: GameUser) {
    const id = this.members.get(user.id)
    if (!id) return
    await this.queue(id, () => {
      const room = this.rooms.get(id)
      if (!room || this.members.get(user.id) !== id) return
      const player = room.snapshot.players.find((value) => value.id === user.id)
      if (!player || (player.nickname === user.nickname && player.avatarUrl === (user.avatarUrl ?? null))) return
      player.nickname = user.nickname
      player.avatarUrl = user.avatarUrl ?? null
      this.publish(room)
    })
  }
  connect(userId: string, connectionId: string) {
    const id = this.members.get(userId)
    if (!id) return
    const r = this.requireRoom(id),
      p = r.snapshot.players.find((p) => p.id === userId)!
    r.connections.set(userId, connectionId)
    p.online = true
    p.reconnectUntil = null
    this.publish(r)
  }
  disconnect(userId: string, connectionId: string) {
    const id = this.members.get(userId)
    if (!id) return
    const r = this.rooms.get(id)
    if (!r || r.connections.get(userId) !== connectionId) return
    r.connections.delete(userId)
    const p = r.snapshot.players.find((p) => p.id === userId)!
    p.online = false
    p.ready = false
    p.reconnectUntil = Date.now() + this.graceMs
    this.publish(r)
  }
  leave(id: string, userId: string, reason = '主动离开') {
    return this.queue(id, () => {
      const r = this.rooms.get(id)
      if (!r || this.members.get(userId) !== id) return
      r.snapshot.players = r.snapshot.players.filter((p) => p.id !== userId)
      r.connections.delete(userId)
      this.members.delete(userId)
      this.broadcast(id, {
        type: 'room.left',
        roomId: id,
        reason: `${userId}:${reason}`,
      })
      if (r.snapshot.players.length === 0 && !r.pendingSettlement) this.rooms.delete(id)
      else {
        if (r.snapshot.hostId === userId) r.snapshot.hostId = r.snapshot.players[0]?.id ?? ''
        this.publish(r)
      }
    })
  }
  async sweep() {
    for (const [id, r] of this.rooms)
      if (r.pendingSettlement && r.saveAttempts < 3 && r.nextSaveAt <= Date.now()) {
        await this.queue(id, async () => {
          if (r.pendingSettlement && r.nextSaveAt <= Date.now()) await this.save(r)
          if (!r.pendingSettlement && r.snapshot.players.length === 0) this.rooms.delete(id)
        })
      }
    const expired: Array<[string, string]> = []
    for (const [id, r] of this.rooms)
      for (const p of r.snapshot.players)
        if (!p.online && p.reconnectUntil !== null && p.reconnectUntil <= Date.now()) expired.push([id, p.id])
    for (const [id, uid] of expired)
      await this.queue(id, async () => {
        const p = this.rooms.get(id)?.snapshot.players.find((p) => p.id === uid)
        if (p && !p.online && p.reconnectUntil !== null && p.reconnectUntil <= Date.now()) {
          // 同一串行队列内直接删除，避免等待自己。
          const r = this.requireRoom(id)
          r.snapshot.players = r.snapshot.players.filter((x) => x.id !== uid)
          this.members.delete(uid)
          r.connections.delete(uid)
          if (!r.snapshot.players.length && !r.pendingSettlement) this.rooms.delete(id)
          else {
            if (r.snapshot.hostId === uid) r.snapshot.hostId = r.snapshot.players[0]?.id ?? ''
            this.publish(r)
          }
        }
      })
  }
  private async save(r: Room) {
    if (!r.pendingSettlement || !r.snapshot.round) return
    r.saveAttempts++
    r.nextSaveAt = Date.now() + 3000
    r.snapshot.round.saveState = 'pending'
    this.publish(r)
    try {
      await this.repo.settle(r.pendingSettlement)
      r.pendingSettlement = null
      r.snapshot.round.saveState = 'saved'
    } catch {
      r.snapshot.round.saveState = 'failed'
    }
    this.publish(r)
  }
  async handle(userId: string, connectionId: string, command: Command, allowSeed: boolean): Promise<ServerEvent> {
    return this.queue(command.roomId, async () => {
      let r: Room | undefined
      try {
        r = this.requireRoom(command.roomId)
        check(
          this.members.get(userId) === command.roomId && r.connections.get(userId) === connectionId,
          'NOT_CONNECTED',
          '你已不在当前房间连接中',
          403
        )
        const key = `${userId}:${command.actionId}`,
          payload = JSON.stringify(command)
        const old = r.commands.get(key)
        if (old) {
          check(old.payload === payload, 'ACTION_REUSED', '同一操作编号不能用于不同命令')
          return old.event
        }
        const s = r.snapshot,
          p = s.players.find((p) => p.id === userId)!
        if (command.type === 'room.ready') {
          check(s.status !== 'playing', 'ROUND_ACTIVE', '本局正在进行')
          p.ready = command.ready
          this.publish(r)
        } else if (command.type === 'round.start') {
          check(s.hostId === userId, 'HOST_ONLY', '只有房主可以开始')
          check(s.status !== 'playing', 'ROUND_ACTIVE', '本局正在进行')
          check(!r.pendingSettlement, 'SAVE_PENDING', '请先保存上一局的结算')
          check(
            s.players.every((p) => !p.online || p.ready),
            'NOT_READY',
            '在线成员需要先准备'
          )
          check(command.seed === undefined || allowSeed, 'DEV_DISABLED', '当前环境不允许指定关卡')
          const seed = command.seed ?? randomInt(0x100000000),
            { board } = generateBoard(seed)
          const number = (s.round?.number ?? 0) + 1
          r.contributions = Object.fromEntries(s.players.map((p) => [p.id, 0]))
          r.commands.clear()
          r.saveAttempts = 0
          r.nextSaveAt = 0
          s.players.forEach((p) => {
            p.contribution = 0
            p.ready = false
          })
          s.round = {
            id: randomUUID(),
            number,
            seed,
            board,
            startedAt: Date.now(),
            finishedAt: null,
            moves: 0,
            saveState: 'pending',
          }
          s.status = 'playing'
          s.lastMove = null
          this.publish(r)
        } else if (command.type === 'board.toggle') {
          check(s.status === 'playing' && s.round, 'ROUND_NOT_ACTIVE', '当前没有进行中的关卡')
          check(s.round.id === command.roundId, 'ROUND_CHANGED', '关卡已更换，请使用最新棋盘')
          check(s.version === command.expectedVersion, 'VERSION_STALE', '棋盘已更新，请在最新棋盘上操作')
          s.round.board = toggle(s.round.board, command.cell)
          s.round.moves++
          p.contribution++
          r.contributions[userId] = (r.contributions[userId] ?? 0) + 1
          s.lastMove = {
            nickname: p.nickname,
            cell: command.cell,
            at: Date.now(),
          }
          if (s.round.board.every(Boolean)) {
            s.status = 'finished'
            s.round.finishedAt = Date.now()
            r.pendingSettlement = {
              roundId: s.round.id,
              roomId: s.id,
              moves: s.round.moves,
              finishedAt: s.round.finishedAt,
              contributions: { ...r.contributions },
            }
          }
          this.publish(r)
          if (r.pendingSettlement) await this.save(r)
        } else if (command.type === 'round.retrySave') {
          check(s.status === 'finished' && r.pendingSettlement, 'NOT_PENDING', '没有待保存结算')
          await this.save(r)
        }
        const event: ServerEvent = {
          type: 'command.result',
          actionId: command.actionId,
          ok: true,
          room: this.snapshot(s.id)!,
        }
        r.commands.set(key, { payload, event })
        if (r.commands.size > 2048) r.commands.delete(r.commands.keys().next().value!)
        return event
      } catch (e) {
        if (!(e instanceof GameError)) throw e
        return {
          type: 'command.result',
          actionId: command.actionId,
          ok: false,
          error: { code: e.code, message: e.message },
          ...(r ? { room: this.snapshot(r.snapshot.id)! } : {}),
        }
      }
    })
  }
  hint(id: string, userId: string) {
    check(this.members.get(userId) === id, 'NOT_MEMBER', '你不在此房间', 403)
    const r = this.requireRoom(id)
    check(r.snapshot.status === 'playing' && r.snapshot.round, 'ROUND_NOT_ACTIVE', '尚未开始')
    return solve(r.snapshot.round.board)
  }
}
