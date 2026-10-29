import { type Page, expect, request, test } from '@playwright/test'

import { solve } from '../../apps/server/src/board'

type FixtureWindow = Window & { sdkFixture: { loaded(): number; calls: string[] } }

function game(page: Page) {
  return page.frameLocator('#game')
}
async function open(page: Page, player = 'alice', room?: string, avatarsWork = true) {
  await page.route('https://avatars.test/**', (route) =>
    avatarsWork
      ? route.fulfill({
          contentType: 'image/svg+xml',
          body: '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><circle cx="24" cy="24" r="24" fill="#68a050"/></svg>',
        })
      : route.abort()
  )
  await page.goto(`https://localhost:5190/?player=${player}${room ? `&room=${room}` : ''}`)
  await expect(game(page).getByTestId('current-user-name')).toHaveText(
    player === 'bob' ? '模拟玩家小林' : '模拟玩家阿青'
  )
  await expect(game(page).getByText('已连接', { exact: true })).toBeVisible()
  await expect(game(page).getByTestId('nickname')).toHaveCount(0)
}
async function login(page: Page) {
  await game(page).getByTestId('kook-login').click()
  await expect(game(page).getByText('已连接', { exact: true })).toBeVisible()
}

test('SDK ready 自动授权一次，取消后可手动重试，权限与撤销继续生效', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.route('https://avatars.test/**', (route) =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"/>',
    })
  )
  await page.goto('https://localhost:5190/?defer-bootstrap')
  await page.getByRole('button', { name: '取消下次授权' }).click()
  await page.evaluate(() =>
    (window as unknown as { sdkFixture: { resumeBootstrap(): void } }).sdkFixture.resumeBootstrap()
  )
  await expect(game(page).getByRole('status')).toContainText('已取消授权')
  await expect(game(page).getByTestId('kook-login')).toBeEnabled()
  expect(
    await page.evaluate(
      () => (window as FixtureWindow).sdkFixture.calls.filter((value) => value === 'session.get').length
    )
  ).toBe(1)
  await expect(game(page).getByTestId('nickname')).toHaveCount(0)
  await login(page)
  await game(page).locator('.test-panel summary').click()
  await expect(game(page).getByRole('button', { name: '读取好友与私聊', exact: true })).toBeDisabled()
  await game(page).getByRole('button', { name: '授权好友与私聊', exact: true }).click()
  await expect(game(page).getByTestId('sdk-scopes')).toContainText('friends.dms.read')
  await game(page).getByRole('button', { name: '读取好友与私聊', exact: true }).click()
  await expect(game(page).getByTestId('sdk-result')).toContainText('模拟好友第一页')
  await game(page).getByRole('button', { name: '读取下一页', exact: true }).click()
  await expect(game(page).getByTestId('sdk-result')).toContainText('模拟好友第二页')
  await game(page).getByRole('button', { name: '授权频道成员', exact: true }).click()
  await game(page).getByRole('button', { name: '读取频道成员', exact: true }).click()
  await expect(game(page).getByTestId('sdk-result')).toContainText('模拟频道成员')
  await game(page).getByRole('button', { name: '读取实例参与者', exact: true }).click()
  await expect(game(page).getByTestId('sdk-result')).toContainText('模拟玩家阿青')
  await page.getByRole('button', { name: '参与者变化', exact: true }).press('Enter')
  await expect(game(page).getByTestId('sdk-participants-revision')).toHaveText('2')
  await game(page).getByRole('button', { name: '查询官方服务器', exact: true }).click()
  await expect(game(page).getByTestId('sdk-result')).toContainText('模拟官方服务器')
  await game(page).getByRole('button', { name: '打开官方服务器', exact: true }).click()
  await expect(game(page).getByTestId('sdk-result')).toContainText('cancelled')
  await page.getByRole('button', { name: '撤销授权', exact: true }).press('Enter')
  await expect(game(page).getByTestId('kook-login')).toBeVisible()
  await expect(game(page).getByTestId('sdk-scopes')).toHaveText('无')
  await expect(game(page).getByTestId('kook-login')).toBeDisabled()
  await open(page)
  await game(page).getByTestId('create-room').click()
  await expect(game(page).getByTestId('active-room-code')).toBeVisible()
  await game(page).getByRole('button', { name: '我准备好了', exact: true }).click()
  await expect(game(page).getByTestId('start-round')).toBeEnabled()
  await game(page).getByRole('button', { name: '退出登录', exact: true }).press('Enter')
  await expect(game(page).getByTestId('kook-login')).toBeEnabled()
  expect(errors).toEqual([])
})

