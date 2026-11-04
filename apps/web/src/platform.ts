import { type KookClient, type KookSubscription, type Scope, createKookClient } from '@kookapp/kook-minigame-sdk'
import type { PlatformAdapter, PlatformContext, PlatformEvent, PlatformResource } from '@lights/contracts'

import { ApiError, api, setGameToken } from './api'

const scopes: Scope[] = ['get_user_info', 'mini_game.context']

function initialContext(mode: 'standalone' | 'kook'): PlatformContext {
  return {
    mode,
    instanceId: null,
    capabilities: mode === 'standalone' ? ['local.invite'] : [],
    authorizedScopes: [],
    availableScopes: [],
    status: mode === 'standalone' ? 'ready' : 'initializing',
    connectionState: mode === 'standalone' ? 'connected' : 'idle',
    epoch: 0,
    invitedRoomId: null,
    participantsRevision: null,
    message: mode === 'kook' ? '等待 KOOK 启动参数' : '',
  }
}

export function standaloneAdapter(): PlatformAdapter {
  const platform = initialContext('standalone')
  return {
    async initialize() {
      try {
        return { session: await api.session(), platform }
      } catch (error) {
        if (error instanceof ApiError && error.code === 'UNAUTHENTICATED') return { session: null, platform }
        throw error
      }
    },
    async login(nickname) {
      return { status: 'logged_in', session: await api.login(nickname) }
    },
    async logout() {
      await api.logout()
    },
    async invite(roomId) {
      const url = new URL(location.href)
      url.search = ''
      url.searchParams.set('room', roomId)
      await navigator.clipboard.writeText(url.href)
      return { status: 'submitted', url: url.href }
    },
    subscribe(listener) {
      listener({ type: 'context', platform })
      return () => {}
    },
    async reportLoaded() {},
    dispose() {},
  }
}

