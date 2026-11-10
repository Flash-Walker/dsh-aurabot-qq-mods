/**
 * 控件树（uitest dumpLayout 的 JSON）→ 人和模型都能读的一小段文字。
 *
 * 原始 dump 动辄 200KB、几万个字符，直接塞给模型既贵又没用。这里做三件事：
 * 1) 只保留「有文字」和「可点」的节点，压成一行一条；
 * 2) 每条带序号，模型可以直接说「点第 3 条」，不用编坐标；
 * 3) 保留原始 attributes + 父链，真要点击时能找回可点击容器算中心点。
 */

/** "[0,0][1080,2406]" → { x1, y1, x2, y2, cx, cy, w, h } */
export function parseBounds(text) {
  const m = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(String(text || ''))
  if (!m) return null
  const [x1, y1, x2, y2] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])]
  const w = x2 - x1
  const h = y2 - y1
  return { x1, y1, x2, y2, w, h, cx: Math.round(x1 + w / 2), cy: Math.round(y1 + h / 2) }
}

export const attr = (node, key) => (node && node.attributes ? String(node.attributes[key] || '') : '')

/** 深度优先遍历，回调拿到 (node, 父节点数组) */
export function walk(node, visit, chain = []) {
  if (!node) return
  visit(node, chain)
  const kids = node.children || []
  for (const child of kids) walk(child, visit, chain.concat([node]))
}

/** dumpLayout 的文件内容 → 树；不是 JSON 就当失败（并把前 80 字吐回去便于排查） */
export function parseDump(text) {
  const raw = String(text || '').trim()
  if (!raw) throw new Error('控件树是空的')
  try {
    return JSON.parse(raw)
  } catch (e) {
    throw new Error(`控件树不是合法 JSON：${raw.slice(0, 80)}`)
  }
}

/** 屏幕尺寸：根节点的 bounds 就是整屏，不用另外截图 */
export function screenSize(tree) {
  const b = parseBounds(attr(tree, 'bounds'))
  return b ? { w: b.w, h: b.h } : null
}

/**
 * 把树拍平成条目列表。每条记住自己的父链，点击时往上找可点容器。
 * 只留「有文字/描述」或「可点击」的节点；纯粹的布局容器全丢掉。
 *
 * 关键一步：桌面图标的文字挂在不可点的 Text 上，真正可点的容器自己没有文字。
 * 所以容器会把子节点的文字「借」过来当 label，并把那份重复的文字条目丢掉——
 * 否则模型看到的是一串 id，而不是「抖音 [可点]」。
 */
export function flatten(tree, { maxItems = 500 } = {}) {
  const items = []
  const claimed = [] // 已被可点容器借走的文字：{ label, bounds }

  const inside = (b, o) => b.x1 >= o.x1 - 2 && b.y1 >= o.y1 - 2 && b.x2 <= o.x2 + 2 && b.y2 <= o.y2 + 2

  const firstText = (node, depth = 2) => {
    const found = []
    const collect = (n, d) => {
      for (const child of n.children || []) {
        const t = String((child.attributes || {}).text || '').trim()
        if (t) found.push(t)
        if (d > 1) collect(child, d - 1)
      }
    }
    collect(node, depth)
    if (!found.length) return ''
    // 图标容器里除了名字还有未读角标（1、99+、时间…），别把角标当成图标名
    const score = (t) => (/^[\d:+\-%]+$/.test(t) ? -100 : 0) + Math.min(t.length, 20)
    let best = found[0]
    for (const t of found) if (score(t) > score(best)) best = t
    return best
  }

  walk(tree, (node, chain) => {
    if (items.length >= maxItems) return
    const a = node.attributes || {}
    const text = String(a.text || '').trim()
    const desc = String(a.description || '').trim()
    const clickable = String(a.clickable || '') === 'true'
    const scrollable = String(a.scrollable || '') === 'true'
    const id = String(a.id || '')
    if (!text && !desc && !clickable) return
    const bounds = parseBounds(a.bounds)
    if (!bounds || bounds.w <= 0 || bounds.h <= 0) return

    const own = text || desc
    const label = own || (clickable ? firstText(node) : '') || (id ? `(${id.slice(0, 24)})` : '')
    if (!own && label && clickable) claimed.push({ label, bounds })

    // 借来的文字已经在这层显示过了，子节点那份同样的文字就不用再列一遍
    if (own && claimed.some((c) => norm(c.label) === norm(own) && inside(bounds, c.bounds))) return
    // 未读角标 / 时间这类纯数字小字，落在已列出的图标容器里就不再单列（纯噪音）
    if (!clickable && own && /^[\d:+\-%]+$/.test(own) && claimed.some((c) => inside(bounds, c.bounds))) return

    items.push({
      text,
      desc,
      label,
      type: String(a.type || ''),
      id,
      bounds,
      raw: String(a.bounds || ''),
      clickable,
      scrollable,
      focused: String(a.focused || '') === 'true',
      chain,
      node,
    })
  })
  return items
}

