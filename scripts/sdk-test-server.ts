import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { request } from 'node:http'
import { createServer } from 'node:https'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

import { build } from 'esbuild'

import { resolveOpenSsl } from './tls'

import { createApp } from '../apps/server/src/app'
import { getConfig, projectRoot } from '../apps/server/src/config'
import { PostgresRepository } from '../apps/server/src/storage'
import { createMockOAuth } from '../tests/support/oauth'

const require = createRequire(resolve(projectRoot, 'apps/server/package.json'))
const pg = require('pg')
const output = resolve(projectRoot, '.sdk-test')
await mkdir(output, { recursive: true })
const key = resolve(output, 'localhost.key')
const cert = resolve(output, 'localhost.crt')
if (!existsSync(key) || !existsSync(cert)) {
  const openssl = resolveOpenSsl()
  execFileSync(
    openssl,
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      key,
      '-out',
      cert,
      '-days',
      '365',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost,IP:127.0.0.1',
    ],
    { windowsHide: true, stdio: 'ignore' }
  )
}
// Dev-only fixture uses the same audited scoped bridge as the local SDK. It never enters the game bundle.
const { scopedBridgePlugin } = await import('../../kook-minigame-sdk/scripts/bridge-entry.mjs')
const { browserTargets } = await import('../../kook-minigame-sdk/scripts/browser-targets.mjs')
await build({
  absWorkingDir: projectRoot,
  entryPoints: ['tests/support/host.ts'],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: [...browserTargets],
  outfile: resolve(output, 'host.js'),
  plugins: [await scopedBridgePlugin()],
})

const base = getConfig()
const oauth = await createMockOAuth()
const isolated = process.env.SDK_TEST_ISOLATED === 'true'
const schema = isolated ? `lights_sdk_${randomUUID().replaceAll('-', '')}` : 'public'
const admin = new pg.Client({ connectionString: base.databaseUrl })
await admin.connect()
if (isolated) await admin.query(`CREATE SCHEMA ${schema}`)
await admin.query(`SET search_path TO ${schema}`)
await admin.query(await readFile(resolve(projectRoot, 'db/migrations/001_initial.sql'), 'utf8'))
const repo = await new PostgresRepository(base.databaseUrl, schema).init()
const { app } = await createApp(
  {
    ...base,
    mode: 'kook',
    devFaults: false,
    port: 5191,
    // SDK 测试入口负责 HTTPS，内部上游保持 loopback HTTP。
    tls: undefined,
    allowedOrigins: ['https://127.0.0.1:5190'],
    kook: oauth.config,
  },
  repo,
  resolve(projectRoot, 'apps/web/dist')
)
await app.listen({ host: '127.0.0.1', port: 5191 })

