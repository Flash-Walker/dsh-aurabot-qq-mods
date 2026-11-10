/**
 * hdc（HarmonyOS Device Connector）的最小封装。
 *
 * 这里的定位很明确：电脑上的 hdc.exe 是唯一执行力，模块不碰网络、不装依赖，
 * 所有手机操作最终都落成一条 `hdc [-t SN] shell <命令>`。
 * 鸿蒙没有 adb，hdc 就是它对应的那套东西，命令语义接近但参数不同。
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * hdc 输出的编码在 Windows 上并不总是 UTF-8：设备端返回的中文有可能是 GBK。
 * 先按 UTF-8 严格解码，失败再退回 GBK（Node 自带完整 ICU，TextDecoder('gbk') 可用）。
 */
export function decode(buf) {
  if (!Buffer.isBuffer(buf)) return String(buf || '')
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf)
  } catch { /* 不是干净的 UTF-8，往下试 */ }
  try {
    return new TextDecoder('gbk').decode(buf)
  } catch { /* 再失败就按 latin1 兜底 */ }
  return buf.toString('latin1')
}

/** 常见的 hdc 位置：PATH、HM_SDK_HOME、DevEco / Command Line Tools 默认目录 */
export function hdcCandidates() {
  const list = []
  for (const dir of (process.env.PATH || process.env.Path || '').split(delimiter)) {
    if (dir) list.push(join(dir, 'hdc.exe'), join(dir, 'hdc'))
  }
  const extra = [
    process.env.HM_SDK_HOME && join(process.env.HM_SDK_HOME, 'openharmony', 'toolchains', 'hdc.exe'),
    process.env.HM_SDK_HOME && join(process.env.HM_SDK_HOME, 'hms', 'toolchains', 'hdc.exe'),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Huawei', 'Sdk', 'openharmony', 'toolchains', 'hdc.exe'),
    process.env.USERPROFILE && join(process.env.USERPROFILE, 'ohos-sdk', 'toolchains', 'toolchains', 'hdc.exe'),
    'D:\\ohos-sdk\\toolchains\\toolchains\\hdc.exe',
    'C:\\ohos-sdk\\toolchains\\toolchains\\hdc.exe',
    '/Applications/DevEco-Studio.app/Contents/sdk/default/openharmony/toolchains/hdc',
  ]
  for (const p of extra) if (p && existsSync(p)) list.unshift(p)
  return list.filter((p, i) => p && list.indexOf(p) === i)
}

/** 用户在设置里填了就听用户的，否则自动找第一个真实存在的 */
export function resolveHdc(configured) {
  const c = String(configured || '').trim()
  if (c) return c
  for (const p of hdcCandidates()) if (existsSync(p)) return p
  return 'hdc'
}

/**
 * 设备端 shell 的参数转义。设备上是 toybox sh，单引号最省事；
 * 文本里的单引号按 '\'' 处理，换行直接压平（一行命令里没法带换行）。
 */
export function shellQuote(text) {
  const s = String(text == null ? '' : text).replace(/\r?\n/g, ' ').replace(/\r/g, ' ')
  return `'${s.replace(/'/g, `'\\''`)}'`
}

export function createHdc({ bin, sn }) {
  const target = () => (sn ? ['-t', sn] : [])

  /** 跑一条 hdc 命令，永不抛错：结果里带 ok / code / out / err */
  function run(args, timeout = 30000) {
    return new Promise((resolve) => {
      execFile(
        bin,
        args,
        { timeout, windowsHide: true, maxBuffer: 24 * 1024 * 1024, encoding: 'buffer' },
        (err, stdout, stderr) => {
          const out = decode(stdout).trim()
          const errt = decode(stderr).trim()
          resolve({
            ok: !err,
            code: err && typeof err.code === 'number' ? err.code : err ? -1 : 0,
            out,
            err: errt || (err && !errt ? String(err.message || '') : ''),
            command: `${bin} ${args.join(' ')}`,
          })
        },
      )
    })
  }

  /** 在设备上跑一条 shell 命令 */
  function sh(command, timeout = 30000) {
    return run([...target(), 'shell', command], timeout)
  }

  /** 从设备取回文件 */
  function recv(remote, local, timeout = 60000) {
    return run([...target(), 'file', 'recv', remote, local], timeout)
  }

  /** 已连接设备列表（SN 或 IP:PORT；hdc 没设备时会给一个 [Empty]） */
  async function targets() {
    const r = await run(['list', 'targets'], 15000)
    const lines = (r.out || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
        .filter((s) => !/^\[?empty\]?/i.test(s))
    return { ok: r.ok, list: lines, raw: r, err: r.err }
  }

  async function version() {
    const r = await run(['-v'], 10000)
    return (r.out || r.err || '').replace(/Ver:\s*/i, '').trim()
  }

  /** 设备整体状态：连没连上、连了几台、版本 */
  async function health() {
    const t = await targets()
    return {
      ok: t.ok && t.list.length > 0,
      targets: t.list,
      version: await version(),
      error: t.ok ? (t.list.length ? '' : 'hdc 没看到任何设备（USB 线 / 无线调试 / 开发者模式里再确认一下）') : t.err,
    }
  }

  return { bin, sn, run, sh, recv, targets, version, health }
}
