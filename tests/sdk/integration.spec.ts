import { type Page, expect, request, test } from '@playwright/test'

import { solve } from '../../apps/server/src/board'

type FixtureWindow = Window & {
  sdkFixture: {
    loaded(): number
    calls: string[]
    leaveInputs: Record<string, unknown>[]
    fullscreenInputs: Record<string, unknown>[]
    externalLinkInputs: Record<string, unknown>[]
  }
}

test.beforeEach(async ({ request }) => {
  await request.post('/mock/reset')
})

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
  await expect(game(page).getByRole('button', { name: '读取好友与私聊', exact: true })).toBeEnabled()
  await expect(game(page).getByTestId('sdk-scopes')).toContainText('get_user_info')
  await game(page).getByRole('button', { name: '读取好友与私聊', exact: true }).click()
  await expect(game(page).getByTestId('sdk-result')).toContainText('模拟好友第一页')
  await game(page).getByRole('button', { name: '读取下一页', exact: true }).click()
  await expect(game(page).getByTestId('sdk-result')).toContainText('模拟好友第二页')
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
    await expect(a.locator('#host-status')).toContainText('频道游戏邀请')
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
    await game(a).getByRole('button', { name: '排行榜', exact: true }).click()
    const ranking = game(a).getByRole('dialog', { name: '通关次数排行榜' })
    await expect(ranking.getByRole('list', { name: '通关排名' })).toBeVisible()
    await expect(ranking.getByRole('img', { name: '模拟玩家阿青的 KOOK 头像' })).toBeVisible()
    await expect(ranking.getByRole('img', { name: '模拟玩家小林的 KOOK 头像' })).toBeVisible()
    await expect(ranking.locator('.is-me')).toContainText('模拟玩家阿青')
    await expect(ranking.locator('.is-me .leaderboard-score')).toHaveText(/\d+ 次/)
    await a.screenshot({ path: testInfo.outputPath('leaderboard-desktop.png'), fullPage: true })
    await a.setViewportSize({ width: 430, height: 900 })
    await expect(ranking).toBeVisible()
    await a.screenshot({ path: testInfo.outputPath('leaderboard-narrow.png'), fullPage: true })
    await ranking.getByRole('button', { name: '关闭排行榜' }).press('Escape')
    await expect(ranking).not.toBeVisible()
    await expect(game(a).getByRole('button', { name: '排行榜', exact: true })).toBeFocused()
    await a.setViewportSize({ width: 1440, height: 1100 })
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

for (const [query, channel] of [
  ['text', true],
  ['', true],
  ['dm', false],
  ['app-dm', false],
] as const) {
  test(`邀请好友按${query || 'voice'}上下文选择频道大厅邀请或固定房间邀请`, async ({ page }) => {
    await page.route('https://avatars.test/**', (route) => route.abort())
    await page.goto(`https://localhost:5190/?player=alice&${query}`)
    await game(page).getByTestId('create-room').click()
    const roomId = await game(page).getByTestId('active-room-code').innerText()
    await game(page).getByRole('button', { name: '邀请好友', exact: true }).click()
    const inputs = await page.evaluate(
      () => (window as unknown as { sdkFixture: { inviteInputs: unknown[] } }).sdkFixture.inviteInputs
    )
    expect(inputs).toEqual([channel ? {} : { roomId }])
    await expect(game(page).getByRole('status')).toContainText(channel ? '频道大厅选择房间' : '将进入当前房间')
  })
}

for (const mode of ['copy-invite', 'cancel-invite', 'failed-invite']) {
  test(`频道邀请${mode}不提示直接加入当前房间`, async ({ page }) => {
    await page.goto(`https://localhost:5190/?player=alice&text&${mode}`)
    await game(page).getByTestId('create-room').click()
    await game(page).getByRole('button', { name: '邀请好友', exact: true }).click()
    if (mode === 'cancel-invite') await expect(game(page).getByRole('status')).toHaveCount(0)
    else
      await expect(game(page).getByRole('status')).toContainText(
        mode === 'copy-invite' ? '频道游戏邀请链接已复制' : '发送失败'
      )
    await expect(game(page).getByText('接受后将进入当前房间', { exact: false })).toHaveCount(0)
  })
}

