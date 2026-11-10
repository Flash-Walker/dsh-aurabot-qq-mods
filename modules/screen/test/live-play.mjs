/**
 * 真机联调（自动玩）：用一个「假模型」驱动 screen_play，验证整条循环真的能跑起来——
 * 反而不用真的模型，是为了让结果可复现：第一步滑、第二步等、第三步点第一个能点的、之后一直滑。
 *
 *   node test/live-play.mjs           # 玩 2 分钟（会真的操作手机，先确认手机在你手上）
 *   node test/live-play.mjs 1         # 玩 1 分钟
 */
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DATA = join(tmpdir(), 'screen-live-data-play')
mkdirSync(DATA, { recursive: true })

const minutes = Math.min(Math.max(Number(process.argv[2]) || 2, 1), 30)
const sent = []
let askCount = 0
let toolsFactory = null

const log = {
  info: (...a) => console.log('  [info]', ...a),
  warn: (...a) => console.log('  [warn]', ...a),
  error: (...a) => console.log('  [error]', ...a),
  debug: (...a) => console.log('  [debug]', ...a),
}

/** 假模型：按回合给动作，模拟「刷一刷、停一下、点开一个、偶尔退一下」，并且**故意早早喊收工** */
function fakeModel(text) {
  const n = ++askCount
  const firstIdx = /^1\./m.test(text) ? 1 : null
  // 专门验证「不许提前收工」：第 4 次和第 11 次都喊 done，应该被忽略
  if (n === 4 || n % 11 === 0) return '{"why":"感觉玩够了","action":"done"}'
  if (n % 6 === 0) return '{"actions":[{"action":"fling","dir":"up"},{"action":"fling","dir":"up"},{"action":"wait","ms":1200}]}'
  if (n % 9 === 0) return '{"why":"回一下上一屏","action":"back"}'
  if (n % 5 === 0 && firstIdx) return '{"why":"点开这一屏最上面那条看看","action":"click","idx":1}'
  if (n % 7 === 0) return '{"why":"先停一下，看看有没有加载完","action":"wait"}'
  return '{"why":"换下一个内容","action":"fling","dir":"up"}'
}

const api = {
  id: 'screen', source: 'user', version: '1.2.0', apiVersion: 1,
  dir: join(HERE, '..'),
  dataDir: (p = '') => { const d = join(DATA, p); mkdirSync(d, { recursive: true }); return d },
  log,
  config: () => ({}), setConfig: () => {},
  settings: () => ({
    hdc: process.env.HDC_PATH || 'D:\\ohos-sdk\\toolchains\\toolchains\\hdc.exe',
    sn: process.env.HDC_SN || '',
    wake: true, allowShellLaunch: true, allowPost: false,
    preferCommandOpen: process.env.PREFER_CMD !== '0',
    allowForceStop: true,
    stepMs: Number(process.env.STEP_MS) || 6000,
    dumpEvery: Number(process.env.DUMP_EVERY) || 3,
    playMinutes: minutes,
  }),
  saveSettings: () => {},
  send: async (chatId, text) => { sent.push([chatId, text]); console.log(`\n=== 汇报（${chatId}）===\n${text}`) },
  sendText: async () => {}, reply: async () => {},
  sendImage: async () => {},
  ask: async ({ text }) => fakeModel(text),
  think: async () => '',
  onebot: async () => ({}),
  tool: (fn) => { toolsFactory = fn },
  defineTool: (def) => def,
  on: () => {}, emit: () => {}, context: () => {},
  rule: () => {}, command: () => {}, every: () => {}, later: () => {},
  route: () => {}, onDispose: () => {},
  use: () => null, lazy: () => ({}), has: () => false,
  core: { hub: {}, http: {} },
  dsh: { get: () => null },
  lib: () => ({}),
}

const { default: mod } = await import('../index.mjs')
mod.setup(api)

const tools = new Map(toolsFactory({ chat: { kind: 'private', chatId: 'private:live' }, level: 'full', sessionId: 'live' })
  .map((t) => [t.name, t]))

async function call(name, args = {}) {
  const t = tools.get(name)
  if (!t) throw new Error(`没有工具 ${name}`)
  const r = await t.execute(args, {})
  console.log(`\n=== ${name} ===\n${r && r.message ? r.message : JSON.stringify(r)}`)
  return r
}

const started = await call('screen_play', { minutes, app: process.env.PLAY_APP || '抖音', goal: '随便刷刷，看看有什么好玩的' })
if (!started.ok) {
  console.error('没启动起来')
  process.exit(1)
}

// 等它跑完（含收尾汇报的时间余量）
const deadline = Date.now() + minutes * 60000 + 20000
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 5000))
  const st = await call('screen_status')
  const line = String(st.message || '').split('\n').find((l) => l.includes('自动玩'))
  if (line && line.includes('没在')) break
}

console.log(`\n假模型一共被问了 ${askCount} 次；收到 ${sent.length} 条汇报。`)
