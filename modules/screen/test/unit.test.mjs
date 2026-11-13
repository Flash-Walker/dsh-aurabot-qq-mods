/**
 * 纯逻辑单测：不碰手机、不碰网络，只验控件树解析 / 点击点计算 / JSON 抽取 / 红线过滤。
 * 跑法：node --test test/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parseBounds, parseDump, screenSize, flatten, findByText, clickTarget, pointOf, toLines,
} from '../lib/layout.mjs'
import { pickJson, pickActions, screenAction, shouldIgnoreDone, diffLabels, frameSignature, isHdcError, renderFrame, pickSnippet, addTakeaway, parsePlayAsk } from '../lib/play.mjs'
import { resolveBundle } from '../lib/launcher.mjs'
import { APPS, abilityFromIconId, resolveApp, learnFromItems, pickAbilities } from '../lib/apps.mjs'

/** 一段迷你控件树，结构照拄真机（图标名字不可点，热区在带包名 id 的父容器上） */
const tree = {
  attributes: { bounds: '[0,0][1080,2406]', type: '' },
  children: [
    {
      attributes: { type: 'GridItem', id: 'SwiperPage_GridItem_[com.ss.hm.ugc.aweme___4060086280___0,1]', bounds: '[24,1063][282,1351]' },
      children: [
        {
          attributes: { type: 'RelativeContainer', clickable: 'true', id: 'Container_AppIcon_Image_com.ss.hm.ugc.awemeMainAbilityentry0_undefined_0', bounds: '[24,1063][282,1351]' },
          children: [
            { attributes: { type: 'Text', text: '拖音', clickable: 'false', bounds: '[105,1260][202,1302]' }, children: [] },
          ],
        },
      ],
    },
    {
      attributes: { type: 'GridItem', id: 'SwiperPage_GridItem_[com.tencent.mqq___754974723___0,1]', bounds: '[540,1639][798,1927]' },
      children: [
        {
          attributes: { type: 'RelativeContainer', clickable: 'true', id: 'Container_AppIcon_Image_com.tencent.mqqEntryAbilityentry0_undefined_0', bounds: '[540,1639][798,1927]' },
          children: [
            { attributes: { type: 'Text', text: 'QQ', clickable: 'false', bounds: '[629,1836][709,1878]' }, children: [] },
          ],
        },
      ],
    },
    { attributes: { type: 'Text', text: '搜索关键词', bounds: '[159,156][927,274]' }, children: [] },
  ],
}

test('parseBounds 读得出中心点和宽高', () => {
  const b = parseBounds('[24,1063][282,1351]')
  assert.equal(b.w, 258)
  assert.equal(b.h, 288)
  assert.equal(b.cx, 153)
  assert.equal(b.cy, 1207)
  assert.equal(parseBounds('乱写的'), null)
})

test('screenSize 用根节点 bounds', () => {
  assert.deepEqual(screenSize(tree), { w: 1080, h: 2406 })
})

test('parseDump 对坏 JSON 报人话', () => {
  assert.throws(() => parseDump('<html>'), /不是合法 JSON/)
  assert.equal(parseDump('{"attributes":{}}').attributes.bounds, undefined)
})

test('flatten 借文字：图标容器有名字，重复的 Text 条目被去掉', () => {
  const items = flatten(tree)
  assert.deepEqual(items.map((i) => i.label), ['拖音', 'QQ', '搜索关键词'])
  assert.ok(items.every((i) => i.label))
})

test('findByText：先精确，其次按包名，再次包含', () => {
  const items = flatten(tree)
  assert.equal(findByText(items, '拖音').label, '拖音')
  assert.equal(findByText(items, 'QQ').label, 'QQ')
  // 名字认不出来但包名对得上，也能落到图标容器上
  assert.equal(findByText(items, '腾讯聊天', { bundle: 'com.tencent.mqq' }).id.includes('com.tencent.mqq'), true)
  assert.equal(findByText(items, '根本没有'), null)
})