test('two SDK players exchange code, invite, cooperate and recover the scoped connection', async ({
  browser,
}, testInfo) => {
  const aContext = await browser.newContext({ ignoreHTTPSErrors: true })
  const bContext = await browser.newContext({ ignoreHTTPSErrors: true })
  const a = await aContext.newPage()
  const b = await bContext.newPage()
  try {
    await open(a)
    await game(a).getByTestId('create-room').click()
    const id = await game(a).getByTestId('active-room-code').innerText()
    await game(a).getByRole('button', { name: '邀请好友', exact: true }).click()
    await expect(a.locator('#host-status')).toContainText(id)
    await expect(game(a).getByRole('status')).toContainText('已发送给 1 位好友')
    await open(b, 'bob', id)
    await expect(game(b).getByTestId('active-room-code')).toHaveText(id)
    await expect(game(a).locator('.players')).toContainText('模拟玩家小林')
    await expect(game(a).locator('.players').getByRole('img', { name: '模拟玩家阿青的 KOOK 头像' })).toHaveAttribute(
      'src',
      'https://avatars.test/alice.svg'
    )
    await expect(game(a).locator('.players').getByRole('img', { name: '模拟玩家小林的 KOOK 头像' })).toHaveAttribute(
      'src',
      'https://avatars.test/bob.svg'
    )
    await expect(game(b).locator('.players').getByRole('img', { name: '模拟玩家阿青的 KOOK 头像' })).toBeVisible()
    await expect
      .poll(() =>
        game(a)
          .locator('.players img')
          .evaluateAll((images) =>
            images.every(
              (image) => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0
            )
          )
      )
      .toBe(true)
    await game(a).getByRole('button', { name: '我准备好了', exact: true }).click()
    await game(b).getByRole('button', { name: '我准备好了', exact: true }).click()
    await expect(game(a).getByTestId('start-round')).toBeEnabled()
    await game(a).getByTestId('start-round').click()
    const frameA = a.frames().find((frame) => frame.name() === 'game')!
    const snapshot = await frameA.evaluate(async () => (await fetch('/api/session')).json())
    const cells = solve(snapshot.room.round.board)
    for (let index = 0; index < cells.length; index++) {
      await game(index % 2 ? b : a)
        .getByTestId(`cell-${cells[index]}`)
        .click()
      await expect
        .poll(() => frameA.evaluate(async () => (await (await fetch('/api/session')).json()).room.round.moves))
        .toBe(index + 1)
    }
    await expect(game(a).getByTestId('finished')).toContainText('记录已保存')
    await expect(game(b).getByTestId('finished')).toContainText('协作成功')
    await a.getByRole('button', { name: '断线恢复', exact: true }).press('Enter')
    await game(a).locator('.test-panel summary').click()
    await expect(game(a).getByTestId('sdk-state')).toContainText('epoch 2', { timeout: 20000 })
    await expect(game(a).getByText('已连接', { exact: true })).toBeVisible()
    await expect(game(a).getByTestId('active-room-code')).toHaveText(id)
    await frameA.evaluate(() => window.scrollTo(0, 0))
    await a.screenshot({ path: testInfo.outputPath('sdk-desktop.png'), fullPage: true })
    await b.setViewportSize({ width: 430, height: 900 })
    await b.screenshot({ path: testInfo.outputPath('sdk-narrow.png'), fullPage: true })
    await a.getByRole('button', { name: '结束实例', exact: true }).press('Enter')
    await expect(game(a).getByTestId('kook-login')).toBeDisabled()
    await expect(game(a).getByTestId('sdk-state')).toContainText('closed')
  } finally {
    await aContext.close()
    await bContext.close()
  }
})

