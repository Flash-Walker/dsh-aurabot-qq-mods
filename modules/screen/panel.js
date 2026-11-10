// screen 模块的面板：看一眼连接状态、截一张图。call 会打到 index.mjs 里 api.route 加的接口。
const { useState, useEffect, useCallback } = React

return function ScreenPanel({ toast }) {
  const [status, setStatus] = useState(null)
  const [trace, setTrace] = useState(null)
  const [shot, setShot] = useState(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const load = useCallback(async () => {
    setBusy(true)
    setErr('')
    try {
      const [r, p] = await Promise.all([call('/status'), call('/play')])
      setStatus(r)
      setTrace(p)
    } catch (e) {
      setErr(String((e && e.message) || e))
    }
    setBusy(false)
  }, [])

  useEffect(() => { load() }, [load])

  const grab = async () => {
    setBusy(true)
    setErr('')
    try {
      const r = await call('/shot')
      if (r && r.ok) {
        setShot(r)
        toast('截到了 ' + r.width + 'x' + r.height)
      } else {
        setErr((r && r.error) || '截图失败')
      }
    } catch (e) {
      setErr(String((e && e.message) || e))
    }
    setBusy(false)
  }

  const playing = status && status.playing && status.playing.running
  const row = (k, v) => h(ui.Row, { key: k }, h('span', { className: 'ab-muted' }, k), h('span', null, v || '—'))

  return h(ui.Card, { title: '鸿蒙手机' },
    h('p', { className: 'ab-note' }, '通过本机 hdc 操作手机。手机要先开开发者模式 + USB 调试，插上能看到设备才算连上。'),

    status
      ? h('div', null,
          row('连接', status.ok ? '已连接' : (status.error || '没连上')),
          row('型号', status.model),
          row('系统', status.os || status.version),
          row('设备', (status.targets || []).join(', ')),
          row('hdc', status.hdcVersion),
          row('状态', playing ? '正在自动玩：' + status.playing.app + '（' + (status.playing.mode || 'fast') + '）' : '空闲'),
          playing ? row('进度', (status.playing.steps || 0) + ' 步 / ' + (status.playing.dumps || 0) + ' 帧 / 还剩 ' + Math.round((status.playing.left || 0) / 1000) + ' 秒') : null,
        )
      : h(ui.Empty, null, busy ? '读状态…' : '还没读到状态'),

    h('div', { style: { display: 'flex', gap: 8, marginTop: 10 } },
      h(ui.Btn, { onClick: load, disabled: busy }, '刷新'),
      h(ui.Btn, { onClick: grab, disabled: busy }, '截一张'),
    ),

    err ? h('p', { className: 'ab-note' }, '出错：' + err) : null,

    trace && trace.trace && trace.trace.length
      ? h('div', { style: { marginTop: 10 } },
          h('p', { className: 'ab-small ab-muted' }, '最近走的几步' + (trace.reason ? '（上次结束：' + trace.reason + '）' : '')),
          h('div', { className: 'ab-small' }, trace.trace.slice(-12).map((t, i) => h('div', { key: i }, String(t)))),
        )
      : null,

    shot
      ? h('div', { style: { marginTop: 12 } },
          h('p', { className: 'ab-small ab-muted' }, shot.width + 'x' + shot.height),
          h('img', { src: shot.dataUrl, style: { maxWidth: '100%', maxHeight: 360, borderRadius: 10, display: 'block' } }),
        )
      : null,
  )
}
