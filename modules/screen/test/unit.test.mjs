/**
 * 纯逻辑单测：不碰手机、不碰网络，只验控件树解析 / 点击点计算 / JSON 抽取 / 红线过滤。
 * 跑法：node --test test/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parseBounds, parseDump, screenSize, flatten, findByText, clickTarget, pointOf, toLines,
} from '../lib/layout.mjs'
import { pickJson, pickActions, screenAction, shouldIgnoreDone, diffLabels, frameSignature, isHdcError } from '../lib/play.mjs'
import { resolveBundle } from '../lib/launcher.mjs'
import { APPS, abilityFromIconId, resolveApp, learnFromItems, pickAbilities } from '../lib/apps.mjs'

/** 一段迷你控件树，结构照抄真机（图标名字不可点，热区在带包名 id 的父容器上） */
const tree = {
  attributes: { bounds: '[0,0][1080,2406]', type: '' },
  children: [
    {
      attributes: { type: 'GridItem', id: 'SwiperPage_GridItem_[com.ss.hm.ugc.aweme___4060086280___0,1]', bounds: '[24,1063][282,1351]' },
      children: [
        {
          attributes: { type: 'RelativeContainer', clickable: 'true', id: 'Container_AppIcon_Image_com.ss.hm.ugc.awemeMainAbilityentry0_undefined_0', bounds: '[24,1063][282,1351]' },
          children: [
            { attributes: { type: 'Text', text: '抖音', clickable: 'false', bounds: '[105,1260][202,1302]' }, children: [] },
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
  assert.deepEqual(items.map((i) => i.label), ['抖音', 'QQ', '搜索关键词'])
  assert.ok(items.every((i) => i.label))
})

test('findByText：先精确，其次按包名，再次包含', () => {
  const items = flatten(tree)
  assert.equal(findByText(items, '抖音').label, '抖音')
  assert.equal(findByText(items, 'QQ').label, 'QQ')
  // 名字认不出来但包名对得上，也能落到图标容器上
  assert.equal(findByText(items, '腾讯聊天', { bundle: 'com.tencent.mqq' }).id.includes('com.tencent.mqq'), true)
  assert.equal(findByText(items, '根本没有'), null)
})

test('pointOf：点在可点父容器中心，而不是文字自己', () => {
  const items = flatten(tree)
  const douyin = items.find((i) => i.label === '抖音')
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
  assert.match(lines[0], /^1\. 抖音 \[可点\] @153,1207$/)
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
  assert.equal(resolveBundle('抖音'), 'com.ss.hm.ugc.aweme')
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

test('shouldIgnoreDone：时间还多就不许收工，最多容忍两次', () => {
  assert.equal(shouldIgnoreDone({ left: 500000, total: 600000, steps: 20 }), true)
  assert.equal(shouldIgnoreDone({ left: 30000, total: 600000, steps: 20 }), false)
  assert.equal(shouldIgnoreDone({ left: 500000, total: 600000, steps: 3, minSteps: 8 }), true)
  assert.equal(shouldIgnoreDone({ left: 500000, total: 600000, steps: 20, ignored: 2 }), false)
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