test('pointOf：点在可点父容器中心，而不是文字自己', () => {
  const items = flatten(tree)
  const douyin = items.find((i) => i.label === '拖音')
  assert.equal(douyin.clickable, true)
  assert.equal(clickTarget(douyin).id.includes('Container_AppIcon'), true)
  assert.deepEqual(pointOf(douyin), { x: 153, y: 1207, via: 'Container_AppIcon_Image_com.ss.hm.ugc.awemeMainAbilityentry0_undefined_0' })
})

test('借文字时优先图标名，不把未读角标当名字', () => {
  const withBadge = {
    attributes: { bounds: '[0,0][1080,2406]' },
    children: [{
      attributes: { type: 'RelativeContainer', clickable: 'true', id: 'Container_AppIcon_Image_com.xingin.xhs_hosEntryAbilityentry0_undefined_0', bounds: '[24,1063][282,1351]' },
      children: [
        { attributes: { type: 'Text', text: '1', bounds: '[248,1078][280,1110]' }, children: [] },
        { attributes: { type: 'Text', text: '小红书', clickable: 'false', bounds: '[105,1260][202,1302]' }, children: [] },
      ],
    }],
  }
  const items = flatten(withBadge)
  assert.equal(items.length, 1)
  assert.equal(items[0].label, '小红书')
})

test('toLines 带序号和标记', () => {
  const lines = toLines(flatten(tree), { maxLines: 10 })
  assert.match(lines[0], /^1\. 拖音 \[可点\] @153,1207$/)
  assert.equal(lines.length, 3)
})
test('pickJson 能从模型的花式回复里抠出 JSON', () => {
  assert.deepEqual(pickJson('好的\n{"action":"click","idx":2}\n完'), { action: 'click', idx: 2 })
  assert.deepEqual(pickJson('```json\n{"action":"done","why":"收工"}\n```'), { action: 'done', why: '收工' })
  assert.equal(pickJson('我就不给你 JSON'), null)
  assert.equal(pickJson('{"a":1'), null)
})

test('红线：钱 / 不可逆 / 验证 / 对外发言', () => {
  assert.match(screenAction({ why: '点支付按钮' }), /不可逆/)
  assert.match(screenAction({ why: '把这个删掉' }), /不可逆/)
  assert.match(screenAction({ why: '输验证码' }), /不绕过/)
  assert.match(screenAction({ why: '发条评论', target: '发送' }), /对外发言/)
  assert.equal(screenAction({ why: '发条评论', target: '发送' }, { allowPost: true }), '')
  assert.equal(screenAction({ why: '往下刷一个视频' }), '')
})

test('resolveBundle：名字映射包名，包名原样返回', () => {
  assert.equal(resolveBundle('拖音'), 'com.ss.hm.ugc.aweme')
  assert.equal(resolveBundle('QQ'), 'com.tencent.mqq')
  assert.equal(resolveBundle('小红书的'), '')          // 不认识的中文名字 → 交给桌面/搜索
  assert.equal(resolveBundle('com.example.app'), 'com.example.app')
})

test('abilityFromIconId：从桌面图标 id 里读出包名和入口', () => {
  assert.deepEqual(
    abilityFromIconId('Container_AppIcon_Image_com.tencent.mqqEntryAbilityentry0_undefined_0'),
    { bundle: 'com.tencent.mqq', ability: 'EntryAbility' },
  )
  assert.deepEqual(
    abilityFromIconId('Container_AppIcon_Image_com.ss.hm.ugc.awemeMainAbilityentry0_undefined_0'),
    { bundle: 'com.ss.hm.ugc.aweme', ability: 'MainAbility' },
  )
  assert.equal(abilityFromIconId('SwiperPage_GridItem_[com.ss.hm.ugc.aweme___0,1]'), null)
})

test('resolveApp：名字/包名 → 包名 + 入口，学到的入口优先用', () => {
  assert.deepEqual(resolveApp('计算器'), { bundle: 'com.huawei.hmos.calculator', ability: 'CalculatorAbility' })
  assert.deepEqual(resolveApp('快手'), { bundle: 'com.kuaishou.hmapp', ability: '' })
  assert.deepEqual(resolveApp('com.kuaishou.hmapp', { 'com.kuaishou.hmapp': { ability: 'EntryAbility' } }),
    { bundle: 'com.kuaishou.hmapp', ability: 'EntryAbility' })
  assert.deepEqual(resolveApp('没这个 App'), { bundle: '', ability: '' })
  assert.ok(Object.keys(APPS).length >= 15)
})

