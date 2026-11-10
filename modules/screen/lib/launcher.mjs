/**
 * 「像人一样把 App 打开」。
 *
 * 明确的设计约束（主人提的）：优先模拟人的操作，不用 aa start 这类后台指令。
 * 顺序是：回桌面 → 桌面图标点一下 → 没找到就滑到下一屏找 → 还找不到就下拉搜索、
 * 输入名字、点搜索结果。只有在全部失败、且设置里允许时，才退到 aa start 兜底。
 */
import { sleep } from './hdc.mjs'
import { findByText, flatten, pointOf, toLines } from './layout.mjs'

/** 常见 App：名字 → 包名。包里带子串就算命中（鸿蒙的 id 里常带 _hos 之类的尾巴） */
const ALIAS = {
  qq: 'com.tencent.mqq',
  抖音: 'com.ss.hm.ugc.aweme',
  快手: 'com.kuaishou.hmapp',
  小红书: 'com.xingin.xhs',
  微信: 'com.tencent.wechat',
  微博: 'com.sina.weibo',
  淘宝: 'com.taobao.taobao',
  百度: 'com.baidu.baiduapp',
  今日头条: 'com.ss.hm.article.news',
  哔哩哔哩: 'yylx.danmaku.bili',
  b站: 'yylx.danmaku.bili',
  设置: 'com.huawei.hmos.settings',
  相机: 'com.huawei.hmos.camera',
  图库: 'com.huawei.hmos.photos',
  计算器: 'com.huawei.hmos.calculator',
  备忘录: 'com.huawei.hmos.notepad',
  日历: 'com.huawei.hmos.calendar',
  音乐: 'com.huawei.hmos.music',
  华为音乐: 'com.huawei.hmos.music',
  支付宝: 'com.alipay',
}

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
  async function currentItems() {
    const l = await dev.layout({ wake: false })
    if (!l.ok) throw new Error(l.error)
    return { items: flatten(l.tree), size: l.size }
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
   * 打开一个 App。
   * @param {string} name  App 名（抖音 / QQ / 小红书…）或包名
   * @param {object} opts  { maxPages=4, allowShell=true, expect='' }
   */
  async function open(name, opts = {}) {
    const key = String(name || '').trim()
    if (!key) return { ok: false, message: '要给个应用名或包名' }
    const bundle = resolveBundle(key)
    const maxPages = Math.min(Math.max(Number(opts.maxPages) || 4, 1), 8)
    const allowShell = opts.allowShell !== false
    const tried = []

    // 打开成功的判定：前台换了、而且（知道包名时）包名对得上——不然「点了一下、恰好切到别的应用」也会被当成成功
    const isTarget = (fg) => {
      if (!fg || !fg.ok || !fg.bundle || isLauncher(fg.bundle)) return false
      if (!bundle) return true
      const b = bundle.toLowerCase()
      const f = fg.bundle.toLowerCase()
      return f.includes(b) || b.includes(f)
    }

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

    // 3) 兜底：aa start（主人说「尽可能不用」，所以默认放最后且可关）
    if (allowShell && bundle) {
      tried.push('兜底尝试 aa start')
      for (const args of [`-b ${bundle} -a MainAbility`, `-b ${bundle}`]) {
        const r = await dev.hdc.sh(`aa start ${args}`, 20000)
        if (r.ok && /success/i.test(r.out)) {
          const fg = await waitForeground()
          if (!fg.ok || isLauncher(fg.bundle)) {
            tried.push(`aa start ${args} 没把前台拉过去`)
            continue
          }
          return { ok: true, via: 'aa-start', bundle: fg.bundle, foreground: fg, message: `桌面和搜索都没打开，退回后台指令拉起了 ${fg.bundle}`, tried }
        }
        tried.push(`aa start ${args} 不认这个包/入口`)
      }
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
    return { icons: icons.length, names: [...new Set(names)].slice(0, 40), bundles: icons.map((i) => i.bundle), desktop: true }
  }

  return { open, home, desktopIcons, clearBlocking, resolveBundle, ALIAS, tapOnDesktop }
}
