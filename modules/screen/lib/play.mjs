/**
 * 自主玩手机：主人说一句「去玩十分钟手机」，她真的去玩十分钟再回来汇报。
 *
 * 为什么是「模块里跑循环」而不是「她一条条自己发指令」：一轮 QQ 对话等不了十分钟。
 * 所以这里做成后台会话——先模拟人点开 App，然后每隔几秒：看一眼控件树 → 问一次模型
 * 「下一步做什么」→ 执行 → 记录。到点或踩雷就收手，回桌面，再让她用自己的语气汇报。
 *
 * 三条硬规矩：
 * 1) 动作只用「人能做到的」：点击、滑动、输入、返回；
 * 2) 涉及钱和不可逆的（支付、下单、删除、注销…）一律不做；
 * 3) 评论/发消息/关注/点赞属于对外发言，默认禁止，只有主人这次明确要求才放行。
 * 碰到登录、验证码、人脸，直接停——不绕过。
 */
import { sleep } from './hdc.mjs'
import { flatten, pointOf } from './layout.mjs'

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

export const SYSTEM = `你正在操作一台鸿蒙（HarmonyOS）手机，只能通过「可操作元素清单」了解屏幕。
清单每行形如：3. 首页 [可点] @120,2200（序号. 文字 [标记] @中心坐标）。

你必须像人一样操作：一次只做一个动作；做完会给你新的清单，别猜、别连做多步。

返回**一行 JSON**，不要任何解释、不要代码块：
{"why":"一句话说明你在干嘛","action":"click","idx":3}

可用 action：
- click  点第 idx 条元素（最常用）
- tap    点某个坐标：{"why":"...","action":"tap","x":540,"y":1200}
- swipe  慢滑：{"action":"swipe","dir":"up"}（dir 取 up/down/left/right）
- fling  快滑/甩动：{"action":"fling","dir":"up"}（刷下一个内容、快速滚列表）
- text   往当前光标输入文字：{"action":"text","text":"..."}
- key    按键：{"action":"key","key":"Back"}（只支持 Back / Home）
- wait   先别动，等 1~2 秒再看
- done   目标已经达成或该收工了：{"action":"done","why":"..."}

铁律：
- 只点清单里真实出现过的条目，不要编造序号；不确定就先 wait。
- 看到登录、验证码、人脸、指纹、支付、权限弹窗：立刻 {"action":"done"}，并在 why 里说明被什么拦住。
- 不做任何付款、下单、删除、卸载、注销、退出登录之类的动作。
- 不要连续点同一个位置；点了没反应就换一条或先 fling 换页面。
- 刷内容时优先 fling up（向上甩 = 看下一个），不要一次滑很多下。`

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