test('排行榜加载失败可重试，空榜提示、头像回退和关闭后重新打开均正常', async ({ page }) => {
  let calls = 0
  await page.route('**/api/leaderboard', (route) => {
    calls++
    return route.fulfill({
      status: calls === 1 ? 503 : 200,
      contentType: 'application/json',
      body: JSON.stringify(
        calls === 1
          ? { code: 'UNAVAILABLE', message: '排行榜暂时不可用' }
          : calls === 2
            ? { items: [], updatedAt: Date.now() }
            : {
                items: [
                  {
                    id: 'someone',
                    rank: 1,
                    nickname: '小伙伴',
                    avatarUrl: 'https://avatars.test/unavailable.svg',
                    completedRounds: 12,
                  },
                ],
                updatedAt: Date.now(),
              }
      ),
    })
  })
  await open(page, 'alice', undefined, false)
  const button = game(page).getByRole('button', { name: '排行榜', exact: true })
  await button.click()
  const dialog = game(page).getByRole('dialog', { name: '通关次数排行榜' })
  await expect(dialog.getByRole('alert')).toContainText('排行榜暂时不可用')
  await dialog.getByRole('button', { name: '重试', exact: true }).click()
  await expect(dialog).toContainText('还没有通关记录')
  await dialog.getByRole('button', { name: '关闭排行榜' }).click()
  await button.click()
  await expect(dialog.getByRole('listitem')).toContainText('小伙伴')
  await expect(dialog.getByRole('listitem')).toContainText('12 次')
  await expect(dialog.getByRole('img')).toHaveCount(0)
  await expect(dialog.getByLabel('小伙伴的头像', { exact: true })).toHaveText('小')
  await dialog.getByRole('button', { name: '刷新排行榜' }).click()
  await expect.poll(() => calls).toBe(4)
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

test('SDK 忽略游戏自身发送的启动消息，随后正常接收宿主启动', async ({ page }) => {
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
  await page.waitForTimeout(100)
  expect(await page.evaluate(() => (window as FixtureWindow).sdkFixture.calls)).not.toContain('ready')
  await page.evaluate(() =>
    (window as unknown as { sdkFixture: { resumeBootstrap(): void } }).sdkFixture.resumeBootstrap()
  )
  await expect(game(page).getByTestId('current-user-name')).toHaveText('模拟玩家阿青')
  await expect.poll(() => page.evaluate(() => (window as FixtureWindow).sdkFixture.loaded())).toBe(1)
})

for (const invalid of ['origin', 'binding'] as const) {
  test(`SDK 拒绝可信宿主的错误启动参数（${invalid}），重新打开后可正常登录`, async ({ page }) => {
    await page.goto('https://localhost:5190/?defer-bootstrap')
    await expect
      .poll(() =>
        page.evaluate(() =>
          (window as unknown as { sdkFixture: { bootstrapRequests(): number } }).sdkFixture.bootstrapRequests()
        )
      )
      .toBeGreaterThan(0)
    await page.evaluate((invalid) => {
      const bootstrap =
        invalid === 'origin'
          ? { hostOrigin: 'https://untrusted.example', sessionId: 'forged', generation: 1 }
          : { hostOrigin: location.origin, sessionId: '', generation: -1 }
      document
        .querySelector<HTMLIFrameElement>('#game')!
        .contentWindow!.postMessage({ type: 'KOOK_MINI_GAME_BOOTSTRAP', bootstrap }, 'https://127.0.0.1:5190')
    }, invalid)
    await expect(game(page).getByRole('status')).toContainText('INVALID_RESPONSE')
    await expect(game(page).getByTestId('kook-login')).toBeDisabled()
    expect(await page.evaluate(() => (window as FixtureWindow).sdkFixture.calls)).not.toContain('ready')
    expect(await page.evaluate(() => (window as FixtureWindow).sdkFixture.loaded())).toBe(0)
    await open(page)
    await expect.poll(() => page.evaluate(() => (window as FixtureWindow).sdkFixture.loaded())).toBe(1)
  })
}

test('网络测试面板沿用当前 SDK，独立测试页完成 ready 和加载上报且不自动授权', async ({ page }) => {
  await page.clock.install()
  await page.goto('https://localhost:5190/?core')
  await expect.poll(() => page.evaluate(() => (window as FixtureWindow).sdkFixture.loaded())).toBe(1)
  await game(page).getByRole('button', { name: '网络拦截测试', exact: true }).click()
  const panel = game(page).getByRole('dialog', { name: '网络拦截测试', exact: true })
  await panel.getByLabel('图片地址', { exact: true }).fill('https://resources.example/image.png')
  await page.clock.runFor(15000)
  await expect(panel).toBeVisible()
  await expect(panel.getByLabel('图片地址', { exact: true })).toHaveValue('https://resources.example/image.png')
  expect(
    await page.evaluate(() => (window as FixtureWindow).sdkFixture.calls.filter((method) => method === 'ready').length)
  ).toBe(1)
  await panel.getByRole('button', { name: '返回游戏', exact: true }).click()
  await page.evaluate(() => {
    document.querySelector<HTMLIFrameElement>('#game')!.src = 'https://127.0.0.1:5190/network-test'
  })
  await expect(game(page).getByRole('heading', { name: '网络拦截测试', exact: true })).toBeVisible()
  await expect.poll(() => page.evaluate(() => (window as FixtureWindow).sdkFixture.loaded())).toBe(2)
  expect(
    await page.evaluate(
      () => (window as FixtureWindow).sdkFixture.calls.filter((method) => method === 'session.get').length
    )
  ).toBe(0)
  await expect(game(page).getByText('KOOK · ready', { exact: true })).toBeVisible()
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
    await expect(game(page).getByTestId('room-code')).toHaveCount(0)
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
    await expect(game(b).getByTestId(`lobby-room-${room}`)).toBeVisible()
    await expect(game(b).getByTestId('create-room')).toBeDisabled()
    expect(joins).toBe(1)
  } finally {
    await Promise.all(contexts.map((context) => context.close()))
  }
})

test('自动入房采用context的room.room_id，忽略宿主启动数据中伪造的房间', async ({ browser }) => {
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
  await expect(game(page).getByTestId('room-code')).toHaveCount(0)
  expect(joins).toBe(0)
})

test('仅基本资料授权仍可登录，独立log页按最近3天倒序显示入参、响应和状态', async ({ page }) => {
  await page.goto('https://localhost:5190/?basic-only')
  await expect(game(page).getByTestId('current-user-name')).toHaveText('模拟玩家阿青')
  await page.goto('https://127.0.0.1:5190/log')
  await expect(page.getByRole('heading', { name: '接口调用日志' })).toBeVisible()
  const from = await page.getByLabel('开始时间').inputValue()
  expect(Math.abs(Date.now() - new Date(from).getTime() - 3 * 86400000)).toBeLessThan(10000)
  await page.getByLabel('日志访问密钥').fill('fixture-log-key')
  await page.getByLabel('接口来源').selectOption('kook')
  const response = page.waitForResponse((response) => response.url().includes('/api/logs?'))
  await page.getByRole('button', { name: '查询 / 刷新' }).click()
  const result = await (await response).json()
  expect(result.items.length).toBeGreaterThan(1)
  const times = result.items.map((item: { startedAt: number }) => item.startedAt)
  expect(times).toEqual([...times].sort((a, b) => b - a))
  const latest = result.items[0].requestId
  expect(
    result.items
      .filter((item: { requestId: string }) => item.requestId === latest)
      .map((item: { stage: string }) => item.stage)
      .sort()
  ).toEqual(['token', 'userinfo'])
  const row = page.locator('tbody tr').filter({ hasText: ' · token' }).first()
  await row.locator('summary').click()
  await expect(row).toContainText('200')
  await expect(row.locator('pre').first()).toContainText('[REDACTED]')
  await expect(row.locator('pre').nth(1)).toContainText('access_token')
  await expect(row.locator('pre').nth(1)).toContainText('[REDACTED]')
})

test('频道大厅实时发现同上下文房间、阻止重复建房，其他上下文仅可查看，普通重开先显示大厅', async ({
  browser,
}, testInfo) => {
  const contexts = await Promise.all(Array.from({ length: 3 }, () => browser.newContext({ ignoreHTTPSErrors: true })))
  const pages = await Promise.all(contexts.map((c) => c.newPage()))
  const [a, b, c] = pages
  const errors: string[] = []
  for (const page of pages) {
    page.on('pageerror', (error) => errors.push(error.message))
    await page.route('https://avatars.test/**', (route) => route.abort())
  }
  try {
    await a.goto('https://localhost:5190/?player=alice&text&channel=team-text')
    await b.goto('https://localhost:5190/?player=bob&text&channel=team-text')
    await c.goto('https://localhost:5190/?player=carol&channel=team-voice&instance=other-instance')
    for (const page of pages) await expect(game(page).getByTestId('create-room')).toBeEnabled()
    await game(a).getByTestId('create-room').click()
    const id = await game(a).getByTestId('active-room-code').innerText()
    const bCard = game(b).getByTestId(`lobby-room-${id}`)
    const cCard = game(c).getByTestId(`lobby-room-${id}`)
    await expect(bCard).toContainText('1 / 4 人')
    await expect(bCard.getByRole('button', { name: '加入房间 →' })).toBeEnabled()
    await expect(game(b).getByTestId('create-room')).toBeDisabled()
    await expect(cCard).toContainText('仅可查看')
    await expect(cCard.getByRole('button')).toHaveCount(0)
    await game(a).getByRole('button', { name: '我准备好了', exact: true }).click()
    await expect(bCard).toContainText('已准备')
    await game(a).getByTestId('start-round').click()
    await expect(bCard).toContainText('点灯中')
    await game(c).getByTestId('create-room').click()
    const otherId = await game(c).getByTestId('active-room-code').innerText()
    await expect(game(b).getByTestId(`lobby-room-${otherId}`)).toContainText('仅可查看')
    await b.screenshot({ path: testInfo.outputPath('context-lobby-desktop.png'), fullPage: true })
    await b.setViewportSize({ width: 430, height: 1000 })
    await b.screenshot({ path: testInfo.outputPath('context-lobby-narrow.png'), fullPage: true })
    await bCard.getByRole('button', { name: '加入房间 →' }).click()
    await expect(game(b).getByTestId('active-room-code')).toHaveText(id)
    await a.reload()
    await expect(game(a).getByTestId('room-lobby')).toBeVisible()
    await expect(game(a).getByTestId(`lobby-room-${id}`)).toContainText('2 / 4 人')
    await game(a).locator('.lobby-membership').getByRole('button', { name: '返回房间 →' }).click()
    await expect(game(a).getByTestId('active-room-code')).toHaveText(id)
    await game(b).getByRole('button', { name: '离开房间', exact: true }).click()
    await expect(bCard).toContainText('1 / 4 人')
    await game(a).getByRole('button', { name: '离开房间', exact: true }).click()
    await expect(bCard).toHaveCount(0)
    await expect(game(b).getByTestId('create-room')).toBeEnabled()
    expect(errors).toEqual([])
  } finally {
    await Promise.all(contexts.map((c) => c.close()))
  }
})

test('邀请context失败保留基本登录并提示回主页，可在日志页看到失败状态及返回', async ({ page }) => {
  await page.route('**/api/kook/invite/resolve', (route) =>
    route.fulfill({
      status: 502,
      contentType: 'application/json',
      body: JSON.stringify({ code: 'PLATFORM_CONTEXT_INVALID', message: '测试实例不匹配' }),
    })
  )
  await page.goto('https://localhost:5190/?player=bob&room=ABC234')
  await expect(game(page).getByTestId('current-user-name')).toHaveText('模拟玩家小林')
  await expect(game(page).getByRole('status')).toContainText('已登录，暂时无法加入邀请房间')
  await expect(game(page).getByTestId('create-room')).toBeDisabled()
  await expect(game(page).getByTestId('room-lobby')).toBeVisible()
})

test('KOOK已确认受邀但未返回room_id时保留登录、提示缺房间，禁止猜测实例或会话编号入房', async ({ page }) => {
  await page.route('**/api/kook/invite/resolve', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        instanceId: 'fixture-instance',
        context: { type: 2, id: 'fixture-channel' },
        invitedRoomId: null,
      }),
    })
  )
  let joins = 0
  page.on('request', (request) => {
    if (/\/rooms\/[^/]+\/join/.test(request.url())) joins++
  })
  await page.goto('https://localhost:5190/?player=bob&room=ABC234')
  await expect(game(page).getByTestId('current-user-name')).toHaveText('模拟玩家小林')
  await expect(game(page).getByRole('status')).toContainText('KOOK邀请未返回点灯房间号')
  await expect(game(page).getByTestId('create-room')).toBeEnabled()
  expect(joins).toBe(0)
})

