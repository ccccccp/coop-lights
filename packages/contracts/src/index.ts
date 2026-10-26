import { z } from 'zod'

export const PROTOCOL_VERSION = 1
export const BOARD_SIZE = 4
export const nicknameSchema = z.string().trim().min(1, '请输入昵称').max(20, '昵称最多 20 个字符')
export const roomIdSchema = z.string().regex(/^[A-Z2-9]{6}$/, '请输入 6 位房间号')
const envelope = { actionId: z.string().uuid(), roomId: roomIdSchema }
export const commandSchema = z.discriminatedUnion('type', [
  z.object({ ...envelope, type: z.literal('room.ready'), ready: z.boolean() }).strict(),
  z
    .object({
      ...envelope,
      type: z.literal('round.start'),
      seed: z.number().int().min(0).max(0xffffffff).optional(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      type: z.literal('board.toggle'),
      roundId: z.string().uuid(),
      expectedVersion: z.number().int().nonnegative(),
      cell: z.number().int().min(0).max(15),
    })
    .strict(),
  z.object({ ...envelope, type: z.literal('room.snapshot') }).strict(),
  z.object({ ...envelope, type: z.literal('round.retrySave') }).strict(),
])
export type Command = z.infer<typeof commandSchema>
export interface Player {
  id: string
  nickname: string
  joinedAt: number
  ready: boolean
  online: boolean
  reconnectUntil: number | null
  contribution: number
}
export interface RoundSnapshot {
  id: string
  number: number
  seed: number
  board: boolean[]
  startedAt: number
  finishedAt: number | null
  moves: number
  saveState: 'pending' | 'saved' | 'failed'
}
export interface RoomSnapshot {
  id: string
  platformInstanceId: string | null
  hostId: string
  maxPlayers: number
  status: 'waiting' | 'playing' | 'finished'
  version: number
  players: Player[]
  round: RoundSnapshot | null
  lastMove: { nickname: string; cell: number; at: number } | null
}
export interface GameUser {
  id: string
  nickname: string
  completedRounds: number
  totalMoves: number
}
export interface PlatformContext {
  mode: 'standalone' | 'kook'
  instanceId: string | null
  capabilities: string[]
  authorizedScopes: string[]
  availableScopes: string[]
  status: 'initializing' | 'ready' | 'recovering' | 'unavailable' | 'closed'
  connectionState: string
  epoch: number
  invitedRoomId: string | null
  participantsRevision: number | null
  message: string
}
export interface SessionResponse {
  user: GameUser
  room: RoomSnapshot | null
  platform: PlatformContext
}
export type ServerEvent =
  | { type: 'connected'; protocolVersion: number; room: RoomSnapshot | null }
  | { type: 'room.snapshot'; room: RoomSnapshot }
  | {
      type: 'command.result'
      actionId: string
      ok: boolean
      error?: { code: string; message: string }
      room?: RoomSnapshot
    }
  | { type: 'room.left'; roomId: string; reason: string }
  | { type: 'session.replaced' }
  | { type: 'error'; code: string; message: string }
export interface PlatformAdapter {
  initialize(): Promise<{ session: SessionResponse | null; platform: PlatformContext }>
  login(
    nickname: string,
    scopes?: string[]
  ): Promise<{ status: 'logged_in'; session: SessionResponse } | { status: 'cancelled' }>
  logout(): Promise<void>
  invite(roomId: string): Promise<{ status: 'submitted' | 'cancelled'; url?: string }>
  subscribe(listener: (event: PlatformEvent) => void): () => void
  reportLoaded(): Promise<void>
  inspect?(resource: PlatformResource, cursor?: string): Promise<PlatformInspection>
  openOfficialServer?(): Promise<{ status: string }>
  dispose(): void
}
export type PlatformResource = 'friends' | 'channel' | 'participants' | 'officialServer'
export interface PlatformInspection {
  data: unknown
  nextCursor: string | null
}
export type PlatformEvent =
  { type: 'context'; platform: PlatformContext } | { type: 'session_invalidated'; message: string }
export interface ErrorBody {
  code: string
  message: string
}
