/**
 * 纯逻辑单测：不碰手机、不碰网络，只验控件树解析 / 点击点计算 / JSON 抽取 / 红线过滤。
 * 跑法：node --test test/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parseBounds, parseDump, screenSize, flatten, findByText, clickTarget, pointOf, toLines,
} from '../lib/layout.mjs'
import { pickJson, screenAction } from '../lib/play.mjs'
import { resolveBundle } from '../lib/launcher.mjs'

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