test('learnFromItems：桌面上看到过的入口会补进表里', () => {
  const items = flatten(tree)
  const learned = learnFromItems(items, {})
  assert.equal(learned['com.ss.hm.ugc.aweme'].ability, 'MainAbility')
  assert.equal(learned['com.tencent.mqq'].ability, 'EntryAbility')
})

test('pickAbilities：先挑能当入口的，Form/Extension 往后放', () => {
  const picked = pickAbilities(['BackupExtensionAbility', 'EntryAbility', 'FeedHotFormAbility', 'MainAbility', 'Whatever'])
  assert.deepEqual(picked, ['EntryAbility', 'MainAbility', 'BackupExtensionAbility', 'FeedHotFormAbility'])
  assert.deepEqual(pickAbilities(['OnlyFormAbility'], 1), ['OnlyFormAbility'])
  assert.deepEqual(pickAbilities([]), [])
})

test('pickActions：支持一次给 3 个连贯动作，单个动作也认', () => {
  assert.equal(pickActions('{"action":"fling","dir":"up"}').length, 1)
  assert.deepEqual(
    pickActions('{"actions":[{"action":"fling","dir":"up"},{"action":"wait","ms":1500},{"action":"dump"}]}').map((a) => a.action),
    ['fling', 'wait', 'dump'],
  )
  // 超过 3 个就截掉，避免一批动作太长
  assert.equal(pickActions('{"actions":[{"action":"a"},{"action":"b"},{"action":"c"},{"action":"d"}]}').length, 3)
  assert.equal(pickActions('不给你 JSON').length, 0)
})

test('shouldIgnoreDone：时间还多就不许收工，最多拦四次', () => {
  assert.equal(shouldIgnoreDone({ left: 500000, total: 600000, steps: 20 }), true)
  assert.equal(shouldIgnoreDone({ left: 30000, total: 600000, steps: 20 }), false)
  assert.equal(shouldIgnoreDone({ left: 500000, total: 600000, steps: 3, minSteps: 8 }), true)
  assert.equal(shouldIgnoreDone({ left: 500000, total: 600000, steps: 20, ignored: 2 }), true)
  assert.equal(shouldIgnoreDone({ left: 500000, total: 600000, steps: 20, ignored: 4 }), false)
})

test('shouldIgnoreDone：收获不够也拦，读够了才放行', () => {
  // 只剩 20% 时间（已过 grace）、步数也够 —— 但只记了 1 条、要 3 条：继续读
  assert.equal(shouldIgnoreDone({ left: 120000, total: 600000, steps: 30, takeaways: 1, want: 3 }), true)
  // 记够 3 条：同样的时间/步数，允许收工
  assert.equal(shouldIgnoreDone({ left: 120000, total: 600000, steps: 30, takeaways: 3, want: 3 }), false)
  // 收获不够但时间真见底（只剩 5%）：不再硬撑
  assert.equal(shouldIgnoreDone({ left: 30000, total: 600000, steps: 30, takeaways: 0, want: 3 }), false)
  // want 填 0 = 不看收获
  assert.equal(shouldIgnoreDone({ left: 30000, total: 600000, steps: 30, takeaways: 0, want: 0 }), false)
})

test('renderFrame：行数与每条字数都可配，默认比老版本宽', () => {
  const items = [
    { label: '短标签', clickable: true, bounds: { cx: 1, cy: 2 } },
    { label: 'x'.repeat(120), clickable: false, bounds: { cx: 3, cy: 4 } },
  ]
  const wide = renderFrame(items)
  assert.equal(wide.length, 2)
  assert.equal(wide[1].length > 60, true)                       // 默认 60 字，不再是 26
  assert.match(wide[0], /^1\. 短标签 \[可点\] @1,2$/)
  const narrow = renderFrame(items, { maxChars: 26 })
  assert.equal(narrow[1].includes('x'.repeat(27)), false)
  assert.equal(renderFrame(items, { maxLines: 1 }).length, 1)
})

