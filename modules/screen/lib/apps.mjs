/**
 * 应用表：名字 / 包名 / 入口 Ability。
 *
 * 为什么需要 Ability：`aa start -b <bundle>` 在很多鸿蒙 App 上不认（只给包名会报找不到入口），
 * 必须 `-a`。真机上踩过：计算器的入口叫 CalculatorAbility，不是 MainAbility。
 * 桌面上每个图标的 id 里其实写着入口名（`Container_AppIcon_Image_<bundle><Ability>entry0_`），
 * 所以除了这张表，还能从控件树里「学」出来。
 */

/** 名字 → 包名 + 入口（入口不确定的留空，交给「从桌面图标学」和裸包名兜底） */
export const APPS = {
  抖音: { bundle: 'com.ss.hm.ugc.aweme', ability: 'MainAbility' },
  快手: { bundle: 'com.kuaishou.hmapp', ability: '' },
  小红书: { bundle: 'com.xingin.xhs_hos', ability: 'EntryAbility' },
  qq: { bundle: 'com.tencent.mqq', ability: 'EntryAbility' },
  微信: { bundle: 'com.tencent.wechat', ability: '' },
  微博: { bundle: 'com.sina.weibo.stage', ability: '' },
  淘宝: { bundle: 'com.taobao.taobao4hmos', ability: '' },
  百度: { bundle: 'com.baidu.baiduapp', ability: '' },
  今日头条: { bundle: 'com.ss.hm.article.news', ability: '' },
  头条: { bundle: 'com.ss.hm.article.news', ability: '' },
  哔哩哔哩: { bundle: 'yylx.danmaku.bili', ability: '' },
  b站: { bundle: 'yylx.danmaku.bili', ability: '' },
  B站: { bundle: 'yylx.danmaku.bili', ability: '' },
  设置: { bundle: 'com.huawei.hmos.settings', ability: '' },
  相机: { bundle: 'com.huawei.hmos.camera', ability: '' },
  图库: { bundle: 'com.huawei.hmos.photos', ability: '' },
  计算器: { bundle: 'com.huawei.hmos.calculator', ability: 'CalculatorAbility' },
  备忘录: { bundle: 'com.huawei.hmos.notepad', ability: '' },
  日历: { bundle: 'com.huawei.hmos.calendar', ability: '' },
  音乐: { bundle: 'com.huawei.hmos.music', ability: '' },
  华为音乐: { bundle: 'com.huawei.hmos.music', ability: '' },
  支付宝: { bundle: 'com.alipay', ability: '' },
}

/**
 * 从桌面图标的 id 里读出包名和入口：
 * `Container_AppIcon_Image_com.tencent.mqqEntryAbilityentry0_undefined_0`
 * → { bundle: 'com.tencent.mqq', ability: 'EntryAbility' }
 */
export function abilityFromIconId(id) {
  // 注意不要加 /i：否则 [a-z0-9_.]+ 会把 Entry 也吞进包名里
  const m = /AppIcon_Image_([a-z0-9_.]+)([A-Z][A-Za-z0-9]*Ability)entry\d*/.exec(String(id || ''))
  if (!m) return null
  return { bundle: m[1].toLowerCase(), ability: m[2] }
}

/**
 * 名字/包名 → { bundle, ability }。
 * ability 可能为空（表里没写、也没从桌面学到），调用方按「先带 -a、再裸包名」的办法试。
 */
export function resolveApp(name, learned = null) {
  const key = String(name || '').trim()
  if (!key) return { bundle: '', ability: '' }
  if (key.includes('.')) {
    const hit = learned && learned[key.toLowerCase()]
    return { bundle: key, ability: (hit && hit.ability) || '' }
  }
  const hit = APPS[key] || APPS[key.toLowerCase()] || null
  if (hit) {
    const learnedOne = learned && learned[hit.bundle.toLowerCase()]
    return { bundle: hit.bundle, ability: hit.ability || (learnedOne && learnedOne.ability) || '' }
  }
  return { bundle: '', ability: '' }
}

/** 桌面上能看到的图标 id 里，有哪些能补进「学到的表」 */
export function learnFromItems(items, learned = {}) {
  const out = { ...learned }
  for (const it of items || []) {
    const got = abilityFromIconId(it.id)
    if (!got || !got.bundle || !got.ability) continue
    const key = got.bundle.toLowerCase()
    if (!out[key] || !out[key].ability) out[key] = { bundle: got.bundle, ability: got.ability }
  }
  return out
}

/**
 * 一个包里 dump 出来一堆 xxxAbility，要挑「能当启动入口」的：
 * FormAbility / ExtensionAbility / ServiceAbility 这些不是页面入口，试了只会白等。
 */
export function pickAbilities(names, limit = 4) {
  const uniq = [...new Set((names || []).filter((n) => /^[A-Za-z0-9_]+Ability$/.test(String(n))))]
  const launchable = uniq.filter((n) => !/Extension|Form|Widget|Service|Backup|Provider|Driver/i.test(n))
  const rest = uniq.filter((n) => !launchable.includes(n))
  return [...launchable, ...rest].slice(0, Math.max(1, limit))
}