test('右上角离开游戏无需 OAuth，窄屏仍可操作且重复点击只提交一次', async ({ page }, testInfo) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('https://localhost:5190/?core')
  await expect(game(page).getByTestId('kook-login')).toBeDisabled()
  const leave = game(page).getByRole('button', { name: '离开游戏', exact: true })
  await expect(leave).toBeEnabled()
  await game(page)
    .locator('.topbar')
    .screenshot({ path: testInfo.outputPath('leave-button-desktop.png') })
  await page.setViewportSize({ width: 430, height: 900 })
  await expect(leave).toBeInViewport()
  await game(page)
    .locator('.topbar')
    .screenshot({ path: testInfo.outputPath('leave-button-narrow.png') })
  await leave.evaluate((button) => {
    const element = button as HTMLButtonElement
    element.click()
    element.click()
  })
  await expect(page.locator('#host-status')).toHaveText('小游戏已离开')
  await expect(leave).toBeDisabled()
  const fixture = await page.evaluate(() => ({
    calls: (window as FixtureWindow).sdkFixture.calls,
    inputs: (window as FixtureWindow).sdkFixture.leaveInputs,
  }))
  expect(fixture.calls.filter((method) => method === 'lifecycle.leave')).toHaveLength(1)
  expect(fixture.calls).not.toContain('session.get')
  expect(fixture.inputs).toEqual([{}])
  expect(errors).toEqual([])
})

