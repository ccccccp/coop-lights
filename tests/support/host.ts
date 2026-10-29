import {
  SCOPED_PROTOCOL_VERSION,
  type ScopedBridgeServer,
  createScopedChannelServer,
} from '@kookapp/kook-bridge-channel'

const params = new URLSearchParams(location.search)
const player = params.get('player') === 'bob' ? 'bob' : 'alice'
const roomId = params.get('room') || undefined
const supported = [
  'social.getFriendsAndDms',
  'channel.getMembers',
  'instance.getParticipants',
  'ui.openInviteModal',
  'officialServer.getStatus',
  'ui.openOfficialServerModal',
  'lifecycle.reportLoadResult',
  'auth.onStateChanged',
  'lifecycle.onStateChanged',
  'instance.onParticipantsChanged',
]
const scopes = ['profile.basic', 'friends.dms.read', 'channel.members.read']
let server: ScopedBridgeServer
let auth = { revision: 1, status: 'unauthorized', scopes: [] as string[] }
let lifecycle = { revision: 1, status: 'active', visibility: 'visible', presentation: 'embedded' }
let participantsRevision = 1
let cancelNext = false
let loaded = 0
let bootstrapEnabled = !params.has('defer-bootstrap')
let bootstrapRequests = 0
let probes = 0
const calls: string[] = []
const authObservers = new Set<(value: unknown) => void>()
const lifecycleObservers = new Set<(value: unknown) => void>()
const participantObservers = new Set<(value: unknown) => void>()
const bootstrap = { hostOrigin: location.origin, sessionId: crypto.randomUUID(), generation: 1 }
const gameOrigin = 'https://127.0.0.1:5190'
const frame = document.querySelector<HTMLIFrameElement>('#game')!

function success(data: unknown) {
  return { ok: true, data }
}
function notifyAuth(status: string, granted: string[] = []) {
  auth = { revision: auth.revision + 1, status, scopes: granted }
  for (const notify of authObservers) notify(success(auth))
}
function register() {
  server = createScopedChannelServer({
    protocolVersion: SCOPED_PROTOCOL_VERSION,
    channelName: 'mini-game-sdk',
    sessionId: bootstrap.sessionId,
    generation: bootstrap.generation,
    transport: 'web',
    peerWindow: frame.contentWindow!,
    expectedOrigin: gameOrigin,
    handshakeTimeoutMs: 5000,
  })
  const handlers: Record<string, (input: Record<string, unknown>) => unknown> = {
    ready: () =>
      success({
        contractVersion: 1,
        gameCode: 'lights-sdk-fixture',
        instanceId: 'fixture-instance',
        platform: 'web',
        capabilities: supported,
        permissionVersion: 'fixture-v1',
        availableScopes: params.has('core') ? [] : scopes,
        context: {
          contextType: 'voice_channel',
          launchSource: roomId || params.has('spoof-room') ? 'invite' : 'appLauncher',
          ...(params.has('spoof-room') ? { roomId: params.get('spoof-room')! } : roomId ? { roomId } : {}),
        },
      }),
    'session.get': async (input) => {
      if (cancelNext) {
        cancelNext = false
        return success({ status: 'cancelled', state: input.state })
      }
      const response = await fetch('/mock/code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ player, roomId }),
      })
      if (!response.ok) throw new Error('Mock code service failed')
      const { code } = await response.json()
      notifyAuth('authorized', input.scopes as string[])
      return success({
        status: 'authorized',
        state: input.state,
        code,
        expiresAt: Date.now() + 60000,
        scopes: auth.scopes,
        revision: auth.revision,
      })
    },
    'social.getFriendsAndDms': (input) =>
      success({
        items: [
          {
            identity: { kind: 'temporary', temporaryId: input.cursor ? 'guest-2' : 'guest-1' },
            username: input.cursor ? '模拟好友第二页' : '模拟好友第一页',
            avatarUrl: null,
            sources: ['friend', 'dm'],
          },
        ],
        revision: 1,
        nextCursor: input.cursor ? null : 'fixture-page-2',
      }),
    'channel.getMembers': () =>
      success({
        items: [
          { identity: { kind: 'temporary', temporaryId: 'channel-guest' }, username: '模拟频道成员', avatarUrl: null },
        ],
        revision: 1,
        nextCursor: null,
      }),
    'instance.getParticipants': () =>
      success({
        items: [
          {
            identity: { kind: 'app_user', userOpenCode: `fixture-${player}` },
            username: player === 'alice' ? '模拟玩家阿青' : '模拟玩家小林',
            avatarUrl: null,
            joinedAt: 1000,
            joinOrder: 0,
          },
        ],
        revision: participantsRevision,
        nextCursor: null,
      }),
    'ui.openInviteModal': (input) => {
      document.querySelector('#host-status')!.textContent = `模拟邀请已提交，游戏房间 ${String(input.roomId)}`
      return success(
        params.has('cancel-invite')
          ? { status: 'cancelled', sentCount: 0, failedCount: 0 }
          : params.has('failed-invite')
            ? { status: 'submitted', sentCount: 0, failedCount: 1 }
            : { status: 'submitted', sentCount: 1, failedCount: 0 }
      )
    },
    'officialServer.getStatus': () =>
      success({ configured: true, name: '模拟官方服务器', iconUrl: null, membership: 'not_joined' }),
    'ui.openOfficialServerModal': () => success({ status: 'cancelled' }),
    'lifecycle.reportLoadResult': () => {
      loaded++
      return success({})
    },
    'lifecycle.resume': () =>
      success({
        status: 'resumed',
        recovery: { ticket: 'fixture_recovery_ticket_11111111111111111111111111111111', expiresInMs: 60000 },
      }),
  }
  for (const [method, handler] of Object.entries(handlers))
    server.handle(`miniGame.v1.${method}`, (input) => {
      calls.push(method)
      return handler((input as { params: Record<string, unknown> }).params)
    })
  for (const [method, observers, value] of [
    ['auth.stateChanged', authObservers, () => auth],
    ['lifecycle.stateChanged', lifecycleObservers, () => lifecycle],
    ['instance.participantsChanged', participantObservers, () => ({ revision: participantsRevision })],
  ] as const) {
    server.handleSubscription(`miniGame.v1.${method}`, (_input, _peer, notify) => {
      observers.add(notify)
      notify(success(value()))
      return () => {
        observers.delete(notify)
      }
    })
  }
  server.handleSubscription('miniGame.v1.health.probe', (input, _peer, notify) => {
    probes++
    const probeId = (input as { callId: string }).callId
    notify(
      success({
        probeId,
        stage: 'client',
        recovery: { ticket: 'fixture_recovery_ticket_00000000000000000000000000000000', expiresInMs: 60000 },
      })
    )
    const timer = setTimeout(() => notify(success({ probeId, stage: 'server', reachable: true })), 0)
    return () => clearTimeout(timer)
  })
}

