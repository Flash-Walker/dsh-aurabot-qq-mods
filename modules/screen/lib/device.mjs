/**
 * 设备层：把 hdc 的零散命令包成「看 / 点 / 滑 / 输入 / 按键 / 前台应用」这些动作。
 *
 * 所有方法都返回 { ok, ... } 而不抛错——上层（工具、自主循环）靠 ok 决定怎么解释失败。
 */
import { readFile, mkdir, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { sleep, shellQuote } from './hdc.mjs'
import { parseDump, screenSize } from './layout.mjs'

const TMP = '/data/local/tmp'

/** 允许的按键：鸿蒙里 Home/Back/Power 直接给名字，其余给 KeyCode 数字 */
const KEY_NAMES = new Set(['Home', 'Back', 'Power'])

export function createDevice({ hdc, dataDir, log }) {
  /** 串行化：工具和自主循环可能同时动手机，排队执行避免互相踩 */
  let queue = Promise.resolve()
  const serial = (fn) => {
    const next = queue.then(fn, fn)
    queue = next.catch(() => {})
    return next
  }

  async function ensureDir(dir) {
    try { await mkdir(dir, { recursive: true }) } catch { /* 已存在 */ }
    return dir
  }

  /** 截图 + 拉回本地。返回本地路径和像素尺寸 */
  async function shot({ wake = true } = {}) {
    return serial(async () => {
      if (wake) await wakeup()
      const stamp = Date.now()
      const remote = `${TMP}/aurabot-${stamp}.jpeg`
      const r = await hdc.sh(`snapshot_display -f ${remote}`, 25000)
      const m = /width:\s*(\d+),\s*height:\s*(\d+)/.exec(`${r.out}\n${r.err}`)
      if (!r.ok || !m) {
        return { ok: false, error: `截图失败：${r.err || r.out || '未知原因'}` }
      }
      const dir = await ensureDir(dataDir('shots'))
      const local = join(dir, `shot-${stamp}.jpeg`)
      const got = await hdc.recv(remote, local)
      if (!got.ok) return { ok: false, error: `截图传输失败：${got.err || got.out}` }
      await hdc.sh(`rm -f ${remote}`, 8000).catch(() => {})
      await pruneShots(dir)
      return { ok: true, local, width: Number(m[1]), height: Number(m[2]), at: stamp }
    })
  }

  /** 只留最近 3 张，别把磁盘塞满 */
  async function pruneShots(dir) {
    try {
      const files = (await readdir(dir)).filter((f) => f.endsWith('.jpeg')).sort()
      for (const f of files.slice(0, Math.max(0, files.length - 3))) await rm(join(dir, f), { force: true })
    } catch { /* 清理失败不影响主流程 */ }
  }

  /** 控件树（dump → 拉回 → 解析）。顺带把屏幕尺寸从根节点 bounds 里读出来 */
  async function layout({ wake = true } = {}) {
    return serial(async () => {
      if (wake) await wakeup()
      const remote = `${TMP}/aurabot-layout.json`
      const r = await hdc.sh(`uitest dumpLayout -p ${remote}`, 25000)
      if (!r.ok) return { ok: false, error: `控件树失败：${r.err || r.out}` }
      const local = join(await ensureDir(dataDir('tmp')), 'layout.json')
      const got = await hdc.recv(remote, local)
      if (!got.ok) return { ok: false, error: `控件树传输失败：${got.err || got.out}` }
      try {
        const tree = parseDump(await readFile(local, 'utf8'))
        return { ok: true, tree, size: screenSize(tree) }
      } catch (e) {
        return { ok: false, error: e.message }
      }
    })
  }

  /** 前台应用（aa dump -l 里带 #FOREGROUND 的那块） */
  async function foreground() {
    return serial(async () => {
      const r = await hdc.sh('aa dump -l', 20000)
      if (!r.ok) return { ok: false, error: r.err || r.out }
      const lines = r.out.split(/\r?\n/)
      const idx = lines.findIndex((l) => l.includes('#FOREGROUND'))
      if (idx < 0) {
        // 桌面、全局搜索、系统弹窗都不是 ability，aa dump 里就没有 #FOREGROUND 段。
        // 这不是失败，而是「现在没有前台应用」。
        return { ok: true, bundle: '', ability: '', system: true }
      }
      let bundle = ''
      let ability = ''
      for (let i = idx; i >= Math.max(0, idx - 8); i--) {
        if (!bundle) {
          const m = /bundle name \[([^\]]+)\]/.exec(lines[i])
          if (m) bundle = m[1]
        }
        if (!ability) {
          const m = /main name \[([^\]]+)\]/.exec(lines[i])
          if (m) ability = m[1]
        }
      }
      return { ok: true, bundle, ability }
    })
  }

  /** 设备信息：型号 / 系统版本 / 目标列表（面板和 screen_status 都用它） */
  async function info() {
    const [health, model, os, soft] = await Promise.all([
      hdc.health(),
      hdc.sh('param get const.product.model', 12000),
      hdc.sh('param get const.ohos.fullname', 12000),
      hdc.sh('param get const.product.software.version', 12000),
    ])
    return {
      ok: health.ok,
      targets: health.targets,
      hdcVersion: health.version,
      model: (model.out || '').trim(),
      os: (os.out || '').trim(),
      version: (soft.out || '').trim(),
      error: health.error,
    }
  }

  async function wakeup() {
    try { await hdc.sh('power-shell wakeup', 12000) } catch { /* 老版本没有这个命令就忽略 */ }
    await sleep(300)
  }

  const guard = (r, what) => {
    if (r.ok) return { ok: true }
    // 设备端的 uitest 出错也是 exit 0 + 文本，这里连文本一起看
    const txt = `${r.out} ${r.err}`.trim()
    return { ok: false, error: `${what}失败：${txt || '未知原因'}` }
  }

  async function click(x, y, { long = false } = {}) {
    const nx = Math.round(Number(x))
    const ny = Math.round(Number(y))
    if (!Number.isFinite(nx) || !Number.isFinite(ny) || nx < 0 || ny < 0) {
      return { ok: false, error: '坐标不合法' }
    }
    return serial(async () => {
      const cmd = long ? `uitest uiInput longClick ${nx} ${ny}` : `uitest uiInput click ${nx} ${ny}`
      const r = await hdc.sh(cmd, 15000)
      if (!r.ok) return guard(r, '点击')
      await sleep(150)
      return { ok: true, x: nx, y: ny }
    })
  }

  async function swipe(x1, y1, x2, y2, { velocity = 600, fling = false } = {}) {
    const cmds = [x1, y1, x2, y2].map((n) => Math.round(Number(n)))
    if (cmds.some((n) => !Number.isFinite(n))) return { ok: false, error: '坐标不合法' }
    const v = Math.min(Math.max(Math.round(Number(velocity) || 600), 200), 40000)
    return serial(async () => {
      const cmd = `uitest uiInput ${fling ? 'fling' : 'swipe'} ${cmds[0]} ${cmds[1]} ${cmds[2]} ${cmds[3]} ${v}`
      const r = await hdc.sh(cmd, 15000)
      if (!r.ok) return guard(r, '滑动')
      await sleep(200)
      return { ok: true }
    })
  }

  /** 方向滑动：up/down/left/right，amount 是位移比例（0.15~0.9） */
  async function swipeDir(direction, amount = 0.6, { size = null, fling = false } = {}) {
    let s = size
    if (!s) {
      const l = await layout({ wake: false })
      if (!l.ok) return { ok: false, error: l.error }
      s = l.size
    }
    if (!s) return { ok: false, error: '拿不到屏幕尺寸' }
    const d = Math.min(Math.max(Number(amount) || 0.6, 0.15), 0.9)
    const cx = Math.round(s.w / 2)
    const cy = Math.round(s.h / 2)
    let x1 = cx; let y1 = cy; let x2 = cx; let y2 = cy
    if (direction === 'up') { y1 = Math.round(s.h * 0.78); y2 = Math.round(s.h * (0.78 - d)) }
    else if (direction === 'down') { y1 = Math.round(s.h * 0.22); y2 = Math.round(s.h * (0.22 + d)) }
    else if (direction === 'left') { x1 = Math.round(s.w * 0.86); x2 = Math.round(s.w * (0.86 - d)) }
    else if (direction === 'right') { x1 = Math.round(s.w * 0.14); x2 = Math.round(s.w * (0.14 + d)) }
    else return { ok: false, error: '方向只能是 up / down / left / right' }
    const r = await swipe(x1, y1, x2, y2, { velocity: fling ? 1200 : 600, fling })
    return r.ok ? { ok: true, from: [x1, y1], to: [x2, y2] } : r
  }

  /** 往当前光标所在的输入框打字（uitest uiInput text） */
  async function type(text) {
    const t = String(text == null ? '' : text)
    if (!t.trim()) return { ok: false, error: '没东西可输入' }
    return serial(async () => {
      const r = await hdc.sh(`uitest uiInput text ${shellQuote(t)}`, 20000)
      // 成功时设备回的是 "No Error"，所以只认明确的失败词，不能拿 /error/ 判
      if (!r.ok || /fail|invalid|denied|not found|exception|error:/i.test(`${r.out} ${r.err}`)) return guard(r, '输入')
      await sleep(300)
      return { ok: true, text: t }
    })
  }

  /** 先点坐标再打字（inputText x y text），适合「点输入框顺带输入」 */
  async function typeAt(x, y, text) {
    const t = String(text == null ? '' : text)
    return serial(async () => {
      const r = await hdc.sh(`uitest uiInput inputText ${Math.round(x)} ${Math.round(y)} ${shellQuote(t)}`, 25000)
      if (!r.ok) return guard(r, '输入')
      await sleep(300)
      return { ok: true }
    })
  }

  /**
   * 用系统命令启动应用（aa start）。能成功就完全不用看屏幕、不用点图标。
   * 只给包名在部分 App 上不认，所以带不带 ability 都由调用方决定。
   */
  async function startApp(bundle, ability = '') {
    const b = String(bundle || '').trim()
    if (!b) return { ok: false, error: '没有包名' }
    const a = String(ability || '').trim()
    const args = a ? `-b ${b} -a ${a}` : `-b ${b}`
    return serial(async () => {
      const r = await hdc.sh(`aa start ${args}`, 25000)
      const txt = `${r.out} ${r.err}`.trim()
      // 成功时回 "start ability successfully." 之类；失败会带 error / not found
      if (!r.ok || /fail|invalid|not found|exception|error:/i.test(txt)) {
        return { ok: false, error: `aa start ${args} 失败：${txt.slice(0, 120) || '未知原因'}`, args }
      }
      return { ok: true, bundle: b, ability: a, args, out: txt.slice(0, 120) }
    })
  }

  /** 用系统命令停掉应用（aa force-stop）。比一层层点返回快得多 */
  async function forceStop(bundle) {
    const b = String(bundle || '').trim()
    if (!b) return { ok: false, error: '没有包名' }
    return serial(async () => {
      const r = await hdc.sh(`aa force-stop ${b}`, 20000)
      const txt = `${r.out} ${r.err}`.trim()
      if (!r.ok || /fail|invalid|not found|exception|error:/i.test(txt)) {
        return { ok: false, error: `aa force-stop ${b} 失败：${txt.slice(0, 120) || '未知原因'}` }
      }
      await sleep(200)
      return { ok: true, bundle: b }
    })
  }

  /** 按键：Home / Back / Power 或 KeyCode 数字 */
  async function key(name) {
    const k = String(name || '').trim()
    if (!k) return { ok: false, error: '要给按键名' }
    if (!KEY_NAMES.has(k) && !/^\d+$/.test(k)) return { ok: false, error: `不认识的按键：${k}` }
    return serial(async () => {
      const r = await hdc.sh(`uitest uiInput keyEvent ${k}`, 15000)
      if (!r.ok) return guard(r, '按键')
      await sleep(300)
      return { ok: true, key: k }
    })
  }

  return {
    hdc,
    shot,
    layout,
    foreground,
    info,
    wakeup,
    click,
    swipe,
    swipeDir,
    type,
    typeAt,
    startApp,
    forceStop,
    key,
    sleep,
  }
}
