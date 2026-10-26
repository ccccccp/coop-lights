import { type Page, expect, test } from '@playwright/test'

import { solve } from '../../apps/server/src/board'

function game(page: Page) {
  return page.frameLocator('#game')
}
async function open(page: Page, player = 'alice', room?: string) {
  await page.goto(`https://localhost:5190/?player=${player}${room ? `&room=${room}` : ''}`)
  await expect(game(page).getByTestId('kook-login')).toBeEnabled()
}
async function login(page: Page) {
  await game(page).getByTestId('kook-login').click()
  await expect(game(page).getByText('已连接', { exact: true })).toBeVisible()
}

test('real SDK starts before login; cancellation, optional scopes, paging and revocation work', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await open(page)
  await expect.poll(() => page.evaluate(() => (window as any).sdkFixture.loaded())).toBe(1)
  expect(
    await page.evaluate(
      () => (window as any).sdkFixture.calls.filter((value: string) => value === 'session.get').length
    )
  ).toBe(0)
  await page.getByRole('button', { name: '取消下次授权' }).click()
  await game(page).getByTestId('kook-login').click()
  await expect(game(page).getByRole('status')).toContainText('已取消授权')
  await expect(game(page).getByTestId('kook-login')).toBeEnabled()
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
  await login(page)
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
    await login(a)
    await game(a).getByTestId('create-room').click()
    const id = await game(a).getByTestId('active-room-code').innerText()
    await game(a).getByRole('button', { name: '邀请好友', exact: true }).click()
    await expect(a.locator('#host-status')).toContainText(id)
    await open(b, 'bob', id)
    await login(b)
    await expect(game(b).getByTestId('room-code')).toHaveValue(id)
    await game(b).getByRole('button', { name: '加入 →', exact: true }).click()
    await expect(game(a).locator('.players')).toContainText('模拟玩家小林')
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
