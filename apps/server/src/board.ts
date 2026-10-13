import { BOARD_SIZE } from '@lights/contracts'

export function toggle(board: boolean[], cell: number): boolean[] {
  const next = [...board]
  const row = Math.floor(cell / BOARD_SIZE),
    col = cell % BOARD_SIZE
  for (const [dr, dc] of [
    [0, 0],
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
  ]) {
    const r = row + dr,
      c = col + dc
    if (r >= 0 && r < BOARD_SIZE && c >= 0 && c < BOARD_SIZE)
      next[r * BOARD_SIZE + c] = !next[r * BOARD_SIZE + c]
  }
  return next
}
// 从完成态逆向生成；解法仅用于引擎测试，不进入正式快照。
export function generateBoard(seed: number): {
  board: boolean[]
  solution: number[]
} {
  let state = seed >>> 0
  const solution: number[] = []
  let board = Array<boolean>(16).fill(true)
  for (let i = 0; i < 6; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    const cell = (state >>> 16) % 16
    board = toggle(board, cell)
    solution.push(cell)
  }
  if (board.every(Boolean)) {
    board = toggle(board, 0)
    solution.push(0)
  }
  return { board, solution }
}
export function solve(board: boolean[]): number[] {
  // 4×4 只有 65536 种按键组合，开发提示用位掩码搜索。
  const target = board.reduce((mask, lit, i) => (lit ? mask : mask | (1 << i)), 0)
  const masks = Array.from({ length: 16 }, (_, cell) =>
    toggle(Array(16).fill(false), cell).reduce((m, on, i) => (on ? m | (1 << i) : m), 0),
  )
  for (let combination = 0; combination < 65536; combination++) {
    let effect = 0
    for (let i = 0; i < 16; i++) if (combination & (1 << i)) effect ^= masks[i]
    if (effect === target) return masks.flatMap((_, i) => (combination & (1 << i) ? [i] : []))
  }
  return []
}