test('KOOK core lifecycle requests missed bootstrap, loads without OAuth and stops after host exit', async ({
  page,
}) => {
  await page.clock.install()
  await page.route('**/api/health', async (route) => {
    const response = await route.fetch()
    // 模拟 iframe load 已投递、游戏尚在等 health 的真实启动顺序。
    await new Promise((resolve) => setTimeout(resolve, 300))
    await route.fulfill({ response })
  })
  await page.goto('https://localhost:5190/?core')
  await expect(game(page).getByText('当前 KOOK 宿主尚未开放账号授权，请等待平台开放后登录。')).toBeVisible()
  await expect(game(page).getByTestId('kook-login')).toBeDisabled()
  await expect.poll(() => page.evaluate(() => (window as FixtureWindow).sdkFixture.loaded())).toBe(1)
  function fixture() {
    return page.evaluate(() => {
      const value = (
        window as unknown as { sdkFixture: { bootstrapRequests(): number; probes(): number; calls: string[] } }
      ).sdkFixture
      return { requests: value.bootstrapRequests(), probes: value.probes(), calls: value.calls }
    })
  }
  expect((await fixture()).requests).toBeGreaterThan(0)
  expect((await fixture()).calls).not.toContain('session.get')
  await page.clock.runFor(15000)
  await expect.poll(async () => (await fixture()).probes).toBeGreaterThan(0)
  await page.getByRole('button', { name: '结束实例', exact: true }).click()
  await expect(game(page).getByTestId('kook-login')).toBeDisabled()
  await expect(game(page).getByRole('status')).toContainText('请从宿主重新打开')
  const stopped = (await fixture()).probes
  await page.clock.runFor(30000)
  expect((await fixture()).probes).toBe(stopped)
})

test('game rejects bootstrap from itself, mismatched host origin and malformed binding', async ({ page }) => {
  await page.goto('https://localhost:5190/?defer-bootstrap')
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as unknown as { sdkFixture: { bootstrapRequests(): number } }).sdkFixture.bootstrapRequests()
      )
    )
    .toBeGreaterThan(0)
  const frame = page.frames().find((value) => value.name() === 'game')!
  await frame.evaluate(() =>
    window.postMessage(
      {
        type: 'KOOK_MINI_GAME_BOOTSTRAP',
        bootstrap: { hostOrigin: 'https://localhost:5190', sessionId: 'forged', generation: 1 },
      },
      location.origin
    )
  )
  await page.evaluate(() => {
    const target = document.querySelector<HTMLIFrameElement>('#game')!.contentWindow!
    target.postMessage(
      {
        type: 'KOOK_MINI_GAME_BOOTSTRAP',
        bootstrap: { hostOrigin: 'https://untrusted.example', sessionId: 'forged', generation: 1 },
      },
      'https://127.0.0.1:5190'
    )
    target.postMessage(
      { type: 'KOOK_MINI_GAME_BOOTSTRAP', bootstrap: { hostOrigin: location.origin, sessionId: '', generation: -1 } },
      'https://127.0.0.1:5190'
    )
  })
  await page.waitForTimeout(100)
  expect(await page.evaluate(() => (window as FixtureWindow).sdkFixture.calls)).not.toContain('ready')
  await page.evaluate(() =>
    (window as unknown as { sdkFixture: { resumeBootstrap(): void } }).sdkFixture.resumeBootstrap()
  )
  await expect(game(page).getByTestId('current-user-name')).toHaveText('模拟玩家阿青')
  await expect.poll(() => page.evaluate(() => (window as FixtureWindow).sdkFixture.loaded())).toBe(1)
})

