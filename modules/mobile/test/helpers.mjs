// 通过仓库 scripts/plugin-env.mjs 加载测试宿主，不在模块运行时代码里导入本体源码。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createMobileService as createService } from '../lib/service.mjs'

if (!globalThis.aurabot?.src) throw new Error('请设置 AURABOT_PLUGIN_DIR，并用 --import ./scripts/plugin-env.mjs 运行测试')
export const pluginSource = globalThis.aurabot.src
export const pluginRoot = new URL('../', pluginSource)
export const version = JSON.parse(readFileSync(new URL('package.json', pluginRoot), 'utf8')).version
export const { createFakeDsh } = await import(new URL('test/helpers/fake-dsh.js', pluginRoot))
export const { startMockOneBot } = await import(new URL('test/helpers/mock-onebot.js', pluginRoot))
export const { buildWav } = globalThis.aurabot.lib('voice/wav.js')
const { createMediaAccess } = globalThis.aurabot.lib('core/media.js')
export function createMobileService(options) {
  const media = options.media || createMediaAccess({ root: fileURLToPath(pluginRoot), use: options.use, config: options.config })
  return createService({ version, media, ...options })
}
export const pause = (ms) => new Promise((r) => setTimeout(r, ms))
export async function until(fn, ms = 8000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) { const result = await fn(); if (result) return result; await pause(20) }
  throw new Error('等待手机端事件或会话超时')
}
