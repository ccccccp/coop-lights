import { expect, test } from '@playwright/test'

import { solve } from '../../apps/server/src/board'

test('roomId链接直接加入，主动离房后留在大厅且不重复加入', async ({ browser }) => {
  const aContext = await browser.newContext(),
    bContext = await browser.newContext()
  try {
    const a = await aContext.newPage(),
      b = await bContext.newPage()
    await a.goto('/')
    await expect(a.getByRole('button', { name: '排行榜', exact: true })).toHaveCount(0)
    expect((await a.request.get('/api/leaderboard')).status()).toBe(404)
    await a.getByTestId('nickname').fill('房主')
    await a.getByTestId('standalone-login').click()
    await a.getByTestId('create-room').click()
    const id = await a.getByTestId('active-room-code').innerText()
    await b.goto('/?roomId=' + id)
    await b.getByTestId('nickname').fill('直达玩家')
    await b.getByTestId('standalone-login').click()
    await expect(b.getByTestId('active-room-code')).toHaveText(id)
    await b.getByRole('button', { name: '离开房间', exact: true }).click()
    await expect(b.getByTestId('room-lobby')).toBeVisible()
    await b.getByRole('button', { name: '刷新大厅', exact: true }).click()
    await expect(b.getByTestId('active-room-code')).toHaveCount(0)
    await a.getByRole('button', { name: '离开房间', exact: true }).click()
  } finally {
    await aContext.close()
    await bContext.close()
  }
})

test('双浏览器协作、刷新恢复、结算和退出', async ({ browser }, testInfo) => {
  const aContext = await browser.newContext(),
    bContext = await browser.newContext()
  const a = await aContext.newPage(),
    b = await bContext.newPage(),
    errors: string[] = []
  a.on('pageerror', (e) => errors.push(e.message))
  b.on('pageerror', (e) => errors.push(e.message))
  try {
    await a.goto('/')
    await b.goto('/')
    await a.getByTestId('nickname').fill('青团')
    await a.getByRole('button', { name: '进入游戏' }).click()
    await b.getByTestId('nickname').fill('小雨')
    await b.getByRole('button', { name: '进入游戏' }).click()
    await expect(a.getByText('已连接', { exact: true })).toBeVisible()
    await expect(b.getByText('已连接', { exact: true })).toBeVisible()
    await a.getByTestId('create-room').click()
    const id = await a.getByTestId('active-room-code').innerText()
    await b.getByTestId(`lobby-room-${id}`).getByRole('button', { name: '加入房间 →', exact: true }).click()
    await expect(a.locator('.players')).toContainText('小雨')
    await a.getByText('开发与平台测试面板', { exact: false }).click()
    await a.getByLabel('下一关固定种子（可选）').fill('42')
    await a.getByRole('button', { name: '我准备好了', exact: true }).click()
    await b.getByRole('button', { name: '我准备好了', exact: true }).click()
    await expect(a.getByTestId('start-round')).toBeEnabled()
    await a.getByTestId('start-round').click()
    await expect(a.getByTestId('cell-0')).toBeEnabled()
    const snapshot = await (await a.request.get('/api/session')).json()
    const cells = solve(snapshot.room.round.board)
    for (let i = 0; i < cells.length; i++) {
      const actor = i % 2 ? b : a
      await actor.getByTestId(`cell-${cells[i]}`).click()
      await expect.poll(async () => (await (await a.request.get('/api/session')).json()).room.round.moves).toBe(i + 1)
      if (i === 0) {
        await b.reload()
        await expect(b.getByTestId('room-lobby')).toBeVisible()
        await b.locator('.lobby-membership').getByRole('button', { name: '返回房间 →' }).click()
        await expect(b.getByTestId('active-room-code')).toHaveText(id)
        await expect(b.getByText('已连接', { exact: true })).toBeVisible()
        await expect(a.locator('.players')).toContainText('小雨')
      }
    }
    await expect(a.getByTestId('finished')).toContainText('记录已保存')
    await expect(b.getByTestId('finished')).toContainText('协作成功')
    await a.screenshot({
      path: testInfo.outputPath('desktop-game.png'),
      fullPage: true,
    })
    await b.setViewportSize({ width: 390, height: 844 })
    await expect(b.getByTestId('board')).toBeVisible()
    await b.screenshot({
      path: testInfo.outputPath('narrow-game.png'),
      fullPage: true,
    })
    await b.getByRole('button', { name: '离开房间', exact: true }).click()
    await expect(b.getByTestId('create-room')).toBeVisible()
    await expect(a.locator('.players')).not.toContainText('小雨')
    await a.getByRole('button', { name: '离开房间', exact: true }).click()
    await expect(a.getByTestId('create-room')).toBeVisible()
    expect(errors).toEqual([])
  } finally {
    await aContext.close()
    await bContext.close()
  }
})