test('先退出点灯房间再调用 SDK leave，退房或平台退出失败均可重试', async ({ page }) => {
  await page.goto('https://localhost:5190/?fail-leave-once')
  await game(page).getByTestId('create-room').click()
  await expect(game(page).getByTestId('active-room-code')).toBeVisible()
  const leave = game(page).getByRole('button', { name: '离开游戏', exact: true })
  let roomLeaves = 0
  await page.route('**/api/rooms/*/leave', (route) => {
    roomLeaves++
    return roomLeaves === 1
      ? route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ code: 'UNAVAILABLE', message: '退房暂时失败，请重试' }),
        })
      : route.continue()
  })
  await leave.click()
  await expect(game(page).getByRole('status')).toContainText('退房暂时失败')
  await expect(game(page).getByTestId('active-room-code')).toBeVisible()
  expect(await page.evaluate(() => (window as FixtureWindow).sdkFixture.leaveInputs)).toEqual([])
  await expect(leave).toBeEnabled()
  await leave.click()
  await expect(game(page).getByRole('status')).toContainText('SERVICE_UNAVAILABLE')
  await expect(leave).toBeEnabled()
  await expect(game(page).getByTestId('current-user-name')).toBeVisible()
  const frame = page.frames().find((value) => value.name() === 'game')!
  const session = await frame.evaluate(async () => (await fetch('/api/session')).json())
  expect(session.room).toBeNull()
  expect(await page.evaluate(() => (window as FixtureWindow).sdkFixture.leaveInputs)).toEqual([{}])
  await leave.click()
  await expect(page.locator('#host-status')).toHaveText('小游戏已离开')
  expect(await page.evaluate(() => (window as FixtureWindow).sdkFixture.leaveInputs)).toEqual([{}, {}])
  expect(roomLeaves).toBe(2)
})