test('Cookie 全部不可用时仍可完成原授权协议、协作通关、撤销和退出登录', async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true })
  const upstream = await request.newContext({ ignoreHTTPSErrors: true })
  let bearerRequests = 0
  const page = await context.newPage()
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  try {
    await context.route('**/*', async (route) => {
      if (!route.request().url().startsWith('https://127.0.0.1:5190/api/')) return route.continue()
      const headers = { ...route.request().headers() }
      expect(Boolean(headers.cookie)).toBe(false)
      if (headers.authorization?.startsWith('Bearer ')) bearerRequests++
      // 独立请求上下文避免 route.fetch 将响应 Cookie 写入被测浏览器。
      const response = await upstream.fetch(route.request().url(), {
        method: route.request().method(),
        headers: { ...headers, cookie: '' },
        data: route.request().postDataBuffer() ?? undefined,
      })
      const responseHeaders = { ...response.headers() }
      delete responseHeaders['set-cookie']
      await route.fulfill({ status: response.status(), body: await response.body(), headers: responseHeaders })
    })
    await open(page)
    await game(page).getByTestId('create-room').click()
    await expect(game(page).getByTestId('active-room-code')).toBeVisible()
    await game(page).getByRole('button', { name: '我准备好了', exact: true }).click()
    await game(page).getByTestId('start-round').click()
    await expect(game(page).getByTestId('board')).not.toHaveClass(/inactive/)
    const frame = page.frames().find((value) => value.name() === 'game')!
    const board = await frame
      .locator('[data-testid^="cell-"]')
      .evaluateAll((cells) => cells.map((cell) => cell.classList.contains('on')))
    let moves = 0
    for (const cell of solve(board)) {
      await game(page).getByTestId(`cell-${cell}`).click()
      // 等待真实 WebSocket 应答后再进行下一次操作。
      await expect(
        game(page).locator('.session-stats > div').filter({ hasText: '操作次数' }).locator('strong')
      ).toHaveText(String(++moves))
    }
    await expect(game(page).getByTestId('finished')).toContainText('记录已保存')
    const gameCookies = (await context.cookies()).filter((cookie) => cookie.domain === '127.0.0.1')
    expect(gameCookies.length).toBe(0)
    expect(bearerRequests).toBeGreaterThan(1)
    await game(page).getByRole('button', { name: '退出登录', exact: true }).click()
    await expect(game(page).getByTestId('kook-login')).toBeEnabled()
    await login(page)
    await page.getByRole('button', { name: '撤销授权', exact: true }).click()
    await expect(game(page).getByTestId('kook-login')).toBeDisabled()
    expect(errors).toEqual([])
  } finally {
    await context.close()
    await upstream.dispose()
  }
})

test('自动登录使用 OAuth 用户名，头像加载失败回退且主动注销后不重复弹授权', async ({ page }) => {
  await open(page, 'alice', undefined, false)
  await expect(game(page).getByTestId('current-user-name')).toHaveText('模拟玩家阿青')
  await expect(game(page).locator('header img')).toHaveCount(0)
  await expect(game(page).locator('header .user-avatar')).toContainText('模')
  const before = await page.evaluate(
    () => (window as FixtureWindow).sdkFixture.calls.filter((value) => value === 'session.get').length
  )
  expect(before).toBe(1)
  await game(page).getByRole('button', { name: '退出登录', exact: true }).click()
  await expect(game(page).getByTestId('kook-login')).toBeEnabled()
  expect(
    await page.evaluate(
      () => (window as FixtureWindow).sdkFixture.calls.filter((value) => value === 'session.get').length
    )
  ).toBe(before)
})

