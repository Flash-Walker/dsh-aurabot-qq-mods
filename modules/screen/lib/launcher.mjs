/**
 * 打开 App 的两条路：命令（快）和像人一样点（慢但稳）。
 *
 * 主人后来改了口径：能走系统命令的就别模拟人手——省时间、省 token，也不用担心
 * 视觉错位。所以默认 `fast`：先 `aa start`，失败才退回「点图标 → 滑屏找 → 下拉搜索」。
 * 想让她真的像人一样点，传 `mode: 'human'`。
 *
 * 明确的设计约束：模拟人的顺序是 回桌面 → 点桌面图标 → 滑到下一屏 → 下拉搜索。
 * `aa start` 在 human 模式下只做最后兜底，且设置里可以关掉。
 */
import { sleep, shellQuote } from './hdc.mjs'
import { APPS, learnFromItems, pickAbilities, resolveApp } from './apps.mjs'
import { findByText, flatten, pointOf, toLines } from './layout.mjs'

/** 常见 App：名字 → 包名。包里带子串就算命中（鸿蒙的 id 里常带 _hos 之类的尾巴） */
const ALIAS = Object.fromEntries(Object.entries(APPS).map(([k, v]) => [k.toLowerCase(), v.bundle]))

const isLauncher = (bundle) => /sceneboard|launcher|home|search/i.test(String(bundle || ''))

/** 现在是不是「桌面这一层」（桌面 / 全局搜索 / 系统界面，都不是应用） */
const atDesktopUi = (fg) => !!fg && fg.ok === true && (fg.system === true || isLauncher(fg.bundle))

/** 挡路的小弹窗上「关掉就行」的按钮。故意不含「允许/同意」——权限弹窗不替主人做决定 */
const DISMISS = ['知道了', '关闭', '取消', '以后再说', '跳过', '稍后', '不再提示']

/** 把用户/她说的名字换成包名（认不出来就返回空） */
export function resolveBundle(name) {
  const k = String(name || '').trim()
  if (!k) return ''
  if (k.includes('.')) return k
  return ALIAS[k.toLowerCase()] || ALIAS[k] || ''
}

/** 页面指纹：文字集合（丢掉纯数字的角标和时钟），判断「滑了一屏但内容没变」= 到底了 */
const signature = (items) => items
  .map((i) => i.label)
  .filter((l) => l && !/^[\d:+\-%]+$/.test(l))
  .join('|')

