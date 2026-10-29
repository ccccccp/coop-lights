import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'

export async function createMockOAuth() {
  const accounts = {
    alice: { user_open_code: 'fixture-alice', username: '模拟玩家阿青', avatar: 'https://avatars.test/alice.svg' },
    bob: { user_open_code: 'fixture-bob', username: '模拟玩家小林', avatar: 'https://avatars.test/bob.svg' },
  }
  type Account = (typeof accounts)[keyof typeof accounts]
  type Launch = { instanceId: string; roomId: string | null }
  const codes = new Map<string, { profile: Account; expiresAt: number } & Launch>()
  const tokens = new Map<string, { profile: Account } & Launch>()
  const secret = randomBytes(32).toString('hex')
  let exchanges = 0
  let delay = 0
  let contextDelay = 0
  let contextResponse: unknown
  let contextCalls = 0
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Cache-Control', 'no-store')
    try {
      if (req.url === '/oauth/token' && req.method === 'POST') {
        let body = ''
        for await (const chunk of req) {
          body += chunk
          if (body.length > 16384) throw new Error('oversized')
        }
        const params = new URLSearchParams(body)
        if (
          params.get('client_id') !== 'lights-sdk-fixture' ||
          params.get('client_secret') !== secret ||
          params.get('grant_type') !== 'authorization_code' ||
          params.get('redirect_uri') !== 'https://127.0.0.1:5190/'
        )
          throw new Error('invalid client')
        const code = params.get('code') ?? ''
        const value = codes.get(code)
        codes.delete(code)
        if (!value || value.expiresAt <= Date.now()) throw new Error('invalid code')
        exchanges++
        if (delay) await new Promise((done) => setTimeout(done, delay))
        const token = randomBytes(32).toString('hex')
        tokens.set(token, value)
        res.end(JSON.stringify({ access_token: token, token_type: 'Bearer', expires_in: 3600 }))
      } else if (req.url === '/userinfo' && req.method === 'GET') {
        const token = req.headers.authorization?.replace(/^Bearer /, '') ?? ''
        const profile = tokens.get(token)?.profile
        if (!profile) throw new Error('invalid token')
        res.end(JSON.stringify({ code: 0, data: profile }))
      } else if (req.url?.startsWith('/api/v3/mini-game/context?') && req.method === 'GET') {
        const token = req.headers.authorization?.replace(/^Bearer /, '') ?? ''
        const launch = tokens.get(token)
        const url = new URL(req.url, 'http://mock.test')
        if (
          !launch ||
          url.searchParams.get('game_code') !== 'lights-sdk-fixture' ||
          url.searchParams.get('instance_id') !== launch.instanceId
        )
          throw new Error('invalid context')
        contextCalls++
        if (contextDelay) await new Promise((done) => setTimeout(done, contextDelay))
        res.end(
          JSON.stringify({
            code: 0,
            data: contextResponse ?? {
              game_code: 'lights-sdk-fixture',
              instance: {
                instance_id: launch.instanceId,
                state: 'active',
                context_type: 4,
                context_id: 'fixture-chat',
              },
              room: launch.roomId
                ? { room_id: launch.roomId, room_source: 'invite' }
                : { room_id: launch.instanceId, room_source: 'instance' },
              invite: { status: launch.roomId ? 'joined_by_invite' : 'none' },
            },
          })
        )
      } else {
        res.writeHead(404).end('{}')
      }
    } catch {
      res.writeHead(400).end(JSON.stringify({ error: 'invalid_grant' }))
    }
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = (server.address() as { port: number }).port
  return {
    config: {
      clientId: 'lights-sdk-fixture',
      clientSecret: secret,
      redirectUri: 'https://127.0.0.1:5190/',
      tokenUrl: `http://127.0.0.1:${port}/oauth/token`,
      userInfoUrl: `http://127.0.0.1:${port}/userinfo`,
      gameCode: 'lights-sdk-fixture',
      contextUrl: `http://127.0.0.1:${port}/api/v3/mini-game/context`,
      userIdField: 'user_open_code' as const,
      userNameField: 'username' as const,
    },
    issue(player: string, roomId: string | null = null, instanceId = 'fixture-instance') {
      if (player !== 'alice' && player !== 'bob') throw new Error('Unknown fixture player')
      for (const [key, value] of codes) if (value.expiresAt <= Date.now()) codes.delete(key)
      const code = randomBytes(24).toString('hex')
      codes.set(code, { profile: accounts[player], expiresAt: Date.now() + 60000, instanceId, roomId })
      return code
    },
    exchanges: () => exchanges,
    setDelay(value: number) {
      delay = value
    },
    contextCalls: () => contextCalls,
    setContextResponse(value: unknown) {
      contextResponse = value
    },
    setContextDelay(value: number) {
      contextDelay = value
    },
    setProfile(player: 'alice' | 'bob', patch: { username?: string; avatar?: string }) {
      Object.assign(accounts[player], patch)
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
        server.closeAllConnections()
      }),
  }
}
