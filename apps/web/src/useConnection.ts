import { useEffect, useRef, useState } from 'react'

import type { Command, RoomSnapshot, ServerEvent } from '@lights/contracts'

import { api } from './api'

export function useConnection(
  userId: string | undefined,
  onRoom: (room: RoomSnapshot | null) => void,
  onError: (text: string) => void,
  onSaved: () => void
) {
  const [state, setState] = useState('未连接')
  const [generation, setGeneration] = useState(0)
  const wsRef = useRef<WebSocket | null>(null)
  const callbacks = useRef({ onRoom, onError, onSaved })
  callbacks.current = { onRoom, onError, onSaved }
  const pending = useRef(
    new Map<
      string,
      {
        resolve: () => void
        reject: (e: Error) => void
        timer: ReturnType<typeof setTimeout>
      }
    >()
  )
  useEffect(() => {
    if (!userId) {
      setState('未连接')
      return
    }
    let alive = true,
      reconnectTimer: ReturnType<typeof setTimeout> | undefined,
      attempt = 0,
      current: WebSocket | null = null
    function failPending() {
      for (const p of pending.current.values()) {
        clearTimeout(p.timer)
        p.reject(new Error('连接已断开，操作不会自动重放，请查看最新棋盘'))
      }
      pending.current.clear()
    }
    function schedule() {
      if (!alive) return
      setState('正在重连')
      reconnectTimer = setTimeout(() => void connect(), Math.min(1000 * 2 ** attempt++, 10000))
    }
    async function connect() {
      if (!alive) return
      setState('连接中')
      try {
        const { ticket } = await api.ticket()
        if (!alive) return
        const url = new URL('/ws', location.href)
        url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
        const ws = new WebSocket(url)
        current = ws
        wsRef.current = ws
        ws.onopen = () => ws.send(JSON.stringify({ type: 'authenticate', ticket }))
        ws.onmessage = (event) => {
          if (!alive || ws !== current) return
          const data = JSON.parse(event.data) as ServerEvent
          if (data.type === 'connected') {
            attempt = 0
            callbacks.current.onRoom(data.room)
            setState('已连接')
          }
          if (data.type === 'room.snapshot') {
            callbacks.current.onRoom(data.room.players.some((p) => p.id === userId) ? data.room : null)
            if (data.room.round?.saveState === 'saved') callbacks.current.onSaved()
          }
          if (data.type === 'command.result') {
            if (data.room) callbacks.current.onRoom(data.room.players.some((p) => p.id === userId) ? data.room : null)
            const p = pending.current.get(data.actionId)
            if (p) {
              clearTimeout(p.timer)
              pending.current.delete(data.actionId)
              if (data.ok) p.resolve()
              else p.reject(new Error(data.error?.message ?? '操作失败'))
            }
          }
          if (data.type === 'error') {
            failPending()
            callbacks.current.onError(data.message)
          }
          if (data.type === 'session.replaced') {
            setState('已在另一页面连接')
            failPending()
          }
        }
        ws.onclose = (event) => {
          if (ws !== current) return
          wsRef.current = null
          failPending()
          if (!alive) return
          if (event.code === 4002) {
            setState('已在另一页面连接')
            return
          }
          if (event.code === 4001 || event.code === 4003) {
            setState('登录已失效')
            callbacks.current.onError('登录或连接验证已失效，请重新进入游戏')
            return
          }
          schedule()
        }
        ws.onerror = () => {
          /* close 回调统一恢复，避免重复重连。 */
        }
      } catch (e) {
        if (!alive) return
        if ((e as { code?: string }).code === 'UNAUTHENTICATED') {
          setState('登录已失效')
          return
        }
        schedule()
      }
    }
    void connect()
    return () => {
      alive = false
      clearTimeout(reconnectTimer)
      current?.close()
      wsRef.current = null
      failPending()
    }
  }, [userId, generation])
  function command(
    c:
      | Omit<Extract<Command, { type: 'board.toggle' }>, 'actionId'>
      | Omit<Extract<Command, { type: 'room.ready' }>, 'actionId'>
      | Omit<Extract<Command, { type: 'round.start' }>, 'actionId'>
      | Omit<Extract<Command, { type: 'room.snapshot' }>, 'actionId'>
      | Omit<Extract<Command, { type: 'round.retrySave' }>, 'actionId'>
  ) {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN || state !== '已连接')
      return Promise.reject(new Error('请等待连接恢复后再操作'))
    const actionId = crypto.randomUUID()
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.current.delete(actionId)
        reject(new Error('操作确认超时，请刷新状态后查看结果'))
      }, 5000)
      pending.current.set(actionId, { resolve, reject, timer })
      ws.send(JSON.stringify({ ...c, actionId }))
    })
  }
  return {
    state,
    command,
    reconnect: () => setGeneration((x) => x + 1),
    disconnect: () => wsRef.current?.close(4100, 'development reconnect'),
  }
}