test('旧宿主未声明 leave 能力时禁用离开游戏按钮', async ({ page }) => {
  await page.goto('https://localhost:5190/?core&no-leave')
  await expect(game(page).getByText('当前 KOOK 宿主尚未开放账号授权，请等待平台开放后登录。')).toBeVisible()
  const leave = game(page).getByRole('button', { name: '离开游戏', exact: true })
  await expect(leave).toBeDisabled()
  await expect(leave).toHaveAttribute('title', '当前 KOOK 暂不支持离开游戏')
  expect(await page.evaluate(() => (window as FixtureWindow).sdkFixture.leaveInputs)).toEqual([])
})

test('右上角全屏免OAuth且重复点击只提交一次，窄屏入口保持可见', async ({ page }, testInfo) => {
  await page.goto('https://localhost:5190/?core')
  const button = game(page).getByRole('button', { name: '全屏', exact: true })
  await expect(button).toBeEnabled()
  await game(page)
    .locator('.topbar')
    .screenshot({ path: testInfo.outputPath('fullscreen-desktop.png') })
  await page.setViewportSize({ width: 430, height: 900 })
  await expect(button).toBeInViewport()
  await game(page)
    .locator('.topbar')
    .screenshot({ path: testInfo.outputPath('fullscreen-narrow.png') })
  await button.click()
  await expect.poll(() => page.evaluate(() => document.fullscreenElement?.id)).toBe('game')
  await button.evaluate((button) => {
    const element = button as HTMLButtonElement
    element.click()
    element.click()
  })
  expect(await page.evaluate(() => (window as FixtureWindow).sdkFixture.fullscreenInputs)).toEqual([{}, {}])
  expect(await page.evaluate(() => (window as FixtureWindow).sdkFixture.calls)).not.toContain('session.get')
  await page.evaluate(() => document.exitFullscreen())
  await expect(button).toBeEnabled()
})

