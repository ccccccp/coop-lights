import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { expect, test } from 'vitest'

import { readGameTls, resolveOpenSsl } from '../../../scripts/tls'
import { createApp } from '../src/app'
import { getConfig } from '../src/config'
import type { Repository } from '../src/storage'

test('未开启 TLS 时不读证书，开启时校验完整配置并解析相对路径', async () => {
  expect(readGameTls(false, '', '', '/missing')).toBeUndefined()
  expect(() => readGameTls(true, '', '', '/missing')).toThrow('GAME_TLS_CERT')
  const directory = await mkdtemp(resolve(tmpdir(), 'lights-tls-'))
  try {
    await writeFile(resolve(directory, 'cert.pem'), 'certificate')
    await writeFile(resolve(directory, 'key.pem'), 'private-key')
    expect(readGameTls(true, 'cert.pem', 'key.pem', directory)).toEqual({ cert: 'certificate', key: 'private-key' })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('游戏后端原生 HTTPS 可以监听并提供健康检查', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'lights-https-'))
  let app: Awaited<ReturnType<typeof createApp>>['app'] | undefined
  try {
    const cert = resolve(directory, 'cert.pem'),
      key = resolve(directory, 'key.pem')
    const openssl = resolveOpenSsl()
    execFileSync(
      openssl,
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-subj',
        '/CN=localhost',
        '-addext',
        'subjectAltName=DNS:localhost,IP:127.0.0.1',
        '-keyout',
        key,
        '-out',
        cert,
      ],
      { windowsHide: true, stdio: 'ignore', timeout: 15000 }
    )
    let closed = false
    const repo = {
      kind: 'postgres',
      async close() {
        closed = true
      },
    } as unknown as Repository
    const result = await createApp({ ...getConfig(), tls: readGameTls(true, cert, key, directory) }, repo)
    app = result.app
    await app.listen({ host: '127.0.0.1', port: 0 })
    const address = app.server.address() as { port: number }
    // 将本次生成的证书作为受信任 CA，保留主机名和证书校验。
    const { request } = await import('node:https')
    const health = await new Promise<{ status: number; body: string }>((done, reject) => {
      const call = request(
        `https://127.0.0.1:${address.port}/api/health`,
        { ca: readGameTls(true, cert, key, directory)!.cert },
        (response) => {
          let body = ''
          response.setEncoding('utf8')
          response.on('data', (chunk) => {
            body += chunk
          })
          response.on('end', () => done({ status: response.statusCode!, body }))
        }
      )
      call.on('error', reject)
      call.end()
    })
    expect(health.status).toBe(200)
    expect(JSON.parse(health.body).ok).toBe(true)
    await app.close()
    app = undefined
    expect(closed).toBe(true)
  } finally {
    await app?.close()
    await rm(directory, { recursive: true, force: true })
  }
})
