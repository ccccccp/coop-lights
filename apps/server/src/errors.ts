export class GameError extends Error {
  constructor(
    public code: string,
    message: string,
    public statusCode = 400,
    public details?: Record<string, unknown>
  ) {
    super(message)
  }
}
export function check(condition: unknown, code: string, message: string, status = 400): asserts condition {
  if (!condition) throw new GameError(code, message, status)
}