test('邀请房间满员或结束后返回主页，只自动加入一次，不重新创建房间', async ({ page }) => {
  for (const [room, code, message] of [
    ['FULL22', 'ROOM_FULL', '朋友的房间已满，已返回主页'],
    ['GONE22', 'ROOM_NOT_FOUND', '朋友的房间已结束，已返回主页'],
  ]) {
    let joins = 0
    await page.route('**/api/rooms/' + room + '/join', (route) => {
      joins++
      return route.fulfill({
        status: code === 'ROOM_FULL' ? 409 : 404,
        contentType: 'application/json',
        body: JSON.stringify({ code, message: '测试拒绝加入' }),
      })
    })
    await open(page, 'bob', room)
    await expect(game(page).getByRole('status')).toContainText(message)
    await expect(game(page).getByTestId('create-room')).toBeEnabled()
    await expect(game(page).getByTestId('active-room-code')).toHaveCount(0)
    await expect(game(page).getByTestId('room-code')).toHaveValue('')
    await game(page).getByTestId('room-code').fill('ABC234')
    expect(joins).toBe(1)
  }
})

test('接受邀请加入后主动离开，不因同一启动的roomId再次自动加入', async ({ browser }) => {
  const contexts = await Promise.all([
    browser.newContext({ ignoreHTTPSErrors: true }),
    browser.newContext({ ignoreHTTPSErrors: true }),
  ])
  try {
    const a = await contexts[0].newPage(),
      b = await contexts[1].newPage()
    await open(a)
    await game(a).getByTestId('create-room').click()
    const room = await game(a).getByTestId('active-room-code').innerText()
    let joins = 0
    await b.route('**/api/rooms/' + room + '/join', (route) => {
      joins++
      return route.continue()
    })
    await open(b, 'bob', room)
    await expect(game(b).getByTestId('active-room-code')).toHaveText(room)
    await game(b).getByRole('button', { name: '离开房间', exact: true }).click()
    await expect(game(b).getByTestId('create-room')).toBeVisible()
    await game(b).getByTestId('room-code').fill('ABC234')
    expect(joins).toBe(1)
  } finally {
    await Promise.all(contexts.map((context) => context.close()))
  }
})

test('自动入房采用游戏后端context的room_id，忽略宿主启动数据中伪造的房间', async ({ browser }) => {
  const contexts = await Promise.all([
    browser.newContext({ ignoreHTTPSErrors: true }),
    browser.newContext({ ignoreHTTPSErrors: true }),
  ])
  try {
    const a = await contexts[0].newPage(),
      b = await contexts[1].newPage()
    await open(a)
    const leave = game(a).getByRole('button', { name: '离开房间', exact: true })
    if (await leave.isVisible()) await leave.click()
    await game(a).getByTestId('create-room').click()
    const room = await game(a).getByTestId('active-room-code').innerText()
    let forgedJoins = 0
    b.on('request', (request) => {
      if (request.url().includes('/rooms/FAKE22/join')) forgedJoins++
    })
    await b.goto('https://localhost:5190/?player=bob&room=' + room + '&spoof-room=FAKE22')
    await expect(game(b).getByTestId('active-room-code')).toHaveText(room)
    expect(forgedJoins).toBe(0)
    await expect(game(a).locator('.players')).toContainText('模拟玩家小林')
    await game(b).getByRole('button', { name: '退出登录', exact: true }).click()
    await game(a).getByRole('button', { name: '退出登录', exact: true }).click()
  } finally {
    await Promise.all(contexts.map((context) => context.close()))
  }
})

test('context没有邀请房间时留在主页，不用SDK的roomId代替', async ({ page }) => {
  let joins = 0
  page.on('request', (request) => {
    if (/\/rooms\/[^/]+\/join/.test(request.url())) joins++
  })
  await page.goto('https://localhost:5190/?player=bob&spoof-room=FAKE22')
  await expect(game(page).getByTestId('current-user-name')).toHaveText('模拟玩家小林')
  await expect(game(page).getByTestId('create-room')).toBeEnabled()
  await expect(game(page).getByTestId('room-code')).toHaveValue('')
  expect(joins).toBe(0)
})
