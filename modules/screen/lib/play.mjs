/**
 * 自主玩手机：主人说一句「去玩十分钟手机」，她真的去玩十分钟再回来汇报。
 *
 * 为什么是「模块里跑循环」而不是「她一条条自己发指令」：一轮 QQ 对话等不了十分钟。
 * 所以这里做成后台会话——每隔几秒决定下一步、执行、记录，时间到回桌面再汇报。
 *
 * 三条硬规矩：
 * 1) 动作只用「人能做到的 + 系统命令能做的」；
 * 2) 涉及钱和不可逆的（支付、下单、删除、注销…）一律不做；
 * 3) 评论/发消息/关注/点赞属于对外发言，默认禁止，只有主人这次明确要求才放行。
 * 碰到登录、验证码、人脸，直接停——不绕过。
 *
 * 省 token 的核心设计（主人提的）：**默认不看屏幕**。
 * - 命令层：open / stop / home / back 直接走系统命令，一次 execFile，几十 token；
 * - 手势层：fling / swipe / wait 按屏幕比例盲打，不需要坐标；
 * - 视觉层：只有「要点屏幕上某个具体东西」或每 K 个动作做一次校验时，才 dump 一帧。
 * 一帧控件树文本约 800 token，截图更是图像 token，所以「能不看就不看」。
 */
import { sleep } from './hdc.mjs'
import { flatten, pointOf } from './layout.mjs'
import { APPS, resolveApp } from './apps.mjs'

/** 钱和不可逆动作：任何时候都不做 */
const DANGER = [
  '支付', '付款', '确认支付', '转账', '红包', '下单', '提交订单', '购买', '立即购买',
  '充值', '提现', '退款', '删除', '删掉', '卸载', '清除', '格式化', '注销', '解绑',
  '退出登录', '恢复出厂', '授权定位', '开启定位',
]

/** 对外发言：默认禁止，主人明确说了才放行 */
const OUTWARD = ['发布', '发送', '评论', '回复', '关注', '点赞', '私信', '分享', '加好友', '收藏', '转发']

/** 撞上这些就立刻收手（不尝试绕过） */
const STOPWORDS = ['登录', '验证码', '人脸', '指纹', '密码', '滑块', '身份验证']

/** 不需要看屏幕就能做的动作：模型优先从这里挑 */
export const BLIND = ['open', 'stop', 'home', 'back', 'fling', 'swipe', 'wait', 'key']

export const SYSTEM = `你正在操作一台鸿蒙（HarmonyOS）手机。**默认不看屏幕**：能用命令和手势办到的事，就别要求看界面。
但你**是来读的，不是来滑的**：进了有内容的页面（帖子、回答、文章、视频详情、商品详情），先把这屏看懂，
用 note 记一句你读到了什么，再决定下一步。

返回**一行 JSON**，不要解释、不要代码块。可以是单个动作，也可以是 {"actions":[动作1,动作2,动作3]}（最多 3 个连贯动作，会被按顺序执行，任一步失败就停）。

动作（先挑不需要看屏幕的）：
- open   打开应用：{"action":"open","app":"抖音"}（走系统命令，一步到位）
- stop   停掉应用：{"action":"stop","app":"抖音"}
- home   回桌面：{"action":"home"}
- back   返回：{"action":"back"}
- fling  甩动，刷内容的主力：{"action":"fling","dir":"up"}（dir 取 up/down/left/right）
- swipe  慢滑：{"action":"swipe","dir":"up","amount":0.5}
- key    按键：{"action":"key","key":"Back"}（只支持 Back / Home）
- wait   停一下再看：{"action":"wait","ms":1600}
- text   往当前输入框打字：{"action":"text","text":"..."}
- click  点清单里的第 idx 条：{"action":"click","idx":3}（**必须有当前清单**）
- tap    点某个坐标：{"action":"tap","x":540,"y":1200}
- note   记一句你读到了什么：{"action":"note","text":"这篇说雪穗她妈拿女儿身体换钱，作者把恶归给泡沫经济"}
        必须是你刚在这屏上真读到的（谁说了什么、讲了哪件事），40 字以内；不要写「看了个帖子」这种空话。
- dump   我要看一帧当前界面：{"action":"dump"}（这一帧要花钱，只在真需要定位内容时用）
- done   收工：{"action":"done","why":"..."}

铁律：
- 只有在**给了清单**的时候才能 click；没给清单就先用 open/fling/home/back 这类盲动作。
- **读了就记**：每进一个新内容页，dump 一帧读懂，然后 note 下来（一批动作里可以 dump + note 连着给）。
  同一页不要拿同一件事重复 note。
- note 是收工汇报的唯一依据：没 note 就等于没读，汇报时只能说「没读进去」。
- done 只允许三种情况：剩下不到总时长的 15%、撞上登录/验证码/权限弹窗、同一界面连着 3 次没变化。
  还有时间、或者记下的条数还不够，就继续读，不要因为「感觉差不多了」收工。
- 看到登录、验证码、人脸、指纹、支付、权限弹窗：立刻 done，并在 why 里说明被什么拦住。
- 不做任何付款、下单、删除、卸载、注销、退出登录之类的动作。
- 不要连着做两次一模一样的动作；fling 两次没变化就换 open 或 back。
- 想评论/点赞/收藏：先 dump 看清内容，并且只在这轮被授权时才做。`

