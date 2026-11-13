/**
 * screen —— 用 hdc 操作一台鸿蒙手机（HarmonyOS NEXT / 5 / 6 / 7 都走这一套）。
 *
 * 定位：她在这台手机上长出一双手。截图看画面、读控件树、点、滑、打字、按键、
 * 像人一样从桌面点开 App（桌面没有就走下拉搜索），还能「自己去玩十分钟再回来汇报」。
 *
 * 为什么不用投屏插件：投屏工具挂在 profile 根上，她的私聊预设看不见；模块跑在
 * Aurabot 自己的宿主里，直接 shell 出去最省事，也不用额外装东西。
 *
 * 权限：全部工具只在主人私聊里可用（level === 'full'）。群友拿不到手机。
 *
 * @type {import('../aurabot').AurabotModule}
 */
import { createHdc, resolveHdc, hdcCandidates } from './lib/hdc.mjs'
import { createDevice } from './lib/device.mjs'
import { createLauncher, resolveBundle } from './lib/launcher.mjs'
import { resolveApp } from './lib/apps.mjs'
import { flatten, findByText, pointOf, toLines } from './lib/layout.mjs'
import { createPlay, parsePlayAsk } from './lib/play.mjs'

export default {
  id: 'screen',
  name: '手机屏幕',
  version: '1.2.1',
  api: 1,
  description: '用 hdc 操作鸿蒙手机：命令开应用、点按滑、打字、看图看文字，还能自己去玩一阵、边看边记内容再回来汇报',
  defaults: {
    hdc: '',
    sn: '',
    wake: true,
    allowShellLaunch: true,
    preferCommandOpen: true,
    allowForceStop: true,
    allowPost: false,
    stepMs: 4500,
    dumpEvery: 3,
    playMinutes: 10,
    autoPlay: true,
    playWant: 3,
    frameLines: 28,
    frameChars: 60,
    snippetChars: 500,
    doneGraceRatio: 0.3,
    minSteps: 8,
    maxDoneIgnores: 4,
    maxRecoverable: 12,
  },
  settings: [
    { key: 'hdc', label: 'hdc 路径', type: 'text', hint: '留空自动找：PATH → HM_SDK_HOME → D:\\ohos-sdk\\toolchains\\toolchains\\hdc.exe', placeholder: 'D:\\ohos-sdk\\toolchains\\toolchains\\hdc.exe' },
    { key: 'sn', label: '设备 SN', type: 'text', hint: '留空就用第一台；多台都连着时必须填（hdc list targets 能看到）' },
    { key: 'wake', label: '操作前先唤醒屏幕', type: 'switch' },
    { key: 'preferCommandOpen', label: '开应用优先用系统命令（aa start）', type: 'switch', hint: '开：一步到位、省时间省 token；关：退回「点图标 + 搜索」的像人流程' },
    { key: 'allowShellLaunch', label: '允许用系统命令开应用', type: 'switch', hint: '完全关掉就只用「点图标」这一条路（某些受限机型可能需要）' },
    { key: 'allowForceStop', label: '允许用命令停掉点名的应用', type: 'switch', hint: '关掉后只能停「这次自己开的」应用' },
    { key: 'allowPost', label: '允许她自己在手机上发评论/发消息', type: 'switch', hint: '默认关。开了以后她才可能在刷手机时留言，仍然只在主人私聊生效' },
    { key: 'stepMs', label: '自主玩时两个动作之间的间隔（毫秒）', type: 'number', min: 3000, max: 30000, step: 500 },
    { key: 'dumpEvery', label: '自主玩时每几个动作看一次屏幕', type: 'number', min: 1, max: 10, step: 1, hint: '越大越省 token，越小越不容易迷路；默认 3' },
    { key: 'playMinutes', label: '说「玩十分钟」但没说数字时的默认时长（分钟）', type: 'number', min: 1, max: 30, step: 1 },
    { key: 'autoPlay', label: '主人说「去玩手机」时由模块直接开玩', type: 'switch', hint: '默认开：识别到「去玩十分钟手机」「去知乎找几篇，半小时」就自己启动循环，不再赌她会不会调工具。关掉后只靠她自己决定调 screen_play' },
    { key: 'playWant', label: '自主玩时至少要读进几条内容才算「读过」', type: 'number', min: 0, max: 12, step: 1, hint: '默认 3。没攒够就无视她的「收工」；填 0 = 不看收获，只看时间' },
    { key: 'frameLines', label: '自主玩时每帧给几行界面文字', type: 'number', min: 12, max: 60, step: 1, hint: '默认 28。越大越不容易漏内容，也越费 token' },
    { key: 'frameChars', label: '自主玩时每条界面文字最多几个字', type: 'number', min: 20, max: 200, step: 10, hint: '默认 60。太短会把长段落截成半句' },
    { key: 'snippetChars', label: '自主玩时每帧附带的正文摘录字数上限', type: 'number', min: 0, max: 2000, step: 100, hint: '默认 500；填 0 = 不给摘录，只给清单' },
  ],
  panel: 'panel.js',

  setup(api) {
    const cfg = () => api.settings()
    const log = api.log
    const allowsShell = () => cfg().allowShellLaunch !== false
    const wakeBefore = () => cfg().wake !== false

    /** 每次按当前设置新建 hdc（设置改了不用重载模块） */
    const getHdc = () => createHdc({ bin: resolveHdc(cfg().hdc), sn: (cfg().sn || '').trim() })
    const hdcFacade = {
      sh: (cmd, timeout) => getHdc().sh(cmd, timeout),
      recv: (remote, local, timeout) => getHdc().recv(remote, local, timeout),
      health: () => getHdc().health(),
      targets: () => getHdc().targets(),
    }

    const dev = createDevice({ hdc: hdcFacade, dataDir: (p) => api.dataDir(p), log })
    const launcher = createLauncher({ dev, log })
    const play = createPlay({ api, dev, launcher, settings: cfg, log })

    /**
     * 主人说「去玩十分钟手机」「去知乎找几篇书评，半小时」——模块自己接住，直接开玩。
     * 为什么不让给她：她会不会调 screen_play 是不确定的（规则写得再硬也可能被当成闲聊），
     * 一旦她选择"嘴上说去了"，十分钟就白费了。这里只认主人私聊 + 祈使句，接住就回一句"去了"。
     */
    api.on('message', async (msg) => {
      try {
        if (cfg().autoPlay === false) return false
        if (!msg || msg.kind !== 'private') return false
        if (typeof api.isOwner === 'function' && !api.isOwner(msg.userId)) return false
        if (play.state().running) return false
        const ask = parsePlayAsk(msg.text, { defaultMinutes: Number(cfg().playMinutes) || 10 })
        if (!ask) return false
        log.info(`[screen] 接住「${String(msg.text).slice(0, 24)}」：直接开玩 ${ask.app || '随便挑一个'} ${ask.minutes} 分钟${ask.want ? `，目标 ${ask.want} 条` : ''}`)
        const r = await play.start({
          minutes: ask.minutes,
          app: ask.app,
          goal: ask.goal,
          want: ask.want,
          chatId: msg.chatId,
          allowPost: false,
        })
        const want = Math.max(ask.want || Number(cfg().playWant) || 3, 1)
        await api.reply(msg, r.ok
          ? `去了${ask.app ? `，看${ask.app}` : ''}。${ask.minutes} 分钟后回来，这次至少要读进 ${want} 条内容才收工。`
          : r.message)
        return true
      } catch (e) {
        log.warn(`[screen] 接「去玩手机」出错：${e && e.message}`)
        return false
      }
    })

    /** 给自己看一眼：当前在什么界面（给失败信息垫底用） */
    async function peek(chatId) {
      const l = await dev.layout({ wake: wakeBefore() })
      if (!l.ok) return { ok: false, error: l.error }
      const items = flatten(l.tree)
      return { ok: true, size: l.size, items, text: toLines(items, { maxLines: 12 }).join('\n') }
    }

    function ownerGuard(level) {
      if (level === 'full') return null
      return { ok: false, message: '这台手机只有主人私聊里能用（群聊和别人不行）' }
    }

    api.tool(({ chat, level }) => {
      if (chat.kind === 'system') return []
      const guard = () => ownerGuard(level)

      return [
        api.defineTool({
          name: 'screen_see',
          description: '看一眼手机现在的画面：截图并发到聊天里。想知道屏幕上有什么、现在停在哪个界面时用。',
          properties: {},
          execute: async () => {
            const g = guard(); if (g) return g
            const r = await dev.shot({ wake: wakeBefore() })
            if (!r.ok) return { ok: false, message: r.error }
            if (api.sendImage) { try { await api.sendImage(chat.chatId, r.local) } catch { /* 发图失败不影响结论 */ } }
            return { ok: true, message: `已截图 ${r.width}x${r.height}，图已经发到聊天里了。` }
          },
        }),
        api.defineTool({
          name: 'screen_layout',
          description: '把手机当前界面的控件读成文字清单（每行「序号. 文字 [可点] @坐标」）。看不清截图、或者要点文字类按钮时用它；点的时候可以直接用序号。',
          properties: {
            max: { type: 'number', description: '最多返回几行，默认 30' },
            filter: { type: 'string', description: '只留包含这个词的行，比如「搜索」「发送」' },
          },
          execute: async ({ max, filter }) => {
            const g = guard(); if (g) return g
            const l = await dev.layout({ wake: wakeBefore() })
            if (!l.ok) return { ok: false, message: l.error }
            let items = flatten(l.tree)
            if (filter) {
              const q = String(filter)
              items = items.filter((i) => (i.label || i.text || i.desc || '').includes(q))
            }
            const lines = toLines(items, { maxLines: Math.min(Math.max(Number(max) || 30, 5), 60) })
            const fg = await dev.foreground()
            return {
              ok: true,
              message: `${l.size ? `屏幕 ${l.size.w}x${l.size.h}` : '屏幕尺寸未知'}；前台 ${fg.ok ? fg.bundle : '未知'}；共 ${items.length} 个可辨认节点：\n${lines.join('\n') || '(没有可点/有文字的节点)'}`,
            }
          },
        }),
        api.defineTool({
          name: 'screen_tap',
          description: '在手机上点一下。可以按序号（最近一次 screen_layout 的序号）、按文字、或按比例坐标。点之前最好先看一眼画面。',
          properties: {
            idx: { type: 'number', description: 'screen_layout 里的序号' },
            text: { type: 'string', description: '要点的文字，比如「发送」「首页」' },
            fx: { type: 'number', description: '横向比例 0~1（和 fy 一起用）' },
            fy: { type: 'number', description: '纵向比例 0~1' },
          },
          execute: async ({ idx, text, fx, fy }) => {
            const g = guard(); if (g) return g
            if (text) {
              const l = await dev.layout({ wake: wakeBefore() })
              if (!l.ok) return { ok: false, message: l.error }
              const hit = findByText(flatten(l.tree), String(text), { bundle: resolveBundle(String(text)) })
              if (!hit) return { ok: false, message: `这屏没找到「${text}」。可以 screen_layout 看看现在有什么。` }
              const pt = pointOf(hit)
              const r = await dev.click(pt.x, pt.y)
              if (!r.ok) return { ok: false, message: r.error }
              return { ok: true, message: `点了「${hit.label || hit.text || hit.desc || hit.id}」(${pt.x},${pt.y})` }
            }
            if (idx != null) {
              const l = await dev.layout({ wake: wakeBefore() })
              if (!l.ok) return { ok: false, message: l.error }
              const items = flatten(l.tree)
              const it = items[Number(idx) - 1]
              if (!it) return { ok: false, message: `没有第 ${idx} 条，当前共 ${items.length} 条` }
              const pt = pointOf(it)
              const r = await dev.click(pt.x, pt.y)
              if (!r.ok) return { ok: false, message: r.error }
              return { ok: true, message: `点了第 ${idx} 条「${it.label || it.text || it.desc || it.id}」(${pt.x},${pt.y})` }
            }
            if (Number.isFinite(Number(fx)) && Number.isFinite(Number(fy))) {
              const l = await dev.layout({ wake: wakeBefore() })
              if (!l.ok || !l.size) return { ok: false, message: l.error || '拿不到屏幕尺寸' }
              const x = Math.round(l.size.w * Number(fx))
              const y = Math.round(l.size.h * Number(fy))
              const r = await dev.click(x, y)
              if (!r.ok) return { ok: false, message: r.error }
              return { ok: true, message: `点了 (${x},${y})` }
            }
            return { ok: false, message: '要给 idx / text / (fx,fy) 其中一个' }
          },
        }),
        api.defineTool({
          name: 'screen_swipe',
          description: '在手机上滑动。刷视频、翻列表、切桌面页都用它。',
          properties: {
            direction: { type: 'string', description: 'up / down / left / right' },
            amount: { type: 'number', description: '滑多远，占屏幕 0.15~0.9，默认 0.55' },
            times: { type: 'number', description: '连滑几次，默认 1，最多 3' },
            fast: { type: 'boolean', description: 'true 用快滑（甩），刷内容更快' },
          },
          required: ['direction'],
          execute: async ({ direction, amount, times, fast }) => {
            const g = guard(); if (g) return g
            const n = Math.min(Math.max(Number(times) || 1, 1), 3)
            const l = await dev.layout({ wake: wakeBefore() })
            if (!l.ok) return { ok: false, message: l.error }
            for (let i = 0; i < n; i++) {
              const r = await dev.swipeDir(String(direction), amount, { size: l.size, fling: !!fast })
              if (!r.ok) return { ok: false, message: r.error }
            }
            return { ok: true, message: `已向 ${direction} 滑 ${n} 次` }
          },
        }),
        api.defineTool({
          name: 'screen_type',
          description: '往手机输入文字。先点一下输入框再调它；给了 fx/fy 就先点那个位置。',
          properties: {
            text: { type: 'string', description: '要输入的文字' },
            fx: { type: 'number', description: '可选：先点这个横向比例位置（0~1）' },
            fy: { type: 'number', description: '可选：先点这个纵向比例位置（0~1）' },
          },
          required: ['text'],
          execute: async ({ text, fx, fy }) => {
            const g = guard(); if (g) return g
            if (Number.isFinite(Number(fx)) && Number.isFinite(Number(fy))) {
              const l = await dev.layout({ wake: wakeBefore() })
              if (!l.ok || !l.size) return { ok: false, message: l.error || '拿不到屏幕尺寸' }
              const x = Math.round(l.size.w * Number(fx))
              const y = Math.round(l.size.h * Number(fy))
              const r = await dev.typeAt(x, y, text)
              if (!r.ok) return { ok: false, message: r.error }
              return { ok: true, message: `点了输入框并输入：${text}` }
            }
            const r = await dev.type(text)
            if (!r.ok) {
              return { ok: false, message: `${r.error}（如果没反应，说明输入框没聚焦：先用 screen_tap 点一下输入框）` }
            }
            return { ok: true, message: `已输入：${text}` }
          },
        }),
        api.defineTool({
          name: 'screen_key',
          description: '按手机的实体键：Back 返回、Home 回桌面、Power 电源键。也可以给 KeyCode 数字。',
          properties: { key: { type: 'string', description: 'Back / Home / Power 或 KeyCode 数字' } },
          required: ['key'],
          execute: async ({ key }) => {
            const g = guard(); if (g) return g
            const r = await dev.key(key)
            if (!r.ok) return { ok: false, message: r.error }
            await dev.sleep(500)
            return { ok: true, message: `按了 ${r.key}` }
          },
        }),
        api.defineTool({
          name: 'screen_open',
          description: '打开手机上的一个 App。默认走系统命令一步到位（快、不用看屏幕）；命令打不开才退回「桌面点图标 → 滑屏找 → 下拉搜索」。可以给名字（抖音、QQ、小红书…）或包名。想看着她像人一样点，把 via 设成 human。',
          properties: {
            app: { type: 'string', description: '应用名或包名' },
            via: { type: 'string', description: 'auto（默认，按设置）/ command（只走命令）/ human（只走点图标和搜索）' },
            maxPages: { type: 'number', description: '最多翻几屏找，默认 4' },
          },
          required: ['app'],
          execute: async ({ app, via, maxPages }) => {
            const g = guard(); if (g) return g
            const want = String(via || '').toLowerCase()
            const mode = want === 'human' ? 'human' : want === 'command' ? 'fast' : (cfg().preferCommandOpen === false ? 'human' : 'fast')
            const allowShell = want === 'human' ? allowsShell() : true
            const r = await launcher.open(app, { maxPages, allowShell, mode })
            return { ok: r.ok, message: r.message, data: { via: r.via, bundle: r.bundle, ability: r.ability, tried: r.tried } }
          },
        }),
        api.defineTool({
          name: 'screen_app',
          description: '用系统命令管一个 App：start 打开、stop 停掉、restart 重开、state 看它在不在前台。这类事不必看屏幕，比一层层点快得多。',
          properties: {
            action: { type: 'string', description: 'start / stop / restart / state' },
            app: { type: 'string', description: '应用名或包名' },
          },
          required: ['action'],
          execute: async ({ action, app }) => {
            const g = guard(); if (g) return g
            const act = String(action || '').toLowerCase()
            const name = String(app || '').trim()
            if (act === 'state') {
              const fg = await dev.foreground()
              if (!fg.ok) return { ok: false, message: fg.error || '读不到前台应用' }
              if (!fg.bundle || fg.system) return { ok: true, message: '现在在桌面/系统界面，没有 App 在前台' }
              const { bundle } = resolveApp(name || fg.bundle)
              const hit = !name || (bundle && (fg.bundle.includes(bundle) || bundle.includes(fg.bundle)))
              return { ok: true, message: `前台是 ${fg.bundle} / ${fg.ability || '?'}${name ? `（${hit ? '就是它' : '不是它'}）` : ''}` }
            }
            if (!name) return { ok: false, message: '要给 app' }
            if (act === 'stop') {
              const { bundle } = resolveApp(name)
              if (!bundle) return { ok: false, message: `不知道「${name}」的包名，没法用命令停` }
              if (cfg().allowForceStop === false) return { ok: false, message: '设置里关掉了「用命令停应用」' }
              const r = await dev.forceStop(bundle)
              return { ok: r.ok, message: r.ok ? `停了 ${bundle}` : r.error }
            }
            if (act === 'restart') {
              const { bundle } = resolveApp(name)
              if (!bundle) return { ok: false, message: `不知道「${name}」的包名` }
              if (cfg().allowForceStop === false) return { ok: false, message: '设置里关掉了「用命令停应用」，没法重开' }
              await dev.forceStop(bundle)
              await dev.sleep(800)
              const r = await launcher.openViaCommand(name)
              return { ok: r.ok, message: r.ok ? `重开了：${r.message}` : r.reason }
            }
            if (act === 'start') {
              const r = await launcher.open(name, { mode: cfg().preferCommandOpen === false ? 'human' : 'fast', allowShell: true })
              return { ok: r.ok, message: r.message, data: { via: r.via, bundle: r.bundle } }
            }
            return { ok: false, message: 'action 只能是 start / stop / restart / state' }
          },
        }),
        api.defineTool({
          name: 'screen_status',
          description: '手机状态：连没连上、型号、系统版本、当前前台应用、有没有正在「自动玩」。',
          properties: {},
          execute: async () => {
            const g = guard(); if (g) return g
            const info = await dev.info()
            const fg = await dev.foreground()
            const st = play.state()
            return {
              ok: info.ok,
              message: [
                info.ok ? `已连接 ${info.model || '未知型号'}（${info.os || info.version}）` : `没连上：${info.error}`,
                info.targets && info.targets.length ? `设备：${info.targets.join(', ')}` : '',
                info.hdcVersion ? `hdc ${info.hdcVersion}` : '',
                fg.ok ? (fg.system || !fg.bundle ? '前台：桌面/系统界面' : `前台：${fg.bundle} / ${fg.ability}`) : '前台：读不到',
                st.running
                  ? `正在自动玩：${st.app}（${st.mode}），已 ${Math.round(st.elapsed / 60000 * 10) / 10} 分钟，走了 ${st.steps} 步，看了 ${st.dumps} 帧，记下 ${st.takeaways || 0}/${st.want || 0} 条收获`
                  : '没在自动玩',
              ].filter(Boolean).join('\n'),
            }
          },
        }),
        api.defineTool({
          name: 'screen_play',
          description: '自己去玩手机：打开一个 App，自己决定每一步（甩着看内容、点开帖子、开别的 App 再回来…），边看边记下读到的东西，玩到时间再回桌面并汇报。主人说「去玩十分钟手机」，或者**给了时限还要求多看几篇/找几篇**（"去知乎找《白夜行》书评，半小时，多看几篇"）时都必须用它——不要自己用工具轮转两圈就回来回答。默认优先用系统命令、并且不每步都看屏幕，省时间也省 token。不指定 app 就自己从桌面上挑一个。',
          properties: {
            minutes: { type: 'number', description: '玩几分钟，1~30，默认按设置。主人给了时限（半小时/30 分钟）就按他说的填' },
            app: { type: 'string', description: '应用名或包名，比如 抖音 / QQ / 知乎 / 小红书；不填就自己挑' },
            goal: { type: 'string', description: '这次想干嘛，比如「随便刷一刷，看看有没有好玩的视频」「找《白夜行》的书评，多读几篇」' },
            want: { type: 'number', description: '这次至少要读进几条具体内容（几篇/几个观点），默认按设置的 3。主人说「多看几篇」就按他说的篇数填' },
            mode: { type: 'string', description: 'fast（默认，优先命令+盲操作）/ human（像人一样点图标、搜索）' },
            allowPost: { type: 'boolean', description: '这次是否允许评论/发消息/关注点赞。只有主人明确要求才传 true' },
          },
          execute: async ({ minutes, app, goal, want, mode, allowPost }) => {
            const g = guard(); if (g) return g
            const mins = Number(minutes) || Number(cfg().playMinutes) || 10
            const r = await play.start({
              minutes: mins,
              app,
              goal,
              want,
              mode,
              allowPost: !!allowPost && cfg().allowPost !== false,
              chatId: chat.chatId,
            })
            return { ok: r.ok, message: r.message }
          },
        }),
        api.defineTool({
          name: 'screen_stop',
          description: '让她马上别玩手机了，回桌面。',
          properties: {},
          execute: async () => {
            const g = guard(); if (g) return g
            const was = play.state()
            play.stop('主人喊停')
            await dev.key('Home').catch(() => {})
            return { ok: true, message: was.running ? `停了（${was.app}，玩了 ${Math.round(was.elapsed / 60000 * 10) / 10} 分钟），已经回桌面` : '本来就没在玩' }
          },
        }),
      ]
    })

    /** 主人手打的快捷命令：/手机 看 / 状态 / 开 抖音 / 玩 10 抖音 / 停 */
    api.command({
      name: '手机',
      aliases: ['screen', 'hos'],
      desc: '操作鸿蒙手机：/手机 看|状态|桌面|开 <应用>|停 <应用>|玩 <分钟> [应用]|停',
      run: async (arg, msg) => {
        const a = String(arg || '').trim()
        const chatId = (msg && msg.chatId) || ''
        if (!a || /^(看|截图|shot|see)$/.test(a)) {
          const r = await dev.shot({ wake: wakeBefore() })
          if (!r.ok) return r.error
          if (api.sendImage && chatId) { try { await api.sendImage(chatId, r.local) } catch { /* 发图失败就只回文字 */ } }
          return `截图好了（${r.width}x${r.height}）`
        }
        if (/^(状态|status)$/.test(a)) {
          const info = await dev.info()
          if (!info.ok) return `没连上：${info.error}`
          const fg = await dev.foreground()
          return `${info.model} · ${info.os}\n前台：${fg.ok ? fg.bundle : '未知'}\n设备：${(info.targets || []).join(', ') || '-'}`
        }
        if (/^桌面|^home$/.test(a)) {
          const r = await launcher.home()
          return r.ok ? '回桌面了' : '按了 Home，但前台还不是桌面'
        }
        if (/^(开|open)\s+/.test(a)) {
          let name = a.replace(/^(开|open)\s+/, '').trim()
          const human = /(像人|human)$/.test(name)
          name = name.replace(/\s*(像人|human)$/, '').trim()
          const r = await launcher.open(name, {
            allowShell: allowsShell(),
            mode: human || cfg().preferCommandOpen === false ? 'human' : 'fast',
          })
          return r.message
        }
        if (/^(停|stop)\s+/.test(a)) {
          const name = a.replace(/^(停|stop)\s+/, '').trim()
          const { bundle } = resolveApp(name)
          if (!bundle) return `不知道「${name}」的包名，没法用命令停`
          if (cfg().allowForceStop === false) return '设置里关掉了「用命令停应用」'
          const r = await dev.forceStop(bundle)
          return r.ok ? `停了 ${bundle}` : r.error
        }
        if (/^(停|stop)$/.test(a)) {
          const st = play.state()
          play.stop('主人喊停')
          await dev.key('Home').catch(() => {})
          return st.running ? '停了，回桌面了' : '本来就没在玩'
        }
        if (/^玩/.test(a)) {
          const raw = a.replace(/^玩/, '').trim()
          const human = /(像人|human)$/.test(raw)
          const parts = raw.replace(/\s*(像人|human)$/, '').trim().split(/\s+/).filter(Boolean)
          const minutes = Number(parts[0]) || Number(cfg().playMinutes) || 10
          const app = Number(parts[0]) ? parts[1] || '' : parts[0] || ''
          const goal = (Number(parts[0]) ? parts.slice(2) : parts.slice(1)).join(' ')
          const r = await play.start({ minutes, app, goal, chatId, allowPost: false, mode: human ? 'human' : '' })
          return r.message
        }
        return '用法：/手机 看|状态|桌面|开 <应用> [像人]|停 <应用>|玩 <分钟> [应用] [想干嘛…] [像人]|停'
      },
    })

    /** 面板用的两个小接口 */
    api.route('/status', async () => {
      const info = await dev.info()
      const st = play.state()
      return { ...info, playing: st, hdcCandidates: hdcCandidates().slice(0, 5) }
    })

    /** 最近走的十几步：出问题时看这个就知道是哪种刹车踩的 */
    api.route('/play', async () => {
      const st = play.state()
      return {
        running: !!st.running,
        app: st.app || '',
        mode: st.mode || '',
        steps: st.steps || 0,
        dumps: st.dumps || 0,
        blind: st.blind || 0,
        takeaways: st.takeaways || 0,
        want: st.want || 0,
        left: st.left || 0,
        reason: st.reason || '',
        trace: st.trace || [],
      }
    })

    api.route('/shot', async () => {
      const r = await dev.shot()
      if (!r.ok) return { ok: false, error: r.error }
      try {
        const { readFile } = await import('node:fs/promises')
        const buf = await readFile(r.local)
        return { ok: true, width: r.width, height: r.height, dataUrl: `data:image/jpeg;base64,${buf.toString('base64')}` }
      } catch (e) {
        return { ok: false, error: `读截图失败：${e.message}` }
      }
    })

    api.rule(() => [
      '你连着主人的一台鸿蒙手机（HarmonyOS）。你能读界面文字、看截图、点、滑、打字、按键，也能用系统命令直接开/停应用。',
      '工具：screen_app 用命令开/停/重开/查前台、screen_open 打开 App、screen_see 截图、screen_layout 读成文字、screen_tap 点、screen_swipe 滑、screen_type 打字、screen_key 按键、screen_status 看状态、screen_play 去玩一会儿、screen_stop 停下。',
      '省事的顺序：能走命令就别动手——开应用先 screen_app(start) 或 screen_open；停/重开用 screen_app；回桌面用 screen_key Home。这类操作完全不用先看屏幕。',
      '要看屏幕的时候才看：想知道屏幕上有哪些文字/按钮，用 screen_layout（文字清单，比截图便宜）；只有主人想看画面、或要判断纯图形内容时才 screen_see。',
      '真要点东西的时候：先用 screen_layout 拿序号，再 screen_tap idx——不要凭记忆报坐标。',
      '点了没反应就换方法，不要重复同一下：先 screen_key Back，或者 screen_app(restart) 重开；两次都不成就直说没成。',
      '说结果前先确认：没成功就直说没成功，不要描述你没看到的东西。',
      '主人说「去玩十分钟手机」「自己刷会儿抖音」这类话：用 screen_play（app 填他说的那个，minutes 按他说的，没说就按设置）。开了以后你会先回一句「去了」，到点她会自己回来汇报——不要在那十分钟里反复追问。',
      '主人给了时限、或者要求「多看几篇/多找几篇」：同样必须用 screen_play，把他说的时长填进 minutes、把「几篇」填进 want（「半小时去知乎找《白夜行》书评，多看几篇」就传 minutes:30, app:"知乎", goal:"找《白夜行》书评，多读几篇", want:5）。不要自己用 screen_open + screen_layout 转两圈、找到一篇就回来回答——那等于把他给的半小时扔了。',
      '她自己在循环里读到的内容会记成 note（每篇一两句）。汇报时讲的是这些内容：哪一篇、谁的观点、哪句话。说不出具体东西就照实说没读进去，不要拿「我滑了几下、点了几下」充数。',
      '你自己用工具看完内容回来回答主人时，也一样：先说读到了什么具体的东西，再说过程。',
      '红线（任何情况下都不做）：付款、下单、转账、充值、删除、卸载、注销、退出登录；碰到登录/验证码/人脸就停下来说明白，绝不绕过。',
      '评论、发消息、关注、点赞属于对外发言：只有当主人在这一轮明确让你这么做、并且 screen_play 传了 allowPost 才可以，否则只浏览。',
    ].join('\n'))

    api.onDispose(() => {
      try { play.stop('模块停止') } catch { /* 忽略 */ }
    })

    log.info(`[screen] 手机控制模块已加载（hdc: ${resolveHdc(cfg().hdc)}${(cfg().sn || '').trim() ? `，SN: ${(cfg().sn || '').trim()}` : ''}）`)
  },
}
