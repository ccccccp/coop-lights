import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/** 开发服务器和游戏后端共用显式 TLS 配置；构建静态文件时不读取证书。 */
export function readGameTls(enabled: boolean, certificate: string, key: string, projectRoot: string) {
  if (!enabled) return undefined
  if (!certificate || !key) throw new Error('开启 HTTPS 时必须配置 GAME_TLS_CERT 和 GAME_TLS_KEY')
  return {
    cert: readFileSync(resolve(projectRoot, certificate), 'utf8'),
    key: readFileSync(resolve(projectRoot, key), 'utf8'),
  }
}

/** Windows 兼容 Git for Windows 的常见安装位置，仍可通过 OPENSSL_BIN 显式覆盖。 */
export function resolveOpenSsl() {
  if (process.env.OPENSSL_BIN) return process.env.OPENSSL_BIN
  if (process.platform === 'win32') {
    for (const path of ['C:/Program Files/Git/usr/bin/openssl.exe', 'D:/Program Files/Git/usr/bin/openssl.exe']) {
      if (existsSync(path)) return path
    }
  }
  return 'openssl'
}