const now = () => Date.now()
const mmss = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(s / 60)} 分 ${String(s % 60).padStart(2, '0')} 秒`
}

/** 从模型回复里抠出第一个 JSON 对象（模型爱加前后缀，这里宽容一点） */
export function pickJson(text) {
  const s = String(text || '')
  const start = s.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < s.length; i++) {
    const ch = s[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') { inStr = true; continue }
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        try { return JSON.parse(s.slice(start, i + 1)) } catch { return null }
      }
    }
  }
  return null
}

/** 模型回复 → 动作数组（支持 {"actions":[...]}，也支持单个动作对象） */
export function pickActions(raw, { max = 3 } = {}) {
  const obj = raw && typeof raw === 'object' ? raw : pickJson(raw)
  if (!obj) return []
  const list = Array.isArray(obj.actions) ? obj.actions : [obj]
  return list
    .filter((a) => a && typeof a === 'object' && a.action)
    .slice(0, Math.max(1, max))
}

/** 页面指纹：文字集合（丢掉纯数字的角标和时钟），用来判断「滑了但内容没变」 */
export function frameSignature(items) {
  return (items || [])
    .map((i) => i.label)
    .filter((l) => l && !/^[\d:+\-%]+$/.test(l))
    .join('|')
}

/** 这一帧相对上一帧有什么变化（给模型看的一小行，比整棵树的 diff 便宜太多） */
export function diffLabels(labels, prevLabels) {
  const prev = new Set(prevLabels || [])
  const cur = new Set(labels || [])
  const added = [...cur].filter((l) => !prev.has(l))
  const removed = [...prev].filter((l) => !cur.has(l))
  return { added, removed: removed.length, changed: added.length > 0 || removed.length > 0 }
}

/** 一帧是否算「和上一帧一样」 */
export function sameScreen(sigA, sigB) {
  return String(sigA || '') === String(sigB || '') && String(sigA || '') !== ''
}

/** 中文数字 → 阿拉伯数字（只覆盖「几分钟」里会出现的那些） */
const CN_MIN = {
  一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
  十: 10, 十一: 11, 十二: 12, 十三: 13, 十四: 14, 十五: 15,
  二十: 20, 二十二: 22, 二十五: 25, 二十八: 28, 三十: 30,
}

/** 「半小时 / 一刻钟 / 十分钟 / 30 分钟」→ 分钟数；没提时长返回 0 */
export function askMinutes(text) {
  const t = String(text || '')
  if (/半(个)?(小时|钟头)/.test(t)) return 30
  if (/一刻钟/.test(t)) return 15
  if (/一(个)?(小时|钟头)/.test(t)) return 60
  const m = /([0-9]{1,2}|十[一二三四五六七八九]?|二十[一二三四五六七八九]?|三十)\s*分钟/.exec(t)
  if (!m) return 0
  if (/^[0-9]+$/.test(m[1])) return Number(m[1])
  return CN_MIN[m[1]] || 0
}

/** 「几篇 / 三篇 / 多看几篇」→ 这次要读进几条；没提返回 0（用设置） */
export function askWant(text) {
  const t = String(text || '')
  const m = /([0-9]{1,2}|两|三|四|五|六|七|八|九|十)\s*篇/.exec(t)
  if (m) {
    const n = /^[0-9]+$/.test(m[1]) ? Number(m[1]) : (CN_MIN[m[1]] || 0)
    if (n) return Math.min(Math.max(n, 1), 12)
  }
  if (/(多|再)(看|读|找|刷|翻)(几|两|三|五|十)?篇/.test(t)) return 5
  return 0
}

/** 句子里提到的 App（取最长的那个名字，避免「B站」被「站」吃掉之类） */
export function askApp(text) {
  const lower = String(text || '').toLowerCase()
  let best = ''
  for (const name of Object.keys(APPS)) {
    if (name.length < 2) continue
    if (!lower.includes(name.toLowerCase())) continue
    if (name.length > best.length) best = name
  }
  return best
}

/**
 * 「主人是不是在让我去玩手机」——模块侧直接判断，不再赌她会不会调 screen_play。
 *
 * 只接**祈使句**：句首是 去 / 帮我 / 给我 / 让我 / 让 / 自己 / 你，或者 刷|玩|看|逛 + 手机/App。
 * 「我昨天去玩了十分钟」这种自我叙述不接，避免把聊天当命令。
 * 返回 { minutes, app, want, goal }，接不住返回 null。
 */
export function parsePlayAsk(text, { defaultMinutes = 10 } = {}) {
  const goal = String(text || '').trim()
  if (!goal || goal.length > 120) return null
  if (/(别玩|别刷|不要|不用|不想|先别|等我|等会|取消)/.test(goal)) return null

  const app = askApp(goal)
  const head = goal.slice(0, 10).replace(/^[\s　]+/, '')
  const imperative = /^(那|好|行|嗯|ok|OK)?\s*(你|你自己|帮我|帮我去|给我|让我|让|去|自己)/.test(head)
  const bare = /^(那|好|行|嗯)?\s*(刷|玩|逛|看)(会儿|一会|一下|一圈|阵子)/.test(head) && (!!app || /手机/.test(goal))
  if (!imperative && !bare) return null

  const minutes = askMinutes(goal)
  const playish = /(玩|刷|逛|看|找|读|翻)/.test(goal)
  if (!minutes && !(playish && (app || /手机/.test(goal)))) return null

  return { minutes: minutes || defaultMinutes, app, want: askWant(goal), goal }
}

/** 界面上那些模板化的按钮/栏目词：拼「正文摘录」时要滤掉，免得模型把按钮当内容读 */
const CHROME = new Set([
  '首页', '关注', '推荐', '热榜', '视频', '想法', '直播', '返回', '分享', '收藏',
  '点赞', '赞同', '反对', '评论', '更多', '搜索', '发布', '写回答', '邀请回答',
  '查看全部', '展开', '收起', '关注问题', '已关注', '打开', '复制', '举报',
  '不感兴趣', '下一个', '播放', '暂停', '关注了', '赞同了', '收藏了',
])

/**
 * 控件树 → 「清单 + 序号→条目」；序号就是模型说的 idx。
 * maxChars 决定一条能看多少字：太短会把正文截成半句（默认 60 字，够放一整段短评）。
 */
export function renderFrame(items, { maxLines = 28, maxChars = 60 } = {}) {
  const lines = []
  for (const it of items) {
    const label = it.label || it.text || it.desc
    if (!label) continue
    if (lines.length >= maxLines) break
    const flags = []
    if (it.clickable) flags.push('可点')
    if (it.scrollable) flags.push('可滚')
    lines.push(`${lines.length + 1}. ${String(label).replace(/\s+/g, ' ').slice(0, maxChars)}${flags.length ? ` [${flags.join('/')}]` : ''} @${it.bounds.cx},${it.bounds.cy}`)
  }
  return lines
}

/**
 * 正文摘录：把这一屏真正「像句子」的文字按阅读顺序拼起来（滤掉按钮词、纯数字、太短的标签）。
 * 这是给她读内容用的，跟「清单」（找按钮用）分开——清单带序号和坐标，摘录只给文字。
 */
export function pickSnippet(items, { maxChars = 500, minLen = 8 } = {}) {
  const out = []
  let used = 0
  for (const it of items) {
    const label = String(it.label || it.text || it.desc || '').replace(/\s+/g, ' ').trim()
    if (label.length < minLen) continue
    if (CHROME.has(label)) continue
    if (/^\(.*\)$/.test(label)) continue                    // 没有文字的容器，只有个 id：不是正文
    if (/^[\d:+\-%.,，。！？!?、；;]+$/.test(label.replace(/\s+/g, ''))) continue
    if (used + label.length > maxChars) break
    out.push(label)
    used += label.length + 1
  }
  return out.join('\n')
}

/**
 * 记一条「读到了什么」。同一件事不重复记，最多留 max 条（最早的自然淘汰）。
 * 返回新数组，不改传进来的那个。
 */
export function addTakeaway(list, text, { max = 12, maxLen = 60 } = {}) {
  const cur = Array.isArray(list) ? list.slice() : []
  const t = String(text || '').replace(/\s+/g, ' ').trim().slice(0, maxLen)
  if (!t) return cur
  const norm = (s) => s.replace(/[\s，,。.！!？?、；;：:]/g, '')
  const hit = cur.find((x) => {
    const a = norm(x)
    const b = norm(t)
    return a === b || (b.length >= 6 && a.includes(b)) || (a.length >= 6 && b.includes(a))
  })
  if (hit) return cur
  cur.push(t)
  if (cur.length > max) cur.splice(0, cur.length - max)
  return cur
}

/**
 * 模型说 done 的时候，到底准不准它收工。
 * 三道闸门，任一没过就无视：
 * 1) 收获不够：这次要 want 条「读到了什么」，没攒够且还剩 15% 以上时间 → 继续读；
 * 2) 时间还多（默认剩 30% 以上）；
 * 3) 步数太少（刚开没多久）。
 * 但最多只拦 maxDoneIgnores 次：拦太多次会把整轮拖成死循环，宁可让她收工。
 */
export function shouldIgnoreDone({
  left = 0, total = 0, steps = 0, ignored = 0,
  minSteps = 8, graceRatio = 0.3,
  takeaways = 0, want = 0, maxDoneIgnores = 4,
} = {}) {
  if (Number(ignored) >= Number(maxDoneIgnores)) return false
  const totalMs = Number(total) || 0
  const leftMs = Number(left) || 0
  if (Number(want) > 0 && Number(takeaways) < Number(want) && leftMs > totalMs * 0.15) return true
  const grace = Math.max(0, Number(graceRatio) || 0.3)
  if (leftMs > totalMs * grace) return true
  if (Number(steps) < Number(minSteps)) return true
  return false
}

/** 这个错误是不是「手机/hdc 不行了」（这种才算致命，动作失败不算） */
export function isHdcError(message) {
  return /hdc|no device|not connected|offline|unauthorized|connect failed|设备|连不上|没连上/i.test(String(message || ''))
}

/** 动作是否被红线拦住；返回原因，没拦返回空串 */
export function screenAction(action, { allowPost = false } = {}) {
  const text = String([action.why, action.text, action.target, action.app].filter(Boolean).join(' '))
  for (const w of DANGER) if (text.includes(w)) return `涉及钱或不可逆操作（${w}）`
  for (const w of STOPWORDS) if (text.includes(w)) return `需要登录/验证（${w}），不绕过`
  if (!allowPost) {
    for (const w of OUTWARD) if (text.includes(w)) return `对外发言（${w}），这次没授权`
  }
  return ''
}

export function createPlay({ api, dev, launcher, settings, log }) {
  let session = null
  const cfg = () => (typeof settings === 'function' ? settings() : settings || {})

  function state() {
    if (!session) return { running: false }
    return {
      running: session.running,
      app: session.app,
      goal: session.goal,
      mode: session.mode,
      startedAt: session.startedAt,
      elapsed: now() - session.startedAt,
      left: Math.max(0, session.deadline - now()),
      steps: session.steps,
      dumps: session.dumps,
      blind: session.blind,
      takeaways: session.takeaways.length,
      want: session.want,
      softFails: session.softFails,
      reason: session.reason || '',
      lastAction: session.lastAction,
      lastWhy: session.lastWhy,
      trace: session.trace.slice(-20),
    }
  }

  /** 看一帧（唯一花钱的地方，所有调用都从这里走） */
  async function dumpFrame(s, why = '') {
    const l = await dev.layout({ wake: false })
    if (!l.ok) return { ok: false, error: l.error }
    const items = flatten(l.tree)
    const labels = items.map((i) => i.label).filter(Boolean)
    const diff = diffLabels(labels, s.frame ? s.frame.labels : [])
    const lines = renderFrame(items, { maxLines: s.frameLines, maxChars: s.frameChars })
    const snippet = s.snippetChars > 0 ? pickSnippet(items, { maxChars: s.snippetChars }) : ''
    s.frame = {
      items,
      labels,
      lines,
      snippet,
      noted: false,
      size: l.size || s.size,
      sig: frameSignature(items),
      changed: diff.changed,
      at: now(),
    }
    if (l.size) s.size = l.size
    s.dumps++
    s.actionsSinceDump = 0
    s.lastDumpWhy = why
    if (snippet) {
      s.recent = (s.recent || []).concat([{ app: s.bundle || s.app || '', snippet, at: now() }]).slice(-3)
    }
    if (why) log.debug(`[screen] dump（${why}）：${items.length} 节点，清单 ${lines.length} 行，正文 ${snippet.length} 字，${diff.changed ? `有变化 +${diff.added.length}` : '和上一帧一样'}`)
    return { ok: true, frame: s.frame, diff }
  }

  function stop(reason) {
    if (!session) return { running: false }
    const s = session
    session = null
    s.running = false
    if (s.timer) { clearTimeout(s.timer); s.timer = null }
    if (reason) log.info(`[screen] 自主玩手机结束：${reason}`)
    return { running: false, reason }
  }

  function allowNote(s) {
    return s.allowPost
      ? '这次主人明确允许发评论/发消息这类对外操作，可以做，但只做任务要求的。'
      : '这次没有对外发言授权：不要评论、不要发消息、不要关注/点赞/收藏/转发。'
  }

  function describe(action) {
    const a = String(action.action || '')
    switch (a) {
      case 'open': return `打开 ${action.app || '?'}`
      case 'stop': return `停掉 ${action.app || '?'}`
      case 'home': return '回桌面'
      case 'back': return '按返回'
      case 'click': return `点第 ${action.idx} 条`
      case 'tap': return `点 (${action.x},${action.y})`
      case 'swipe': return `慢滑 ${action.dir || 'up'}`
      case 'fling': return `快滑 ${action.dir || 'up'}`
      case 'text': return `输入「${String(action.text || '').slice(0, 10)}」`
      case 'key': return `按键 ${action.key}`
      case 'wait': return '等了一下'
      case 'note': return `记「${String(action.text || '').slice(0, 12)}」`
      case 'dump': return '看了一帧'
      case 'done': return '收工'
      default: return `动作 ${a || '?'}`
    }
  }

  /** 执行一个动作；不看屏幕的动作走这里就不产生帧成本 */
  async function execute(s, action) {
    const dir = String(action.dir || 'up').toLowerCase()
    switch (action.action) {
      case 'open': {
        const app = String(action.app || '').trim()
        if (!app) return { ok: false, error: 'open 要带 app' }
        const r = await launcher.open(app, { mode: s.mode, allowShell: true, maxPages: s.maxPages })
        if (!r.ok) return { ok: false, error: r.message || '打不开' }
        if (r.bundle) {
          s.bundle = r.bundle
          s.opened.add(String(r.bundle).toLowerCase())
          s.app = app
        }
        s.frame = null // 换应用了，上一帧作废
        return { ok: true, note: `开到了 ${r.bundle || app}（${r.via}）`, via: r.via, visual: true }
      }
      case 'stop': {
        const app = String(action.app || '').trim()
        if (!app) return { ok: false, error: 'stop 要带 app' }
        const { bundle } = resolveApp(app, launcher.learned || null)
        if (!bundle) return { ok: false, error: `不知道「${app}」的包名` }
        const mine = s.opened.has(String(bundle).toLowerCase())
        if (!mine && cfg().allowForceStop === false) {
          return { ok: false, error: `「${app}」不是这次开的，设置里也没允许停别人` }
        }
        const r = await dev.forceStop(bundle)
        if (!r.ok) return { ok: false, error: r.error }
        s.opened.delete(String(bundle).toLowerCase())
        s.frame = null
        return { ok: true, note: `停了 ${bundle}` }
      }
      case 'home':
        await dev.key('Home')
        await sleep(900)
        s.frame = null
        return { ok: true, note: '回桌面了' }
      case 'back':
        await dev.key('Back')
        await sleep(800)
        return { ok: true, note: '按了返回' }
      case 'key': {
        const k = String(action.key || 'Back')
        if (!/^(Back|Home)$/.test(k)) return { ok: false, error: `这里只允许 Back / Home，不给 ${k}` }
        await dev.key(k)
        await sleep(600)
        if (k === 'Home') s.frame = null
        return { ok: true, note: `按了 ${k}` }
      }
      case 'swipe':
      case 'fling': {
        const amount = action.action === 'fling' ? 0.62 : Math.min(Math.max(Number(action.amount) || 0.55, 0.2), 0.9)
        const r = await dev.swipeDir(dir, amount, { size: s.size, fling: action.action === 'fling' })
        return r.ok ? { ok: true, note: `${action.action === 'fling' ? '甩' : '滑'}了 ${dir}` } : r
      }
      case 'text': {
        const r = await dev.type(action.text)
        return r.ok ? { ok: true, note: `输入了 ${String(action.text || '').length} 个字` } : r
      }
      case 'wait': {
        await sleep(Math.min(Math.max(Number(action.ms) || 1600, 600), 8000))
        return { ok: true, note: '等了一下' }
      }
      case 'note': {
        const text = String(action.text || '').trim()
        if (!text) return { ok: false, error: 'note 要带 text（你读到了什么）' }
        const before = s.takeaways.length
        s.takeaways = addTakeaway(s.takeaways, text, { max: 12, maxLen: 60 })
        if (s.frame) s.frame.noted = true
        const added = s.takeaways.length > before
        return {
          ok: true,
          note: added ? `记下第 ${s.takeaways.length} 条：${s.takeaways[s.takeaways.length - 1].slice(0, 24)}` : '这条之前记过了，跳过',
          noted: added,
        }
      }
      case 'click': {
        if (!s.frame || !s.frame.items.length) {
          const d = await dumpFrame(s, 'click 但手里没有帧')
          if (!d.ok) return { ok: false, error: d.error }
        }
        const it = s.frame.items[Number(action.idx) - 1]
        if (!it) return { ok: false, error: `清单里没有第 ${action.idx} 条` }
        const pt = pointOf(it)
        if (!pt) return { ok: false, error: '条目没有坐标' }
        const r = await dev.click(pt.x, pt.y)
        return r.ok ? { ok: true, note: `点了「${(it.label || it.text || it.desc || it.id).slice(0, 14)}」`, visual: true } : r
      }
      case 'tap': {
        const r = await dev.click(action.x, action.y)
        return r.ok ? { ok: true, note: `点了 (${action.x},${action.y})`, visual: true } : r
      }
      case 'dump': {
        const d = await dumpFrame(s, '模型点名要看')
        return d.ok ? { ok: true, note: '看了一帧' } : { ok: false, error: d.error }
      }
      case 'done':
        return { ok: true, note: '她想收工了', done: true, why: action.why }
      default:
        return { ok: false, error: `不认识的动作 ${action.action}` }
    }
  }

  function buildPrompt(s) {
    const elapsed = now() - s.startedAt
    const left = Math.max(0, s.deadline - now())
    const head = [
      `任务：${s.goal}`,
      `时间：已过 ${mmss(elapsed)}，还剩 ${mmss(left)}。第 ${s.steps} 个动作，模式：${s.mode === 'human' ? '像人一样点' : '优先用系统命令'}。`,
      s.want ? `收获：已记下 ${s.takeaways.length} 条，这次至少要 ${s.want} 条「你读到了什么」才算读过。` : '',
      s.bundle ? `前台应用：${s.bundle}` : '',
      s.lastAction ? `上一批动作：${s.lastAction} —— ${s.lastResult}` : '',
    ].filter(Boolean)

    const parts = [...head]
    if (s.takeaways.length) {
      parts.push('你已经记下的（别重复记同一件事）：')
      parts.push(s.takeaways.slice(-5).map((t, i) => `${i + 1}. ${t}`).join('\n'))
    }
    if (s.frame) {
      const age = Math.round((now() - s.frame.at) / 1000)
      parts.push(`清单（${age} 秒前看的${age > 12 ? '，可能已经变了' : ''}${s.frame.changed ? '，与上一帧相比有变化' : '，与上一帧基本一样'}）：`)
      parts.push(s.frame.lines.join('\n') || '(这屏没有可辨认的元素)')
      if (s.frame.snippet) {
        parts.push('这屏的正文（读它，不要只找按钮）：')
        parts.push(s.frame.snippet)
      }
      if (!s.frame.noted) parts.push('这屏你还没记过：读完先 note 一句你要记住的内容，再翻页或点下一层。')
    } else {
      parts.push('现在没有当前清单：请用不需要看屏幕的动作（open / stop / home / back / fling / swipe / wait），需要看清再返回 dump。')
    }
    parts.push(allowNote(s))
    parts.push('只回一行 JSON（可以给 {"actions":[...]} 最多 3 个连贯动作）。')
    return parts.join('\n')
  }

  async function tick() {
    const s = session
    if (!s || !s.running) return
    if (now() >= s.deadline) return finish('timeout')
    /** 主人随时可能喊停：任何一次 await 回来都要先看这个会话还算不算数 */
    const dead = () => session !== s

    // 到点该校验一帧（或者刚换过应用、或者手里根本没帧）
    if (!s.frame || s.actionsSinceDump >= s.dumpEvery || s.needFrame) {
      const d = await dumpFrame(s, s.needFrame ? '要求校验' : '每 K 个动作校验一次')
      if (dead()) return
      s.needFrame = false
      if (!d.ok) {
        s.layoutFails++
        if (s.layoutFails >= 3) return finish('hdc-lost')
        return schedule(2000)
      }
      s.layoutFails = 0
      // 挡路的小弹窗（「知道了」那种）先替她点掉
      if (s.frame.items.length <= 10) {
        const cleared = await launcher.clearBlocking(s.frame.items)
        if (cleared) {
          pushTrace(s, `关掉弹窗「${cleared}」`)
          await sleep(1000)
          s.frame = null
          return schedule(1200)
        }
      }
    }

    const fg = await dev.foreground()
    if (dead()) return
    if (fg.ok && fg.bundle && s.bundle && fg.bundle !== s.bundle && !/sceneboard|launcher/i.test(fg.bundle)) {
      s.drifted++
      pushTrace(s, `跑到了 ${fg.bundle}（第 ${s.drifted} 次）`)
      if (s.drifted >= 2 && s.app) {
        // 两次都不在目标 App 里：把它拉回来，别收工
        pushTrace(s, `漂移太多，重新打开 ${s.app}`)
        s.drifted = 0
        const r = await launcher.open(s.app, { mode: s.mode })
        if (r.ok && r.bundle) s.bundle = r.bundle
        s.frame = null
        return schedule(Math.round(s.gap / 2))
      }
    } else if (fg.ok && fg.bundle) {
      s.drifted = Math.max(0, s.drifted - 1)
    }

    let actions = []
    for (let attempt = 0; attempt < 2 && !actions.length; attempt++) {
      try {
        const answer = await api.ask({ system: SYSTEM, text: buildPrompt(s), maxTokens: 420 })
        actions = pickActions(answer, { max: 3 })
      } catch (e) {
        s.notes.push(`模型没答上来：${e && e.message}`)
        await sleep(1200)
      }
    }
    if (!actions.length) {
      // 模型答不上来不该让循环停：先甩一下换个内容，下一轮再问
      s.softFails++
      s.lastAction = '模型没给动作'
      s.lastResult = '先甩一下换个内容'
      await dev.swipeDir('up', 0.6, { size: s.size, fling: true })
      s.actionsSinceDump++
      if (s.softFails >= s.maxRecoverable) return finish('give-up')
      return schedule(2500)
    }

    const batchNotes = []
    for (const action of actions) {
      if (now() >= s.deadline) break
      // 主人可能在上一步执行的中间就喊停了：这一批动作一个都不许再落到手机上
      if (session !== s) return
      // note 只是记一句话，没有任何副作用：它描述的内容里出现「登录」也不该被当成撞墙
      const blocked = action.action === 'note' ? '' : screenAction(action, { allowPost: s.allowPost })
      if (blocked) {
        s.lastAction = describe(action)
        s.lastResult = `没做（${blocked}）`
        pushTrace(s, `拦住 ${describe(action)}：${blocked}`)
        if (/登录|验证/.test(blocked)) return finish('login-wall')
        // 被拦下来的动作不算失败，但也不能当成功；换下一个动作
        continue
      }
      if (action.action === 'done') {
        if (shouldIgnoreDone({
          left: s.deadline - now(),
          total: s.totalMs,
          steps: s.steps,
          ignored: s.doneIgnored,
          minSteps: s.minSteps,
          graceRatio: s.graceRatio,
          takeaways: s.takeaways.length,
          want: s.want,
          maxDoneIgnores: s.maxDoneIgnores,
        })) {
          s.doneIgnored++
          s.softFails = 0
          const left = s.deadline - now()
          const lacking = s.want > s.takeaways.length
          const byGain = lacking && left > s.totalMs * 0.15
          const why = byGain
            ? `收获还差 ${s.want - s.takeaways.length} 条`
            : (s.steps < s.minSteps ? '才走了几步' : '时间还多')
          pushTrace(s, `不让她收工（${why}，第 ${s.doneIgnored} 次），还剩 ${mmss(left)}`)
          s.lastAction = '她想收工'
          s.lastResult = `不让收工：${why}，继续`
          continue
        }
        return finish('done')
      }

      const res = await execute(s, action)
      s.steps++
      s.actionsSinceDump++
      if (action.action === 'note') { /* 记一笔不读屏，不算视觉动作 */ }
      else if (!BLIND.includes(action.action) && action.action !== 'dump') s.visualActions = (s.visualActions || 0) + 1
      else if (BLIND.includes(action.action)) s.blind++
      s.lastAction = describe(action)
      s.lastResult = res.ok ? (res.note || '成功') : `失败：${res.error}`
      pushTrace(s, `${describe(action)} → ${res.ok ? '成' : `没成（${String(res.error || '').slice(0, 24)}）`}`)
      batchNotes.push(`${describe(action)}${res.ok ? '' : '没成'}`)

      if (!res.ok) {
        s.softFails++
        s.needFrame = true // 失败多半是界面和她以为的不一样，下一轮先看一眼
        if (isHdcError(res.error)) {
          s.layoutFails++
          if (s.layoutFails >= 2) return finish('hdc-lost')
        }
        if (s.softFails >= s.maxRecoverable) return finish('give-up')
        break // 这一批到此为止，别拿旧认知继续做
      }
      s.softFails = Math.max(0, s.softFails - 1)
    }

    if (!s.frame) s.needFrame = true
    return schedule(s.gap)
  }

  function pushTrace(s, line) {
    if (s.trace.length < 40) s.trace.push(line)
    else { s.trace.shift(); s.trace.push(line) }
    log.debug(`[screen] ${line}（第 ${s.steps} 步，剩 ${mmss(s.deadline - now())}）`)
  }

  function schedule(delay) {
    const s = session
    if (!s || !s.running) return
    const wait = Math.max(700, Number(delay) || s.gap)
    s.timer = setTimeout(() => {
      tick().catch((e) => {
        log.warn(`[screen] 自主循环出错：${e && e.message}`)
        const cur = session
        if (cur) {
          cur.softFails++
          if (cur.softFails >= cur.maxRecoverable) finish('give-up')
          else schedule(2000)
        }
      })
    }, wait)
    if (s.timer.unref) s.timer.unref()
  }

  async function finish(reason) {
    const s = session
    if (!s) return
    session = null
    s.running = false
    s.reason = reason
    if (s.timer) { clearTimeout(s.timer); s.timer = null }

    const played = now() - s.startedAt
    const late = now() - s.deadline
    log.info(`[screen] 自主玩手机结束：${reason}（玩了 ${mmss(played)}，${s.steps} 步，${s.dumps} 帧，记了 ${s.takeaways.length} 条${late > 60000 ? `；比预定晚了 ${mmss(late)}，多半是电脑睡眠冻住了定时器` : ''}）`)

    const summary = [
      `玩了 ${mmss(played)}，做了 ${s.steps} 个动作；看了 ${s.dumps} 帧界面（其中 ${s.blind || 0} 个动作完全没看屏幕），记下 ${s.takeaways.length} 条读到的东西；最后停在 ${s.bundle || '桌面'}。`,
      s.trace.length ? `过程：${s.trace.slice(-6).join('；')}` : '',
      s.notes.length ? `要说的：${s.notes.slice(-4).join('；')}` : '',
      `结束原因：${reason}`,
    ].filter(Boolean).join('\n')

    /** 汇报的唯一依据：她自己记下的那几条 + 最后两屏正文，而不是动作清单 */
    const picks = s.takeaways.slice(-8)
    const recent = (s.recent || []).slice(-2).map((r) => `·（${r.app || '手机'}）${r.snippet}`)
    const evidence = [
      picks.length ? `你这次真读到的（${picks.length} 条）：\n${picks.map((t, i) => `${i + 1}. ${t}`).join('\n')}` : '',
      recent.length ? `最后两屏的正文摘录：\n${recent.join('\n')}` : '',
    ].filter(Boolean).join('\n')

    await dev.key('Home').catch(() => {})
    await sleep(600)

    let voice = summary
    try {
      const said = await api.think(
        `你刚在手机上玩了 ${mmss(played)}（任务：${s.goal}）。${summary}\n` +
        `${evidence || '（这次一条「读到了什么」都没记下来）'}\n` +
        '用你自己的话，像跟主人聊天那样汇报三到五句：\n' +
        '1) 至少说出两三个具体的点：哪一篇/谁说的/讲了什么，就用上面记下的内容，不要复述动作；\n' +
        '2) 一条都没记的话，就照实说「这次没真读进去，只翻了半天」，不要编；\n' +
        '3) 不要列动作清单，不要说「作为 AI」。',
        { title: '玩手机汇报', timeoutMs: 120000 },
      )
      if (said && String(said).trim()) voice = String(said).trim()
    } catch (e) {
      log.warn(`[screen] 汇报生成失败，改发原始摘要：${e && e.message}`)
    }

    if (s.chatId) {
      try {
        await api.send(s.chatId, voice)
      } catch (e) {
        log.error(`[screen] 汇报发送失败：${e && e.message}`)
      }
    }
  }

  /** 开始一次「自主玩手机」 */
  async function start({ minutes = 10, app = '', goal = '', chatId = '', allowPost = false, mode = '', dumpEvery = 0, want = 0 } = {}) {
    if (session) {
      return { ok: false, message: `已经在玩了（${session.app}，已经 ${mmss(now() - session.startedAt)}），要换就说"别玩了"` }
    }
    const mins = Math.min(Math.max(Number(minutes) || 10, 1), 30)
    const appName = String(app || '').trim()
    const aim = String(goal || '').trim() || (appName ? `在 ${appName} 上随便逛逛` : '随便挑个 App 逛逛，看看有什么好玩的')
    const conf = cfg()
    const playMode = /^(human|humanlike|人|像人)$/i.test(String(mode || '')) ? 'human' : (conf.preferCommandOpen === false ? 'human' : 'fast')

    let target = appName
    if (!target) {
      const icons = await launcher.desktopIcons()
      const pool = (icons.names || []).filter((n) => n && n.length <= 6 && !/^[0-9:：]+$/.test(n))
      target = pool.length ? pool[Math.floor(Math.random() * pool.length)] : ''
      if (!target) return { ok: false, message: '桌面上没认出可点的图标，直接说去哪个 App 吧' }
    }

    const opened = await launcher.open(target, { allowShell: conf.allowShellLaunch !== false, mode: playMode })
    if (!opened.ok) return { ok: false, message: opened.message }

    const gap = Math.min(Math.max(Number(conf.stepMs) || 4500, 3000), 30000)
    const totalMs = mins * 60000
    const keep = 20000 // 收尾留 20 秒：回桌面 + 生成汇报
    session = {
      running: true,
      app: target,
      bundle: opened.bundle,
      goal: aim,
      mode: playMode,
      allowPost: !!allowPost,
      chatId: String(chatId || ''),
      startedAt: now(),
      deadline: now() + Math.max(30000, totalMs - keep),
      totalMs,
      steps: 0,
      dumps: 0,
      blind: 0,
      visualActions: 0,
      softFails: 0,
      layoutFails: 0,
      doneIgnored: 0,
      drifted: 0,
      takeaways: [],
      want: Math.min(Math.max(Number(want) || Number(conf.playWant) || 3, 0), 12),
      maxDoneIgnores: Math.min(Math.max(Number(conf.maxDoneIgnores) || 4, 1), 10),
      frameLines: Math.min(Math.max(Number(conf.frameLines) || 28, 12), 60),
      frameChars: Math.min(Math.max(Number(conf.frameChars) || 60, 20), 200),
      snippetChars: Math.min(Math.max(Number(conf.snippetChars) || 500, 0), 2000),
      recent: [],
      graceRatio: Math.min(Math.max(Number(conf.doneGraceRatio) || 0.3, 0), 0.8),
      minSteps: Math.min(Math.max(Number(conf.minSteps) || 8, 0), 60),
      maxRecoverable: Math.min(Math.max(Number(conf.maxRecoverable) || 12, 3), 60),
      dumpEvery: Math.min(Math.max(Number(dumpEvery) || Number(conf.dumpEvery) || 3, 1), 10),
      actionsSinceDump: 0,
      needFrame: true,
      maxPages: 4,
      gap,
      frame: null,
      size: null,
      opened: new Set(opened.bundle ? [String(opened.bundle).toLowerCase()] : []),
      notes: [],
      trace: [],
      lastAction: '',
      lastResult: '',
      lastWhy: '',
      timer: null,
    }
    log.info(`[screen] 开始自主玩手机：${target} ${mins} 分钟（${opened.via}，模式 ${playMode}，每 ${session.dumpEvery} 个动作看一帧，目标 ${session.want} 条收获）`)
    schedule(Math.max(1200, Math.round(gap / 2)))
    return {
      ok: true,
      message: `已经打开「${target}」（${opened.via}）开始玩了，${mins} 分钟后我回来汇报（这次至少要读进 ${session.want} 条内容才收工）。要提前收工就说"别玩了"。`,
      until: session.deadline,
    }
  }

  return { start, stop, state }
}