/** 一行一条的紧凑视图；给模型看的就是这个 */
export function toLines(items, { maxLines = 40, textLen = 30 } = {}) {
  const out = []
  for (let i = 0; i < items.length && out.length < maxLines; i++) {
    const it = items[i]
    const label = it.label || it.text || it.desc
    if (!label) continue
    let s = String(label).replace(/\s+/g, ' ').slice(0, textLen)
    const flags = []
    if (it.clickable) flags.push('可点')
    if (it.scrollable) flags.push('可滚')
    if (it.focused) flags.push('聚焦')
    const pos = `@${it.bounds.cx},${it.bounds.cy}`
    out.push(`${out.length + 1}. ${s}${flags.length ? ` [${flags.join('/')}]` : ''} ${pos}`)
  }
  return out
}

/**
 * 找「可点击的那一层」：图标名字所在的 Text 自己往往 clickable=false，
 * 真正的热区是它上面的容器（id 里通常带着包名）。从最近的父节点往上找。
 */
export function clickTarget(item) {
  if (!item) return null
  if (item.clickable) return item
  const chain = item.chain || []
  for (let i = chain.length - 1; i >= 0; i--) {
    const node = chain[i]
    if (String(attr(node, 'clickable')) === 'true') {
      const b = parseBounds(attr(node, 'bounds'))
      if (b && b.w > 0 && b.h > 0) {
        return { bounds: b, raw: attr(node, 'bounds'), type: attr(node, 'type'), id: attr(node, 'id'), node }
      }
    }
  }
  return null
}

/** 点击点：优先可点容器中心，退而求其次用文本自己的中心 */
export function pointOf(item) {
  const t = clickTarget(item)
  if (t) return { x: t.bounds.cx, y: t.bounds.cy, via: t.id || t.type || '容器' }
  if (item && item.bounds) return { x: item.bounds.cx, y: item.bounds.cy, via: '文本自身' }
  return null
}

const norm = (s) => String(s || '').replace(/\s+/g, '').toLowerCase()

/**
 * 按文字找条目。顺序：完全相等 → 去空格等于 → 包含。
 * bundle 传了就再看 id 里有没有包名（桌面图标的 id 里带着 com.xxx）。
 */
export function findByText(items, query, { bundle = '' } = {}) {
  const q = norm(query)
  if (!q) return null
  const b = String(bundle || '').toLowerCase()
  const candidates = items.filter((it) => it.label || it.text || it.desc)
  const eq = candidates.find((it) => norm(it.label) === q)
  if (eq) return eq
  if (b) {
    // 桌面图标最靠谱：id 里带包名，且是图标容器（角标/文件夹的 id 也带包名，但没 AppIcon）
    const icon = items.find((it) => it.id && it.id.toLowerCase().includes(b) && /AppIcon|GridItem/i.test(it.id))
    if (icon) return icon
    const byBundle = items.find((it) => it.id && it.id.toLowerCase().includes(b))
    if (byBundle) return byBundle
  }
  const eq2 = candidates.find((it) => norm(it.label) === q || norm(it.desc) === q)
  if (eq2) return eq2
  // 包含匹配优先挑可点的：桌面上「精品应用」这类入口比正文里出现的同名词更有用
  const incAll = candidates.filter((it) => norm(it.label).includes(q))
  return incAll.find((it) => it.clickable) || incAll[0] || null
}

/** 当前前台窗口大概是什么 App：取最上层、面积最大的节点 id / 文字做个粗略判断 */
export function pageHint(items) {
  const first = items.find((it) => it.text && it.text.length <= 12 && it.clickable) || items[0]
  return first ? first.text || first.id : ''
}
