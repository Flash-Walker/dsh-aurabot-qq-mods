/**
 * 真机联调：用一个假的 api 把 index.mjs 加载起来，直接调工具，验证「模块 ↔ hdc ↔ 手机」这条线。
 * 会真的操作手机（点一下计算器），跑之前确认手机在你手上。
 *
 *   node test/live-check.mjs            # 状态 → 读界面 → 打开计算器 → 状态
 *   node test/live-check.mjs layout     # 只读当前界面
 *   node test/live-check.mjs open 抖音   # 只验证打开某个应用
 */
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DATA = join(tmpdir(), 'screen-live-data')
mkdirSync(DATA, { recursive: true })

const calls = []
const rules = []
const routes = new Map()
const commands = new Map()
let toolsFactory = null

const log = {
  info: (...a) => console.log('  [info]', ...a),
  warn: (...a) => console.log('  [warn]', ...a),
  error: (...a) => console.log('  [error]', ...a),
  debug: (...a) => console.log('  [debug]', ...a),
}

/** 只实现模块真用到的那部分 api，其余留空 */
const api = {
  id: 'screen',
  source: 'user',
  version: '1.2.0',
  apiVersion: 1,
  dir: join(HERE, '..'),
  dataDir: (p = '') => {
    const d = join(DATA, p)
    mkdirSync(d, { recursive: true })
    return d
  },
  log,
  config: () => ({}),
  setConfig: () => {},
  settings: () => ({
    hdc: process.env.HDC_PATH || 'D:\\ohos-sdk\\toolchains\\toolchains\\hdc.exe',
    sn: process.env.HDC_SN || '',
    wake: true,
    allowShellLaunch: true,
    allowPost: false,
    stepMs: 9000,
    playMinutes: 10,
  }),
  saveSettings: () => {},
  send: async (chatId, text) => calls.push(['send', chatId, text]),
  sendText: async () => {},
  reply: async () => {},
  sendSegments: async () => {},
  sendImage: async (chatId, file) => calls.push(['sendImage', chatId, file]),
  ask: async () => { throw new Error('live-check 不驱动模型') },
  think: async () => { throw new Error('live-check 不驱动模型') },
  onebot: async () => ({}),
  tool: (fn) => { toolsFactory = fn },
  defineTool: (def) => def,
  on: () => {},
  emit: () => {},
  context: () => {},
  rule: (fn) => rules.push(fn()),
  command: (def) => commands.set(def.name, def),
  every: () => {},
  later: () => {},
  route: (p, fn) => routes.set(p, fn),
  onDispose: () => {},
  use: () => null,
  lazy: () => ({}),
  has: () => false,
  core: { hub: {}, http: {} },
  dsh: { get: () => null },
  lib: () => ({}),
}

const { default: mod } = await import('../index.mjs')
mod.setup(api)

const tools = new Map(toolsFactory({ chat: { kind: 'private', chatId: 'private:1', userId: '1' }, level: 'full', sessionId: 'live' })
  .map((t) => [t.name, t]))

async function call(name, args = {}) {
  const t = tools.get(name)
  if (!t) throw new Error(`没有工具 ${name}`)
  const t0 = Date.now()
  const r = await t.execute(args, {})
  console.log(`\n=== ${name} (${Date.now() - t0}ms) ===`)
  console.log(r && r.message ? r.message : JSON.stringify(r))
  return r
}

const mode = process.argv[2] || 'all'

if (mode === 'layout') {
  await call('screen_layout', { max: 12 })
} else if (mode === 'open') {
  await call('screen_open', { app: process.argv[3] || '计算器' })
} else {
  const st = await call('screen_status')
  if (!st.ok) process.exitCode = 1
  await call('screen_layout', { max: 10 })
  await call('screen_open', { app: '计算器' })
  await call('screen_status')
  await call('screen_key', { key: 'Home' })
}

console.log(`\n模块注册了 ${tools.size} 个工具、${commands.size} 条命令、${routes.size} 个接口、${rules.length} 条规则`)