test('pickSnippet：滤掉按钮词和纯数字，按顺序拼正文', () => {
  const items = [
    { label: '关注' },
    { label: '赞同 1234' },
    { label: '写回答' },
    { label: '书里没明说，但你从她平时那个状态就看得出，这个家早就散了' },
    { label: '1' },
    { label: '一个四面漏风、没有人味的环境。' },
  ]
  const s = pickSnippet(items)
  assert.equal(s.includes('关注'), false)
  assert.equal(s.includes('写回答'), false)
  assert.equal(s.includes('\n'), true)
  assert.match(s, /书里没明说/)
  assert.match(s, /四面漏风/)
  // 字数上限会截断
  assert.equal(pickSnippet(items, { maxChars: 20 }).includes('四面漏风'), false)
})

test('addTakeaway：去重、封顶，不改原数组', () => {
  const base = ['这篇说雪穗她妈拿女儿身体换钱']
  const same = addTakeaway(base, '这篇说雪穗她妈拿女儿身体换钱。')
  assert.deepEqual(same, base)
  assert.deepEqual(base.length, 1)
  const more = addTakeaway(base, '鹿鹿先生把人物分成三类，说雪穗和亮司是「既失败又成功」')
  assert.equal(more.length, 2)
  assert.equal(addTakeaway([], '', {}).length, 0)
  const overflow = addTakeaway(Array.from({ length: 12 }, (_, i) => `第 ${i} 条内容足够长`), '第 13 条内容足够长', { max: 12 })
  assert.equal(overflow.length, 12)
  assert.equal(overflow[0], '第 1 条内容足够长')
})

test('parsePlayAsk：主人让她去玩才接住，自我叙述和别的指令不接', () => {
  const a = parsePlayAsk('去玩十分钟手机')
  assert.equal(a.minutes, 10)
  assert.equal(a.want, 0)                       // 没提「几篇」→ 用设置里的 playWant
  assert.equal(a.app, '')

  assert.deepEqual(parsePlayAsk('去刷会儿拖音', { defaultMinutes: 12 }), {
    minutes: 12, app: '拖音', want: 0, goal: '去刷会儿拖音',
  })

  const z = parsePlayAsk('去知乎找《白夜行》书评，半小时，多看几篇')
  assert.equal(z.app, '知乎')
  assert.equal(z.minutes, 30)
  assert.equal(z.want, 5)

  const x = parsePlayAsk('帮我去小红书看会儿，20 分钟，要三篇')
  assert.equal(x.app, '小红书')
  assert.equal(x.minutes, 20)
  assert.equal(x.want, 3)

  // 不能接的：自我叙述、别的手机指令、否定
  assert.equal(parsePlayAsk('我昨天去玩了十分钟'), null)
  assert.equal(parsePlayAsk('看一眼我手机现在什么界面'), null)
  assert.equal(parsePlayAsk('把拖音打开'), null)
  assert.equal(parsePlayAsk('别玩了，回来'), null)
  assert.equal(parsePlayAsk('刷会儿'), null)       // 没说手机也没说 App
})

test('帧对比：同样的文字算没变化，多出来的文字算变化', () => {
  const a = [{ label: '首页' }, { label: '朋友' }, { label: '1' }]
  const b = [{ label: '首页' }, { label: '朋友' }, { label: '消息' }]
  assert.equal(frameSignature(a), '首页|朋友')            // 纯数字角标不进指纹
  assert.equal(diffLabels(['首页', '朋友'], ['首页', '朋友']).changed, false)
  const d = diffLabels(['首页', '消息'], ['首页', '朋友'])
  assert.equal(d.changed, true)
  assert.deepEqual(d.added, ['消息'])
  assert.equal(d.removed, 1)
})

test('isHdcError：只有「手机/连接」类错误算致命，动作失败不算', () => {
  assert.equal(isHdcError('控件树失败：[fail] no device connected'), true)
  assert.equal(isHdcError('清单里没有第 5 条'), false)
})