export function kookAdapter(): PlatformAdapter {
  const listeners = new Set<(event: PlatformEvent) => void>()
  const subscriptions: KookSubscription[] = []
  let context = initialContext('kook')
  let client: KookClient | null = null
  let disposed = false
  let initialized = false
  let loggedIn = false
  let subscribed = false
  let participantsSubscribed = false
  let reportSent = false
  let loginVersion = 0
  let transaction: string | null = null
  let offConnection: (() => void) | undefined
  let readyWork: Promise<void> | null = null
  let cleanupWork: Promise<unknown> = Promise.resolve()
  let initializedWork: Promise<{ session: null; platform: PlatformContext }> | null = null

  function snapshot(): PlatformContext {
    return {
      ...context,
      capabilities: [...context.capabilities],
      authorizedScopes: [...context.authorizedScopes],
      availableScopes: [...context.availableScopes],
    }
  }
  function emit(event: PlatformEvent): void {
    if (!disposed) for (const listener of listeners) listener(event)
  }
  function patch(value: Partial<PlatformContext>): void {
    context = { ...context, ...value }
    emit({ type: 'context', platform: snapshot() })
  }
  function currentClient(): KookClient {
    if (disposed || !client) throw new Error('KOOK 连接尚未就绪或已结束')
    return client
  }
  function clearGameSession(): Promise<unknown> {
    const pending = transaction
    // 先捕获当前游戏会话；卸载清空内存后，排队的注销仍能精确撤销旧会话。
    const logout = api.prepareLogout()
    cleanupWork = cleanupWork
      .catch(() => undefined)
      .then(async () => {
        if (pending) await api.cancelKookLogin(pending).catch(() => undefined)
        await logout()
      })
    return cleanupWork
  }
  function invalidate(message: string): void {
    loginVersion++
    loggedIn = false
    patch({ message, authorizedScopes: [], participantsRevision: null, invitedRoomId: null, context: null })
    emit({ type: 'session_invalidated', message })
    void clearGameSession().catch(() => undefined)
  }
  function fail(error: unknown): void {
    if (disposed) return
    const message = error instanceof Error ? error.message : 'KOOK 连接失败'
    patch({ status: 'unavailable', message })
    invalidate(message)
  }
  async function keep(subscription: Promise<KookSubscription>): Promise<void> {
    const handle = await subscription
    if (disposed) await handle.unsubscribe()
    else subscriptions.push(handle)
  }
  async function watchParticipants(): Promise<void> {
    const sdk = currentClient()
    if (
      participantsSubscribed ||
      !sdk.hasCapability('instance.onParticipantsChanged') ||
      !sdk.hasScope('get_user_info')
    )
      return
    participantsSubscribed = true
    try {
      await keep(sdk.instance.onParticipantsChanged((value) => patch({ participantsRevision: value.revision })))
    } catch (error) {
      participantsSubscribed = false
      if (!disposed) patch({ message: `参与者订阅未就绪：${error instanceof Error ? error.message : '请求失败'}` })
    }
  }
  async function refresh(): Promise<void> {
    if (readyWork) return readyWork
    const sdk = currentClient()
    readyWork = (async () => {
      const ready = await sdk.ready()
      if (disposed) return
      patch({
        instanceId: ready.instanceId,
        launchSource: ready.context.launchSource,
        launchContextType: ready.context.contextType,
        capabilities: [...ready.capabilities],
        availableScopes: [...ready.availableScopes],
        authorizedScopes: scopes.filter((scope) => sdk.hasScope(scope)),
        invitedRoomId: loggedIn && context.instanceId === ready.instanceId ? context.invitedRoomId : null,
        epoch: sdk.connection.epoch,
        connectionState: sdk.state,
        status: 'ready',
        message: '',
        context: null,
      })
      if (!subscribed) {
        subscribed = true
        if (sdk.hasCapability('auth.onStateChanged')) {
          await keep(
            sdk.auth.onStateChanged((value) => {
              patch({
                authorizedScopes: value.status === 'authorized' ? [...value.scopes] : [],
                participantsRevision: value.status === 'authorized' ? context.participantsRevision : null,
              })
              if (value.status !== 'authorized' && (loggedIn || transaction)) invalidate('KOOK 授权已失效，请重新登录')
            })
          )
        }
        if (sdk.hasCapability('lifecycle.onStateChanged')) {
          await keep(
            sdk.lifecycle.onStateChanged((value) => {
              if (value.status === 'closed') {
                patch({ status: 'closed' })
                invalidate('KOOK 已结束本次游戏，请从宿主重新打开')
              }
            })
          )
        }
      }
      initialized = true
      if (loggedIn)
        await refreshGameContext(false).catch((error) =>
          patch({ message: error instanceof Error ? error.message : '上下文读取失败' })
        )
      if (loggedIn) await watchParticipants()
    })().finally(() => {
      readyWork = null
    })
    return readyWork
  }
  async function refreshGameContext(invite: boolean): Promise<void> {
    const sdk = currentClient(),
      version = loginVersion,
      epoch = sdk.connection.epoch
    if (!loggedIn || !context.instanceId) throw new Error('请先完成登录')
    if (!sdk.hasScope('mini_game.context')) throw new Error('当前授权缺少房间上下文权限，请重新授权后刷新大厅')
    patch({ context: null })
    const result = await (invite ? api.resolveInvite(context.instanceId) : api.refreshContext(context.instanceId))
    if (disposed || version !== loginVersion || sdk.state !== 'connected' || sdk.connection.epoch !== epoch)
      throw new Error('读取上下文期间游戏连接已变化，请重试')
    patch({ context: result.context, invitedRoomId: invite ? result.invitedRoomId : null })
  }

  return {
    initialize() {
      if (initializedWork) return initializedWork
      initializedWork = (async () => {
        if (disposed) throw new Error('游戏初始化已取消')
        const allowedHostOrigins = (import.meta.env.VITE_KOOK_HOST_ORIGINS ?? '')
          .split(',')
          .map((value: string) => value.trim())
          .filter(Boolean)
        client = createKookClient(allowedHostOrigins.length ? { allowedHostOrigins } : undefined)
        offConnection = client.onConnectionChanged((value) => {
          if (disposed) return
          patch({ connectionState: value.state })
          if (value.state === 'destroyed' || value.state === 'disconnected') {
            patch({ status: 'closed' })
            invalidate('KOOK 连接已结束，请从宿主重新打开游戏')
          } else if (initialized && value.state !== 'connected') {
            patch({ status: 'recovering', message: '正在恢复 KOOK 连接，游戏操作已暂停' })
          } else if (initialized && value.state === 'connected' && value.epoch !== context.epoch) {
            patch({ status: 'recovering' })
            void refresh().catch(fail)
          }
        })
        await refresh()
        // A stored game cookie cannot establish which KOOK account opened this new binding.
        // A fresh OAuth code exchange restores that account's existing game room.
        return { session: null, platform: snapshot() }
      })().catch((error) => {
        fail(error)
        throw error
      })
      return initializedWork
    },
    async login(_nickname, requested) {
      const sdk = currentClient()
      if (context.status !== 'ready') throw new Error('请等待 KOOK 连接就绪')
      if (transaction) throw new Error('登录请求正在处理中')
      const selected = [
        ...new Set(
          [
            'get_user_info',
            ...context.authorizedScopes,
            ...(requested ?? scopes.filter((scope) => context.availableScopes.includes(scope))),
          ].map((scope) => (scope === 'profile.basic' ? 'get_user_info' : scope))
        ),
      ]
      if (selected.some((scope) => !scopes.includes(scope as Scope) || !context.availableScopes.includes(scope))) {
        throw new Error('当前应用尚未开放请求的权限')
      }
      const epoch = sdk.connection.epoch
      const version = loginVersion
      function checkBinding() {
        if (disposed || version !== loginVersion || sdk.state !== 'connected' || sdk.connection.epoch !== epoch) {
          throw new Error('登录期间 KOOK 连接或授权发生变化，请重新登录')
        }
      }
      let state: string | null = null
      let success = false
      try {
        // Finish revoking the previous game cookie before a new transaction can start.
        await cleanupWork
        checkBinding()
        const started = await api.beginKookLogin()
        state = started.state
        transaction = state
        checkBinding()
        const result = await sdk.session.get({ state, scopes: selected as Scope[] })
        checkBinding()
        if (result.status === 'cancelled') return { status: 'cancelled' }
        const session = await api.completeKookLogin(result.code, result.state, context.instanceId ?? undefined)
        try {
          checkBinding()
        } catch (error) {
          await api.revokeGameToken(session.gameToken).catch(() => undefined)
          throw error
        }
        setGameToken(session.gameToken ?? null, state)
        loggedIn = true
        patch({
          authorizedScopes: scopes.filter((scope) => sdk.hasScope(scope)),
          invitedRoomId: session.platform.invitedRoomId,
          message: '',
        })
        await watchParticipants()
        checkBinding()
        success = true
        api.finishKookLogin(state)
        const { gameToken: _gameToken, ...publicSession } = session
        return { status: 'logged_in', session: { ...publicSession, platform: snapshot() } }
      } finally {
        transaction = null
        if (state && !success) await api.cancelKookLogin(state).catch(() => undefined)
      }
    },
    async resolveInvite() {
      await refreshGameContext(true)
      if (!context.invitedRoomId) throw new Error('KOOK邀请未返回点灯房间号，已返回房间大厅')
    },
    async refreshContext() {
      await refreshGameContext(false)
    },
    async logout() {
      loginVersion++
      loggedIn = false
      patch({ invitedRoomId: null, context: null })
      await clearGameSession()
    },
    async invite(roomId) {
      const sdk = currentClient()
      if (!sdk.hasCapability('ui.openInviteModal')) throw new Error('当前 KOOK 宿主未开放邀请能力')
      // 频道邀请打开当前频道的游戏大厅，具体房间由同频道玩家在大厅选择。
      if (context.launchContextType === 'text_channel' || context.launchContextType === 'voice_channel') {
        const result = await sdk.ui.openInviteModal()
        return { ...result, target: 'channel' }
      }
      return sdk.ui.openInviteModal({ roomId })
    },
    subscribe(listener) {
      listeners.add(listener)
      listener({ type: 'context', platform: snapshot() })
      return () => {
        listeners.delete(listener)
      }
    },
    async reportLoaded() {
      const sdk = currentClient()
      if (reportSent || context.status !== 'ready' || !sdk.hasCapability('lifecycle.reportLoadResult')) return
      reportSent = true
      try {
        await sdk.lifecycle.reportLoadResult({ status: 'loaded' })
      } catch (error) {
        reportSent = false
        throw error
      }
    },
    async inspect(resource: PlatformResource, cursor?: string) {
      const sdk = currentClient()
      const input = { ...(cursor ? { cursor } : {}), limit: 25 }
      if (resource === 'officialServer') return { data: await sdk.officialServer.getStatus(), nextCursor: null }
      const result =
        resource === 'friends'
          ? await sdk.social.getFriendsAndDms(input)
          : resource === 'channel'
            ? await sdk.channel.getMembers(input)
            : await sdk.instance.getParticipants(input)
      return { data: result, nextCursor: result.nextCursor }
    },
    async openOfficialServer() {
      return currentClient().ui.openOfficialServerModal()
    },
    dispose() {
      if (disposed) return
      disposed = true
      loginVersion++
      offConnection?.()
      for (const subscription of subscriptions) void subscription.unsubscribe().catch(() => undefined)
      client?.destroy()
      setGameToken(null)
      listeners.clear()
    },
  }
}

export function createPlatformAdapter(mode: string): PlatformAdapter {
  if (mode === 'standalone') return standaloneAdapter()
  if (mode === 'kook') return kookAdapter()
  throw new Error('未知的游戏运行模式')
}