function sendBootstrap() {
  if (!bootstrapEnabled) return
  frame.contentWindow?.postMessage({ type: 'KOOK_MINI_GAME_BOOTSTRAP', bootstrap }, gameOrigin)
}
frame.addEventListener('load', sendBootstrap)
window.addEventListener('message', (event) => {
  if (
    event.source === frame.contentWindow &&
    event.origin === gameOrigin &&
    event.data?.type === 'KOOK_MINI_GAME_BOOTSTRAP_REQUEST'
  ) {
    bootstrapRequests++
    sendBootstrap()
  }
})

async function launch() {
  const response = await fetch('/mock/launch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(bootstrap),
  })
  const { path } = await response.json()
  register()
  frame.src = gameOrigin + path
}
document.querySelector('#cancel')!.addEventListener('click', () => {
  cancelNext = true
  document.querySelector('#host-status')!.textContent = '下次授权将返回取消'
})
document.querySelector('#revoke')!.addEventListener('click', () => notifyAuth('revoked'))
document.querySelector('#close')!.addEventListener('click', () => {
  lifecycle = { ...lifecycle, revision: lifecycle.revision + 1, status: 'closed' }
  for (const notify of lifecycleObservers) notify(success({ ...lifecycle, reason: 'host_closed' }))
})
document.querySelector('#interrupt')!.addEventListener('click', () => {
  server.destroy()
  register()
})
document.querySelector('#participants')!.addEventListener('click', () => {
  participantsRevision++
  for (const notify of participantObservers) notify(success({ revision: participantsRevision }))
})
Object.assign(window, {
  sdkFixture: {
    calls,
    loaded: () => loaded,
    bootstrapRequests: () => bootstrapRequests,
    probes: () => probes,
    resumeBootstrap() {
      bootstrapEnabled = true
      sendBootstrap()
    },
  },
})
void launch()