/** 动作是否被红线拦住；返回原因，没拦返回空串 */
export function screenAction(action, { allowPost = false } = {}) {
  const text = String([action.why, action.text, action.target].filter(Boolean).join(' '))
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
      startedAt: session.startedAt,
      elapsed: now() - session.startedAt,
      left: Math.max(0, session.deadline - now()),
      steps: session.steps,
      lastAction: session.lastAction,
      lastWhy: session.lastWhy,
    }
  }

  /** 控件树 → 「清单 + 序号→条目」；序号就是模型说的 idx */
  function renderLayout(tree) {
    const all = flatten(tree, { maxItems: 80 })
    const items = []
    const lines = []
    for (const it of all) {
      const label = it.label || it.text || it.desc
      if (!label) continue
      if (lines.length >= 45) break
      const flags = []
      if (it.clickable) flags.push('可点')
      if (it.scrollable) flags.push('可滚')
      lines.push(`${lines.length + 1}. ${label.replace(/\s+/g, ' ').slice(0, 28)}${flags.length ? ` [${flags.join('/')}]` : ''} @${it.bounds.cx},${it.bounds.cy}`)
      items.push(it)
    }
    return { items, lines }
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

  function targetLabel(action, items) {
    if (action.idx != null) {
      const it = items[Number(action.idx) - 1]
      return it ? `${it.label || it.text || it.desc || ''} ${action.text || ''}` : ''
    }
    return String(action.text || '')
  }

  function describe(action) {
    switch (action.action) {
      case 'click': return `点第 ${action.idx} 条`
      case 'tap': return `点 (${action.x},${action.y})`
      case 'swipe': return `慢滑 ${action.dir}`
      case 'fling': return `快滑 ${action.dir}`
      case 'text': return `输入「${String(action.text || '').slice(0, 12)}」`
      case 'key': return `按键 ${action.key}`
      case 'wait': return '等了一下'
      case 'done': return '收工'
      default: return `动作 ${action.action}`
    }
  }

  async function execute(action, items, size) {
    const dir = String(action.dir || 'up').toLowerCase()
    switch (action.action) {
      case 'click': {
        const it = items[Number(action.idx) - 1]
        if (!it) return { ok: false, error: `清单里没有第 ${action.idx} 条` }
        const pt = pointOf(it)
        if (!pt) return { ok: false, error: '条目没有坐标' }
        const r = await dev.click(pt.x, pt.y)
        return r.ok ? { ok: true, note: `点了「${(it.label || it.text || it.desc || it.id).slice(0, 16)}」` } : r
      }
      case 'tap': {
        const r = await dev.click(action.x, action.y)
        return r.ok ? { ok: true, note: '点了坐标' } : r
      }
      case 'swipe':
      case 'fling': {
        const r = await dev.swipeDir(dir, action.action === 'fling' ? 0.62 : 0.55, { size, fling: action.action === 'fling' })
        return r.ok ? { ok: true, note: '滑动成功' } : r
      }
      case 'text': {
        const r = await dev.type(action.text)
        return r.ok ? { ok: true, note: `输入了 ${String(action.text || '').length} 个字` } : r
      }
      case 'key': {
        const k = String(action.key || 'Back')
        if (!/^(Back|Home)$/.test(k)) return { ok: false, error: `这里只允许 Back / Home，不给 ${k}` }
        const r = await dev.key(k)
        return r.ok ? { ok: true, note: `按了 ${k}` } : r
      }
      case 'wait':
        await sleep(1600)
        return { ok: true, note: '等了一下' }
      case 'done':
        return { ok: true, note: '她觉得该收工了', done: true }
      default:
        return { ok: false, error: `不认识的动作 ${action.action}` }
    }
  }

  async function step() {
    const s = session
    if (!s || !s.running) return
    if (now() >= s.deadline) return finish('时间到')
    if (s.steps >= s.maxSteps) return finish('步数到上限')

    const l = await dev.layout({ wake: false })
    if (!l.ok) {
      s.fail++
      if (s.notes.length < 20) s.notes.push(`看不了屏幕：${l.error}`)
      if (s.fail >= 3) return finish('连着看不了屏幕')
      return schedule(2000)
    }
    s.fail = 0
    const { items, lines } = renderLayout(l.tree)
    // 挡路的小弹窗（「知道了」那种）先替她点掉，省一步也防卡死
    const cleared = await launcher.clearBlocking(items)
    if (cleared) {
      if (s.notes.length < 20) s.notes.push(`关掉了一个弹窗：${cleared}`)
      return schedule(1500)
    }
    const fg = await dev.foreground()
    const fgBundle = fg.ok ? fg.bundle : ''
    if (fgBundle && s.bundle && fgBundle !== s.bundle && !/sceneboard|launcher/i.test(fgBundle)) {
      s.notes.push(`从 ${s.bundle} 跑到 ${fgBundle}`)
      s.bundle = fgBundle
    }

    const elapsed = now() - s.startedAt
    const left = s.deadline - now()
    s.steps++

    const user = [
      `任务：${s.goal}`,
      `已经过去 ${mmss(elapsed)}，还剩 ${mmss(left)}，这是第 ${s.steps} 个动作。`,
      fgBundle ? `当前前台应用：${fgBundle}` : '',
      s.lastAction ? `上一个动作：${s.lastAction} —— ${s.lastResult}` : '',
      '可操作元素（从上到下）：',
      lines.join('\n') || '(这一屏没有可点元素)',
      '',
      allowNote(s),
      '只回一行 JSON。',
    ].filter(Boolean).join('\n')

    let action = null
    for (let t = 0; t < 2 && !action; t++) {
      try {
        const answer = await api.ask({ system: SYSTEM, text: user, maxTokens: 320 })
        action = pickJson(answer)
      } catch (e) {
        s.notes.push(`模型没答上来：${e && e.message}`)
        await sleep(1200)
      }
    }
    if (!action) {
      s.lastAction = '模型没给动作'
      s.lastResult = '先滑一下换个内容'
      await dev.swipeDir('up', 0.6, { size: l.size, fling: true })
      return schedule(2500)
    }

    const why = String(action.why || '').slice(0, 40)
    s.lastWhy = why
    const blocked = screenAction({ ...action, target: targetLabel(action, items) }, { allowPost: s.allowPost })
    if (blocked) {
      s.lastAction = describe(action)
      s.lastResult = `没做（${blocked}）`
      if (s.notes.length < 20) s.notes.push(`拦住 ${describe(action)}：${blocked}`)
      if (/登录|验证/.test(blocked)) return finish(blocked)
      return schedule(1500)
    }

    const res = await execute(action, items, l.size)
    s.lastAction = describe(action)
    s.lastResult = res.ok ? (res.note || '成功') : `失败：${res.error}`
    if (s.log.length < 30) s.log.push(`${describe(action)}${res.ok ? '' : '（没成）'}${why ? `——${why}` : ''}`)
    if (!res.ok) {
      s.fail++
      if (s.fail >= 3) return finish('连着三步都失败')
    }
    if (res.done) return finish('她自己觉得玩够了')
    return schedule(Math.max(1200, s.gap))
  }

  function schedule(delay) {
    const s = session
    if (!s || !s.running) return
    const wait = Math.max(800, Number(delay) || s.gap)
    s.timer = setTimeout(() => {
      step().catch((e) => {
        log.warn(`[screen] 自主循环出错：${e && e.message}`)
        const cur = session
        if (cur) {
          cur.fail++
          if (cur.fail >= 3) finish('循环出错太多')
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
    if (s.timer) { clearTimeout(s.timer); s.timer = null }

    const played = now() - s.startedAt
    const summary = [
      `玩了 ${mmss(played)}，做了 ${s.steps} 个动作，最后停在 ${s.bundle || '桌面'}。`,
      s.log.length ? `过程：${s.log.slice(-8).join('；')}` : '',
      s.notes.length ? `要说的：${s.notes.slice(-4).join('；')}` : '',
      `结束原因：${reason}`,
    ].filter(Boolean).join('\n')

    await dev.key('Home').catch(() => {})
    await sleep(600)

    let voice = summary
    try {
      const said = await api.think(
        `你刚在手机上玩了 ${mmss(played)}（任务：${s.goal}）。经过：${summary}\n用你自己的话，像跟主人聊天那样汇报三四句：先说玩了什么、看到什么好玩的，再说有没有卡住的地方。不要列动作清单，不要说"作为AI"，不要编你没看到的内容。`,
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
  async function start({ minutes = 10, app = '', goal = '', chatId = '', allowPost = false } = {}) {
    if (session) {
      return { ok: false, message: `已经在玩了（${session.app}，已经 ${mmss(now() - session.startedAt)}），要换就说"别玩了"` }
    }
    const mins = Math.min(Math.max(Number(minutes) || 10, 1), 30)
    const appName = String(app || '').trim()
    const aim = String(goal || '').trim() || (appName ? `在 ${appName} 上随便逛逛` : '随便挑个 App 逛逛，看看有什么好玩的')

    let target = appName
    if (!target) {
      // 没指定：从桌面能看到的图标里自己挑一个
      const icons = await launcher.desktopIcons()
      const pool = (icons.names || []).filter((n) => n && n.length <= 6 && !/^[0-9:：]+$/.test(n))
      target = pool.length ? pool[Math.floor(Math.random() * pool.length)] : ''
      if (!target) return { ok: false, message: '桌面上没认出可点的图标，直接说去哪个 App 吧' }
    }

    const opened = await launcher.open(target, { allowShell: cfg().allowShellLaunch !== false })
    if (!opened.ok) return { ok: false, message: opened.message }

    const gap = Math.min(Math.max(Number(cfg().stepMs) || 9000, 4000), 30000)
    session = {
      running: true,
      app: target,
      bundle: opened.bundle,
      goal: aim,
      allowPost: !!allowPost,
      chatId: String(chatId || ''),
      startedAt: now(),
      deadline: now() + mins * 60000,
      steps: 0,
      maxSteps: Math.min(150, Math.round((mins * 60000) / gap) + 6),
      gap,
      fail: 0,
      notes: [],
      log: [],
      lastAction: '',
      lastResult: '',
      lastWhy: '',
      timer: null,
    }
    log.info(`[screen] 开始自主玩手机：${target} ${mins} 分钟（${opened.via}）`)
    schedule(Math.max(1500, Math.round(gap / 2)))
    return {
      ok: true,
      message: `已经点开「${target}」（${opened.via}）开始玩了，${mins} 分钟后我回来汇报。要提前收工就说"别玩了"。`,
      until: session.deadline,
    }
  }

  return { start, stop, state }
}