test('全屏失败后可以重试，旧宿主缺少能力时禁用入口', async ({ page }) => {
  await page.goto('https://localhost:5190/?core&fail-fullscreen-once')
  const button = game(page).getByRole('button', { name: '全屏', exact: true })
  await button.click()
  await expect(game(page).getByRole('status')).toContainText('USER_GESTURE_REQUIRED')
  await expect(button).toBeEnabled()
  expect(await page.evaluate(() => !!document.fullscreenElement)).toBe(false)
  await button.click()
  await expect.poll(() => page.evaluate(() => document.fullscreenElement?.id)).toBe('game')
  await page.evaluate(() => document.exitFullscreen())
  await page.goto('https://localhost:5190/?core&no-fullscreen')
  await expect(button).toBeDisabled()
  expect(await page.evaluate(() => (window as FixtureWindow).sdkFixture.fullscreenInputs)).toEqual([])
})

test('接口测试页可输入外链URL，沿用当前SDK、不导航游戏，失败和非法地址可重试', async ({ page }, testInfo) => {
  await page.goto('https://localhost:5190/?core&fail-external-once')
  await expect(game(page).getByTestId('kook-login')).toBeDisabled()
  await game(page).getByRole('button', { name: '网络拦截测试', exact: true }).click()
  const panel = game(page).getByRole('dialog', { name: '网络拦截测试', exact: true })
  const form = panel.getByRole('form', { name: '外链跳转测试' })
  const input = form.getByLabel('外链地址')
  const openLink = form.getByRole('button', { name: '打开外链', exact: true })
  await expect(openLink).toBeDisabled()
  await input.fill('javascript:alert(1)')
  await openLink.click()
  await expect(form.getByRole('alert')).toContainText('INVALID_ARGUMENT')
  expect(await page.evaluate(() => (window as FixtureWindow).sdkFixture.externalLinkInputs)).toEqual([])
  const url = 'https://game.example/help?room=one&source=kook#faq'
  await input.fill(url)
  await openLink.click()
  await expect(form.getByRole('alert')).toContainText('PERMISSION_DENIED')
  await expect(openLink).toBeEnabled()
  await page.waitForTimeout(1100)
  await openLink.click()
  await expect(form.getByRole('status')).toContainText('已请求 KOOK 打开外链')
  expect(await page.evaluate(() => (window as FixtureWindow).sdkFixture.externalLinkInputs)).toEqual([{ url }, { url }])
  expect(
    await page.evaluate(() => (window as FixtureWindow).sdkFixture.calls.filter((method) => method === 'ready'))
  ).toHaveLength(1)
  const frame = page.frames().find((value) => value.name() === 'game')!
  expect(frame.url()).not.toContain('game.example')
  await form.screenshot({ path: testInfo.outputPath('external-link-desktop.png') })
  await page.setViewportSize({ width: 430, height: 900 })
  await input.fill('https://game.example/help?screen=narrow#faq')
  await expect(input).toBeInViewport()
  await page.waitForTimeout(1100)
  await openLink.click()
  await expect(form.getByRole('status')).toContainText('已请求 KOOK 打开外链')
  expect(await frame.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await form.evaluate((element) => element.scrollIntoView({ block: 'center' }))
  await panel.screenshot({ path: testInfo.outputPath('external-link-narrow.png') })
})

test('独立测试页复用自身SDK的外链接口，旧宿主禁用外链且不直连打开', async ({ page }) => {
  await page.goto('https://localhost:5190/?core')
  await page.evaluate(() => {
    document.querySelector<HTMLIFrameElement>('#game')!.src = 'https://127.0.0.1:5190/network-test'
  })
  const form = game(page).getByRole('form', { name: '外链跳转测试' })
  const url = 'https://game.example/support'
  await form.getByLabel('外链地址').fill(url)
  await expect(form.getByRole('button', { name: '打开外链', exact: true })).toBeEnabled()
  await form.getByRole('button', { name: '打开外链', exact: true }).click()
  await expect(form.getByRole('status')).toContainText('已请求 KOOK 打开外链')
  expect(await page.evaluate(() => (window as FixtureWindow).sdkFixture.externalLinkInputs)).toEqual([{ url }])
  await page.goto('https://localhost:5190/?core&no-external-link')
  await game(page).getByRole('button', { name: '网络拦截测试', exact: true }).click()
  const oldForm = game(page).getByRole('form', { name: '外链跳转测试' })
  await oldForm.getByLabel('外链地址').fill(url)
  await expect(oldForm.getByRole('button', { name: '打开外链', exact: true })).toBeDisabled()
  await expect(oldForm).toContainText('当前 KOOK 宿主尚未开放外链能力')
})

test('平台测试面板也能输入URL并通过同一SDK打开外链', async ({ page }, testInfo) => {
  await open(page)
  await game(page).locator('.test-panel summary').click()
  const form = game(page).getByRole('form', { name: '外链跳转测试' })
  await page.setViewportSize({ width: 430, height: 900 })
  const url = 'https://game.example/community?from=platform-panel'
  await form.getByLabel('外链地址').fill(url)
  await form.getByRole('button', { name: '打开外链', exact: true }).click()
  await expect(form.getByRole('status')).toContainText('已请求 KOOK 打开外链')
  expect(await page.evaluate(() => (window as FixtureWindow).sdkFixture.externalLinkInputs)).toEqual([{ url }])
  await form.screenshot({ path: testInfo.outputPath('platform-external-link-narrow.png') })
})
