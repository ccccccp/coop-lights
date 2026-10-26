import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'

export async function createMockOAuth() {
  const accounts = {
    alice: { user_open_code: 'fixture-alice', username: '模拟玩家阿青' },
    bob: { user_open_code: 'fixture-bob', username: '模拟玩家小林' },
  }
  type Account = (typeof accounts)[keyof typeof accounts]
  const codes = new Map<string, { profile: Account; expiresAt: number }>()
  const tokens = new Map<string, Account>()
  const secret = randomBytes(32).toString('hex')
  let exchanges = 0
  let delay = 0
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
        tokens.set(token, value.profile)
        res.end(JSON.stringify({ access_token: token, token_type: 'Bearer', expires_in: 3600 }))
      } else if (req.url === '/userinfo' && req.method === 'GET') {
        const token = req.headers.authorization?.replace(/^Bearer /, '') ?? ''
        const profile = tokens.get(token)
        tokens.delete(token)
        if (!profile) throw new Error('invalid token')
        res.end(JSON.stringify({ code: 0, data: profile }))
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
      userIdField: 'user_open_code' as const,
      userNameField: 'username' as const,
    },
    issue(player: string) {
      if (player !== 'alice' && player !== 'bob') throw new Error('Unknown fixture player')
      for (const [key, value] of codes) if (value.expiresAt <= Date.now()) codes.delete(key)
      const code = randomBytes(24).toString('hex')
      codes.set(code, { profile: accounts[player], expiresAt: Date.now() + 60000 })
      return code
    },
    exchanges: () => exchanges,
    setDelay(value: number) {
      delay = value
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
        server.closeAllConnections()
      }),
  }
}