export function createLauncher({ dev, log = null }) {
  const trace = (...a) => { if (log && log.debug) log.debug('[screen]', ...a) }

  /** 从桌面图标 id 里学到的「包名 → 入口能力」，只活在本次进程里，够用了 */
  const learned = {}

  /** 每次 dump 完都顺手学一遍入口名 */
  function noteItems(items) {
    const next = learnFromItems(items, learned)
    for (const k of Object.keys(next)) if (!learned[k]) learned[k] = next[k]
    return learned
  }

  const isTargetBundle = (fg, bundle) => {
    if (!fg || !fg.ok || !fg.bundle || isLauncher(fg.bundle)) return false
    if (!bundle) return true
    const b = String(bundle).toLowerCase()
    const f = String(fg.bundle).toLowerCase()
    return f.includes(b) || b.includes(f)
  }

  async function currentItems() {
    const l = await dev.layout({ wake: false })
    if (!l.ok) throw new Error(l.error)
    const items = flatten(l.tree)
    noteItems(items)
    return { items, size: l.size }
  }

  /** 等前台离开桌面（App 冷启动有闪屏，只看一次容易误判成「没点开」） */
  async function waitForeground(ms = 7000) {
    const end = Date.now() + ms
    let fg = { ok: false }
    while (Date.now() < end) {
      fg = await dev.foreground()
      if (fg.ok && fg.bundle && !isLauncher(fg.bundle)) return fg
      await sleep(700)
    }
    return fg
  }

  /** 等真的回到桌面（从别的 App 按 Home 后，桌面要一点时间才起来） */
  async function waitLauncher(ms = 4000) {
    const end = Date.now() + ms
    for (;;) {
      const fg = await dev.foreground()
      if (atDesktopUi(fg) || Date.now() >= end) return fg
      await sleep(600)
    }
  }

  /** 这一屏是不是桌面（只有真的是桌面，才谈得上「点图标」） */
  const isDesktopItems = (items) => (items || []).some((i) => /SwiperPage_Grid|SCBDesktop|AppIcon_Image|FolderComponent/i.test(i.id || ''))

  /** 全局搜索页：它挂在桌面上，但 Home 键退不出去，得按 Back */
  const isSearchPage = (items) => (items || []).some((i) => /searchInput|hisearch/i.test(i.id || '') || /searchViewContentScroller/i.test(i.id || ''))

  /** 看一眼是不是真的在桌面（别信前台：搜索页和弹窗都没有前台应用） */
  async function onDesktopNow() {
    try {
      const { items } = await currentItems()
      return isDesktopItems(items)
    } catch {
      return false
    }
  }

  /** 看一眼当前屏（拿不到就返回 null） */
  async function safeItems() {
    try {
      const { items, size } = await currentItems()
      return { items, size }
    } catch {
      return null
    }
  }

  /** 确保回到桌面：搜索页上滑收回 → 关小弹窗 → Back → Home；最多三轮 */
  async function ensureDesktop(tries = 3) {
    for (let i = 0; i < tries; i++) {
      const cur = await safeItems()
      if (cur && isDesktopItems(cur.items)) return true
      if (cur && isSearchPage(cur.items)) {
        // 全局搜索页是「拉下来」的，Home / Back 都退不出去，只有往上滑才收得回去
        trace('在搜索页，往上滑收回去')
        await dev.swipeDir('up', 0.62, { size: cur.size, fling: false })
        await sleep(1300)
        if (await onDesktopNow()) return true
      }
      if (cur && cur.items.length <= 10) {
        const cleared = await clearBlocking(cur.items)
        if (cleared) {
          trace(`关掉弹窗「${cleared}」`)
          await sleep(700)
          if (await onDesktopNow()) return true
        }
      }
      await dev.key('Back')
      await sleep(900)
      if (await onDesktopNow()) return true
      await dev.key('Home')
      await sleep(1300)
    }
    const ok = await onDesktopNow()
    trace(`最终${ok ? '回到' : '没能回到'}桌面`)
    return ok
  }

  /** 点某一屏里名叫 name 的图标（必须是桌面图标容器，别把正文里同名的字点了） */
  async function tapOnDesktop(items, name, bundle) {
    const hit = findByText(items, name, { bundle })
    if (!hit) return { ok: false, reason: '这一屏没有' }
    const isIcon = /AppIcon|GridItem|SwiperPage|FolderComponent/i.test(hit.id || '') || hit.type === 'GridItem'
    if (!isIcon) return { ok: false, reason: `「${hit.label}」不是桌面图标` }
    const pt = pointOf(hit)
    if (!pt) return { ok: false, reason: '拿到了条目但没有坐标' }
    const r = await dev.click(pt.x, pt.y)
    if (!r.ok) return { ok: false, reason: r.error }
    await sleep(2200)
    return { ok: true, point: pt, label: hit.label || hit.text || hit.desc || String(name) }
  }

  /** 下拉调起桌面搜索（鸿蒙桌面从中间往下拉就是全局搜索） */
  async function openSearch(size) {
    const s = size || { w: 1080, h: 2406 }
    const x = Math.round(s.w / 2)
    // 两套落点：第一下拉不出来（比如刚好按到文件夹）就换个起点、慢一点再试一次
    for (const [from, to, velocity] of [[0.17, 0.72, 700], [0.28, 0.80, 500]]) {
      await ensureDesktop()
      await sleep(500)
      await dev.swipe(x, Math.round(s.h * from), x, Math.round(s.h * to), { velocity })
      await sleep(1500)
      let { items } = await currentItems()
      const findField = (list) => list.find((i) => /Search|TextInput/i.test(i.type) || /searchInput|hisearch/i.test(i.id) || /搜索关键词|全局搜索/i.test(`${i.label}${i.desc}`))
      let field = findField(items)
      if (!field) {
        // 弹窗会把整棵树盖成只剩几个节点，先关掉再看一次
        const cleared = await clearBlocking(items)
        if (cleared) {
          await sleep(800)
          items = (await currentItems()).items
          field = findField(items)
        }
      }
      if (field) return { items, field }
      trace(`搜索尝试 ${from}/${to}：${items.length} 个节点，没看到搜索框`)
    }
    return { items: [], field: null }
  }

  /** 搜索页里点结果：优先精确等于名字、且不在搜索框那一行的 */
  async function tapSearchResult(items, name, field) {
    const floor = field ? field.bounds.y2 + 8 : 0
    const norm = (s) => String(s || '').replace(/\s+/g, '').toLowerCase()
    const q = norm(name)
    const hits = items.filter((i) => {
      const label = i.label || i.text || i.desc
      if (!label) return false
      if (/Search|TextInput/i.test(i.type) || /searchInput|hisearch/i.test(i.id)) return false
      if (i.bounds.y1 < floor) return false
      return norm(label) === q || norm(label).includes(q)
    })
    if (!hits.length) return { ok: false, reason: '搜索结果里没找到' }
    // 越靠上越可能是「最佳匹配」，同位置取可点的那个
    hits.sort((a, b) => a.bounds.y1 - b.bounds.y1)
    const best = hits[0]
    const pt = pointOf(best)
    if (!pt) return { ok: false, reason: '结果没有坐标' }
    const r = await dev.click(pt.x, pt.y)
    if (!r.ok) return { ok: false, reason: r.error }
    await sleep(2500)
    return { ok: true, point: pt, label: best.label }
  }

  /** 挡路的弹窗（「暂无可用打开方式」这类）先关掉，否则后面所有点击都打在它身上 */
  async function clearBlocking(items) {
    if (!items || items.length > 10) return null
    const hit = items.find((i) => DISMISS.some((w) => String(i.label || '').includes(w)))
    if (!hit) return null
    const pt = pointOf(hit)
    if (!pt) return null
    await dev.click(pt.x, pt.y)
    await sleep(900)
    return hit.label
  }

  /** 看一眼当前屏，有小弹窗就关掉；返回关掉的按钮文字 */
  async function dismissAny() {
    try {
      const { items } = await currentItems()
      return await clearBlocking(items)
    } catch {
      return null
    }
  }

  /**
   * 问系统这个包有哪些入口：`bm dump -n <bundle> | grep 'Ability"'`。
   * 63KB 的包信息在设备上先过滤成十几行再传回来，比整个 dump 快也省。
   * 拿到一堆 FormAbility / ExtensionAbility，pickAbilities 会挑出能当入口的那几个。
   */
  async function discoverAbilities(bundle) {
    const b = String(bundle || '').trim()
    if (!b) return []
    const cmd = `bm dump -n ${shellQuote(b)} | grep -E '"name": "[A-Za-z0-9_]+Ability"'`
    const r = await dev.hdc.sh(cmd, 20000)
    if (!r.ok) return []
    const names = []
    for (const line of String(r.out || '').split(/\r?\n/)) {
      const m = /"name":\s*"([A-Za-z0-9_]+Ability)"/.exec(line)
      if (m && !names.includes(m[1])) names.push(m[1])
    }
    const picked = pickAbilities(names, 3)
    if (picked.length) log.debug(`[screen] ${b} 的入口候选：${picked.join(', ')}`)
    return picked
  }

  /**
   * 命令开：`aa start`。先带 -a（表里的入口、从桌面图标学到的、或问 bm dump），失败再试裸包名。
   * 成功判定仍要前台包名对得上——命令回 success 但界面没切的情况真机上出现过。
   */
  async function openViaCommand(name, opts = {}) {
    const app = resolveApp(name, learned)
    const bundle = String(opts.bundle || app.bundle || '')
    if (!bundle) return { ok: false, reason: `没有「${name}」的包名，命令开不了` }
    const tried = []
    const abilities = []
    const first = String(opts.ability || app.ability || '')
    if (first) abilities.push(first)
    const known = learned[bundle.toLowerCase()]
    if (known && known.ability && !abilities.includes(known.ability)) abilities.push(known.ability)
    if (!abilities.length) {
      // 不知道入口就问系统，别一层层点图标
      for (const a of await discoverAbilities(bundle)) if (!abilities.includes(a)) abilities.push(a)
    }
    const attempts = abilities.map((a) => [bundle, a]).concat([[bundle, '']])
    for (const [b, a] of attempts) {
      const r = await dev.startApp(b, a)
      if (!r.ok) {
        tried.push(r.error)
        continue
      }
      const fg = await waitForeground(5000)
      if (isTargetBundle(fg, b)) {
        trace(`命令打开成功：-b ${b}${a ? ` -a ${a}` : ''}`)
        if (a) learned[b.toLowerCase()] = { bundle: b, ability: a }
        return {
          ok: true,
          via: 'command',
          bundle: fg.bundle,
          ability: a,
          foreground: fg,
          message: `用系统命令打开了「${name}」→ ${fg.bundle}${a ? ` / ${a}` : '（裸包名）'}`,
        }
      }
      tried.push(`aa start -b ${b}${a ? ` -a ${a}` : ''} 没把前台切过去（当前 ${fg.bundle || '桌面'}）`)
    }
    return { ok: false, reason: `命令打开失败：${tried.join('；')}`, tried }
  }

  /**
   * 打开一个 App。
   * @param {string} name  App 名（抖音 / QQ / 小红书…）或包名
   * @param {object} opts  { mode='fast'|'human', maxPages=4, allowShell=true }
   *   mode='fast'  先 aa start，失败才点图标/搜索（默认，省时省 token）
   *   mode='human' 先点图标/搜索，命令只做最后兜底
   */
  async function open(name, opts = {}) {
    const key = String(name || '').trim()
    if (!key) return { ok: false, message: '要给个应用名或包名' }
    const bundle = resolveBundle(key)
    const maxPages = Math.min(Math.max(Number(opts.maxPages) || 4, 1), 8)
    const allowShell = opts.allowShell !== false
    const mode = /^(human|humanlike)/i.test(String(opts.mode || '')) ? 'human' : 'fast'
    const tried = []

    // fast：命令先上，一步到位就不用看屏幕
    if (allowShell && mode === 'fast') {
      const cmd = await openViaCommand(key, opts)
      if (cmd.ok) return cmd
      tried.push(cmd.reason)
    }

    // 打开成功的判定：前台换了、而且（知道包名时）包名对得上——不然「点了一下、恰好切到别的应用」也会被当成成功
    const isTarget = (fg) => isTargetBundle(fg, bundle)

    const onDesktop = await ensureDesktop()
    if (!onDesktop) tried.push('按了 Home 也没回到桌面')

    // 1) 桌面逐屏找图标
    let items = []
    let size = null
    let lastSig = ''
    for (let page = 1; onDesktop && page <= maxPages; page++) {
      let cur = await currentItems()
      const cleared = await clearBlocking(cur.items)
      if (cleared) {
        tried.push(`先关掉了挡路弹窗「${cleared}」`)
        await sleep(700)
        cur = await currentItems()
      }
      items = cur.items
      size = cur.size
      if (!isDesktopItems(items)) {
        tried.push(`第${page}屏不是桌面，跳过点图标`)
        break
      }
      const sig = signature(items)
      if (page > 1 && sig === lastSig) { tried.push(`第${page}屏还是同一页，到底了`); break }
      lastSig = sig
      tried.push(`第${page}屏：${items.length} 个可辨认节点`)
      const r = await tapOnDesktop(items, key, bundle)
      if (r.ok) {
        const fg = await waitForeground()
        if (isTarget(fg)) {
          return { ok: true, via: 'tap-desktop', page, bundle: fg.bundle, foreground: fg, message: `在桌面第${page}屏点了「${r.label}」，已进入 ${fg.bundle}` }
        }
        // 点了但没打开目标（点到文件夹 / 同名文字 / 别的图标），继续找
        tried.push(`第${page}屏点了「${r.label}」但前台是 ${fg.bundle || '未知'}，不是它`)
      } else {
        tried.push(`第${page}屏${r.reason}`)
      }
      if (page < maxPages) {
        await dev.swipeDir('left', 0.7, { size, fling: true })
        await sleep(900)
      }
    }

    // 2) 下拉搜索 —— 桌面没有图标时的主力路径（仍然是模拟人）
    await ensureDesktop()
    const search = await openSearch(size)
    if (search.field) {
      tried.push('下拉搜索：拿到搜索框')
      const typed = await dev.type(key)
      if (typed.ok) {
        await sleep(1600)
        const after = await currentItems()
        const hit = await tapSearchResult(after.items, key, search.field)
        if (hit.ok) {
          const fg = await waitForeground()
          if (isTarget(fg)) {
            return { ok: true, via: 'tap-search', bundle: fg.bundle, foreground: fg, message: `桌面没有图标，用下拉搜索搜「${key}」并点开了 ${fg.bundle}` }
          }
          tried.push(`点了搜索结果「${hit.label}」但前台是 ${fg.bundle || '未知'}，不是它`)
        } else {
          tried.push(`搜索：${hit.reason}`)
        }
      } else {
        tried.push(`搜索输入失败：${typed.error}`)
      }
    } else {
      tried.push('下拉没出现搜索页')
    }

    // 3) human 模式下的最后兜底：命令开（fast 模式前面已经试过，不重复）
    if (allowShell && mode !== 'fast') {
      tried.push('兜底尝试命令打开')
      const cmd = await openViaCommand(key, opts)
      if (cmd.ok) return { ...cmd, tried }
      tried.push(cmd.reason)
    }

    const hint = items.length ? toLines(items, { maxLines: 10 }).join(' / ') : ''
    return {
      ok: false,
      tried,
      message: `没打开「${key}」。${bundle ? `包名 ${bundle} 试过了` : '这个名字没有内置包名映射，只能靠桌面/搜索'}。过程：${tried.join('；')}${hint ? `。当前这屏能看到的：${hint}` : ''}`,
    }
  }

  /** 回桌面并确认真的在桌面 */
  async function home() {
    const ok = await ensureDesktop()
    return { ok, foreground: await dev.foreground() }
  }

  /** 桌面图标标题（挑 App 用，也能给她看一眼桌面有啥） */
  async function desktopIcons() {
    await ensureDesktop()
    let { items } = await currentItems()
    const cleared = await clearBlocking(items)
    if (cleared) {
      await sleep(700)
      items = (await currentItems()).items
    }
    if (!isDesktopItems(items)) return { icons: 0, names: [], bundles: [], desktop: false }
    const icons = []
    for (const it of items) {
      const m = /SwiperPage_GridItem_\[([^\s,]+)/.exec(it.id || '')
      if (m) icons.push({ bundle: m[1], label: it.label })
    }
    // 图标名已经并到可点容器上了（label），这里取那些带包名的容器标题
    const names = items
      .filter((i) => /Container_AppIcon_Image_/.test(i.id || '') && i.label && !i.label.startsWith('('))
      .map((i) => i.label)
    return { icons: icons.length, names: [...new Set(names)].slice(0, 40), bundles: icons.map((i) => i.bundle), desktop: true, learned }
  }

  return { open, openViaCommand, home, desktopIcons, clearBlocking, resolveBundle, ALIAS, tapOnDesktop, learned }
}
