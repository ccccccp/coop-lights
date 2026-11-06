import { createServer } from 'node:http'

import { expect, test } from '@playwright/test'

const scriptServer = createServer((_request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/javascript', 'Access-Control-Allow-Origin': '*' })
  response.end("try { parent.document.body.dataset.untrustedScript = 'executed' } catch {}")
})
let scriptUrl = ''
test.beforeAll(async () => {
  await new Promise<void>((resolve) => scriptServer.listen(0, '127.0.0.1', resolve))
  const address = scriptServer.address()
  if (!address || typeof address === 'string') throw new Error('测试脚本服务未监听')
  scriptUrl = `http://127.0.0.1:${address.port}/test.js`
})
test.afterAll(async () => {
  scriptServer.closeAllConnections()
  await new Promise<void>((resolve) => scriptServer.close(() => resolve()))
})

test('网络测试页区分收到 HTTP 错误响应与网络失败，图片和隔离脚本可以加载', async ({ page }) => {
  await page.route('https://resources.example/test.png', (route) =>
    route.fulfill({
      contentType: 'image/png',
      body: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
        'base64'
      ),
    })
  )
  await page.route('https://api.example/forbidden', (route) => {
    expect(route.request().headers().authorization).toBeUndefined()
    expect(route.request().headers().cookie).toBeUndefined()
    return route.fulfill({
      status: 403,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: '{"error":"controlled"}',
    })
  })
  await page.route('https://api.example/blocked', (route) => route.abort('blockedbyclient'))
  await page.goto('/network-test')
  await expect(page.getByRole('heading', { name: '网络拦截测试', exact: true })).toBeVisible()
  await expect(page.getByText('独立模式 / 浏览器', { exact: true })).toBeVisible()
  await page.getByLabel('图片地址', { exact: true }).fill('https://resources.example/test.png')
  await page.getByRole('button', { name: '测试图片', exact: true }).click()
  await expect(page.getByTestId('probe-result-image')).toContainText('图片已加载，尺寸 1 × 1')
  await page.getByLabel('JS 文件地址', { exact: true }).fill(scriptUrl)
  await page.getByRole('button', { name: '测试JS 文件', exact: true }).click()
  await expect(page.getByTestId('probe-result-script')).toContainText('JS 文件已加载')
  expect(await page.locator('body').getAttribute('data-untrusted-script')).toBeNull()
  await expect(page.locator('iframe')).toHaveCount(0)
  await page.getByLabel('按 ES Module 加载（跨域需要 CORS）').check()
  await page.getByRole('button', { name: '测试JS 文件', exact: true }).click()
  await expect(page.getByTestId('probe-result-script')).toHaveCount(2)
  await expect(page.getByTestId('probe-result-script').first()).toContainText('JS 文件已加载')
  await page.getByLabel('接口请求地址', { exact: true }).fill('https://api.example/forbidden')
  await page.getByRole('button', { name: '测试接口请求', exact: true }).click()
  await expect(page.getByTestId('probe-result-fetch').first()).toContainText('HTTP 403')
  await expect(page.getByTestId('probe-result-fetch').first()).toContainText('已收到响应')
  await page.getByLabel('接口请求地址', { exact: true }).fill('https://api.example/blocked')
  await page.getByRole('button', { name: '测试接口请求', exact: true }).click()
  await expect(page.getByTestId('probe-result-fetch').first()).toContainText('失败（可能被拦截）')
  await page.getByLabel('图片地址', { exact: true }).fill('javascript:alert(1)')
  await page.getByRole('button', { name: '测试图片', exact: true }).click()
  await expect(page.getByTestId('probe-result-image').first()).toContainText('地址无效')
  await page.screenshot({ path: 'test-results/network-test-desktop.png', fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: 'test-results/network-test-narrow.png', fullPage: true })
})

test('测试支持超时、取消与 WebSocket，游戏内入口不刷新页面，关闭会清理隔离脚本', async ({ page }) => {
  await page.route('https://api.example/hang', () => {})
  await page.routeWebSocket('wss://socket.example/test', () => {})
  await page.goto('/')
  await page.getByRole('button', { name: '网络拦截测试', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '网络拦截测试', exact: true })
  await expect(dialog).toBeVisible()
  expect(new URL(page.url()).pathname).toBe('/')
  await dialog.getByLabel('等待超时').selectOption('3000')
  await dialog.getByLabel('接口请求地址').fill('https://api.example/hang')
  await dialog.getByRole('button', { name: '测试接口请求', exact: true }).click()
  await expect(dialog.getByTestId('probe-result-fetch').first()).toContainText('等待超时', { timeout: 6000 })
  await dialog.getByRole('button', { name: '测试接口请求', exact: true }).click()
  await dialog.getByRole('button', { name: '取消进行中的测试' }).click()
  await expect(dialog.getByTestId('probe-result-fetch').first()).toContainText('已取消')
  await dialog.getByLabel('WebSocket 地址').fill('wss://socket.example/test')
  await dialog.getByRole('button', { name: '测试WebSocket', exact: true }).click()
  await expect(dialog.getByTestId('probe-result-websocket')).toContainText('WebSocket 握手成功')
  await dialog.getByLabel('JS 文件地址').fill('https://api.example/hang')
  await dialog.getByRole('button', { name: '测试JS 文件', exact: true }).click()
  await expect(page.locator('iframe')).toHaveCount(1)
  await dialog.getByRole('button', { name: '返回游戏', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.locator('iframe')).toHaveCount(0)
  await expect(page.getByTestId('nickname')).toBeVisible()
})