const launches = new Map<string, { hostOrigin: string; sessionId: string; generation: number }>()
const hostHtml = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>点灯 · SDK 模拟宿主</title>
<style>body{margin:0;padding:18px;background:#101a19;color:#ecf3eb;font:14px system-ui}.toolbar{display:flex;gap:10px;flex-wrap:wrap;align-items:center}.host-button{padding:8px 12px;cursor:pointer}.host-frame{width:100%;height:1050px;border:1px solid #2b3933;margin-top:12px}.host-status{min-height:20px;color:#c7ee8b}.host-note{color:#aebfac}</style>
<h1>本地模拟 KOOK 宿主</h1><p class="host-note">游戏运行真实 SDK，账号、授权服务和平台返回数据为明确标注的本地测试数据。</p>
<div class="toolbar"><a class="host-button" href="/?player=alice">玩家阿青</a><a class="host-button" href="/?player=bob">玩家小林</a><button class="host-button" id="cancel">取消下次授权</button><button class="host-button" id="revoke">撤销授权</button><button class="host-button" id="interrupt">断线恢复</button><button class="host-button" id="participants">参与者变化</button><button class="host-button" id="close">结束实例</button></div>
<p class="host-status" id="host-status">可用两个隔离浏览器窗口测试双人游戏。</p><iframe class="host-frame" id="game" name="game" allow="clipboard-write"></iframe><script type="module" src="/host.js"></script></html>`

const server = createServer({ key: await readFile(key), cert: await readFile(cert) }, async (req, res) => {
  const url = new URL(req.url ?? '/', `https://${req.headers.host}`)
  try {
    if (url.hostname === 'localhost') {
      if (url.pathname === '/' || url.pathname === '/host') {
        res.setHeader('Content-Type', 'text/html; charset=utf-8')
        res.end(hostHtml)
        return
      }
      if (url.pathname === '/host.js') {
        res.setHeader('Content-Type', 'text/javascript')
        res.end(await readFile(resolve(output, 'host.js')))
        return
      }
      if (url.pathname === '/mock/health') {
        res.setHeader('Content-Type', 'application/json')
        res.end('{"mock":true}')
        return
      }
      if (req.method === 'POST' && ['/mock/code', '/mock/launch'].includes(url.pathname)) {
        if (req.headers.origin !== 'https://localhost:5190') {
          res.writeHead(403).end()
          return
        }
        let body = ''
        for await (const chunk of req) {
          body += chunk
          if (body.length > 8192) throw new Error('oversized')
        }
        const data = JSON.parse(body)
        res.setHeader('Content-Type', 'application/json')
        res.setHeader('Cache-Control', 'no-store')
        if (url.pathname === '/mock/code')
          res.end(JSON.stringify({ code: oauth.issue(data.player, data.roomId ?? null) }))
        else {
          if (
            data.hostOrigin !== 'https://localhost:5190' ||
            typeof data.sessionId !== 'string' ||
            data.generation !== 1
          )
            throw new Error('invalid launch')
          if (launches.size >= 1000) throw new Error('too many launches')
          const path = `/launch/${randomUUID()}`
          launches.set(path, { hostOrigin: data.hostOrigin, sessionId: data.sessionId, generation: 1 })
          res.end(JSON.stringify({ path }))
        }
        return
      }
      res.writeHead(404).end()
      return
    }
    if (url.hostname !== '127.0.0.1') {
      res.writeHead(403).end()
      return
    }
    if (url.pathname.startsWith('/launch/')) {
      const binding = launches.get(url.pathname)
      if (!binding) {
        res.writeHead(404).end()
        return
      }
      const html = await readFile(resolve(projectRoot, 'apps/web/dist/index.html'), 'utf8')
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.setHeader('Cache-Control', 'no-store')
      res.end(html)
      return
    }
    const upstream = request(
      { host: '127.0.0.1', port: 5191, path: req.url, method: req.method, headers: req.headers },
      (response) => {
        res.writeHead(response.statusCode ?? 502, response.headers)
        response.pipe(res)
      }
    )
    upstream.on('error', () => {
      res.writeHead(502).end()
    })
    req.pipe(upstream)
  } catch {
    res.writeHead(400).end('Invalid local fixture request')
  }
})
server.on('upgrade', (req, socket, head) => {
  if (req.headers.host !== '127.0.0.1:5190' || req.url !== '/ws') {
    socket.destroy()
    return
  }
  const proxy = request({ host: '127.0.0.1', port: 5191, path: req.url, headers: req.headers })
  proxy.on('upgrade', (res, target, received) => {
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\n${Object.entries(res.headers)
        .map(([key, value]) => `${key}: ${value}`)
        .join('\r\n')}\r\n\r\n`
    )
    if (head.length) target.write(head)
    if (received.length) socket.write(received)
    target.pipe(socket)
    socket.pipe(target)
    target.on('error', () => socket.destroy())
    socket.on('error', () => target.destroy())
  })
  proxy.on('response', () => socket.destroy())
  proxy.on('error', () => socket.destroy())
  proxy.end()
})
await new Promise<void>((resolve, reject) => {
  server.once('error', reject)
  server.listen(5190, '127.0.0.1', resolve)
})
console.info('SDK 模拟宿主已启动：https://localhost:5190/（本地自签名证书；只使用模拟账号与授权服务）')
let closing = false
async function shutdown() {
  if (closing) return
  closing = true
  server.closeAllConnections()
  server.close()
  await app.close()
  await oauth.close()
  if (isolated) await admin.query(`DROP SCHEMA ${schema} CASCADE`)
  await admin.end()
  process.exit(0)
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => void shutdown())
