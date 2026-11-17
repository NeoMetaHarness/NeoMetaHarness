#!/usr/bin/env node
// Runs the streaming bench INSIDE the Tauri app's WebView2, and measures cold start + idle RAM.
// Usage: node bench/tauri-run.mjs [--exe path] [--runs 3] [--ms 16000] [--modes naive,blocks-sections]
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d }
// --shell electron runs the same dist/ in the Electron baseline (electron-baseline/) for an apples-to-apples comparison.
const SHELL = arg('--shell', 'tauri')
const EXE = SHELL === 'electron' ? 'electron-baseline/node_modules/electron/dist/electron.exe' : arg('--exe', 'src-tauri/target/release/neo-spike.exe')
const RUNS = +arg('--runs', 3), MS = +arg('--ms', 16000), MODES = arg('--modes', 'naive,coalesced,dom,blocks-sections').split(',')
const PORT = 9334
const sleep = ms => new Promise(r => setTimeout(r, ms))
if (!existsSync(EXE)) { console.error(`missing ${EXE}; run: pnpm tauri build --no-bundle`); process.exit(1) }

// Working set (MB) of the app process + its WebView2 children, via PowerShell CIM.
function ramMB(pid) {
  const ps = `$all=Get-CimInstance Win32_Process; $ids=@(${pid}); do { $n=$ids.Count; $ids=@($ids + ($all | ? { $ids -contains $_.ParentProcessId } | % ProcessId) | Select -Unique) } while ($ids.Count -gt $n); ($all | ? { $ids -contains $_.ProcessId } | Measure-Object WorkingSetSize -Sum).Sum/1MB`
  return +(+execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }).trim()).toFixed(1)
}
// Private bytes (not shared) of the same process tree: the honest "how much RAM does Neo cost" number.
function privateMB(pid) {
  const ps = `$all=Get-CimInstance Win32_Process; $ids=@(${pid}); do { $n=$ids.Count; $ids=@($ids + ($all | ? { $ids -contains $_.ParentProcessId } | % ProcessId) | Select -Unique) } while ($ids.Count -gt $n); ($all | ? { $ids -contains $_.ProcessId } | Measure-Object PrivatePageCount -Sum).Sum/1MB`
  return +(+execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }).trim()).toFixed(1)
}

async function cdp() {
  for (let i = 0; i < 100; i++) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const page = pages.find(p => p.type === 'page')
      if (page) {
        const ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
        let id = 0; const pend = new Map()
        ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id) { pend.get(m.id)?.(m); pend.delete(m.id) } }
        const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, m => m.error ? rej(new Error(method + ': ' + m.error.message)) : res(m.result)); ws.send(JSON.stringify({ id: i, method, params })) })
        return { send, close: () => ws.close() }
      }
    } catch {}
    await sleep(100)
  }
  throw new Error('WebView2 CDP not reachable')
}

function launch() {
  const t0 = performance.now()
  const flags = [`--remote-debugging-port=${PORT}`, '--disable-background-timer-throttling', '--disable-renderer-backgrounding']
  const child = SHELL === 'electron'
    ? spawn(EXE, ['electron-baseline', ...flags], { stdio: 'ignore' })
    : spawn(EXE, [], { stdio: 'ignore', env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: flags.join(' ') } })
  return { child, t0 }
}
const kill = pid => { try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }) } catch {} }

const results = { exe: EXE, coldStart: [], idleRamMB: [], privateMB: [], bench: [] }
// Cold start: process spawn → app shell (side nav) present in the WebView DOM.
for (let r = 0; r < RUNS; r++) {
  const spawnEpoch = Date.now()
  const { child } = launch()
  const c = await cdp()
  const ev = x => c.send('Runtime.evaluate', { expression: x, returnByValue: true }).then(v => v.result.value)
  let ready; for (let i = 0; i < 500 && !(ready = await ev('window.__shellReadyAt')); i++) await sleep(20)
  results.coldStart.push(ready - spawnEpoch)          // page-side timestamp: CDP polling latency is excluded
  await sleep(5000)                                        // settle, then idle RAM
  results.idleRamMB.push(ramMB(child.pid)); results.privateMB.push(privateMB(child.pid))
  console.log(JSON.stringify({ coldStartMs: results.coldStart.at(-1), workingSetMB: results.idleRamMB.at(-1), privateMB: results.privateMB.at(-1) }))
  c.close(); kill(child.pid); await sleep(1500)
}
// Streaming bench inside WebView2 (one app launch per mode per run, alternating order).
for (let r = 0; r < RUNS; r++) {
  for (const mode of (r % 2 ? [...MODES].reverse() : MODES)) {
    const { child } = launch()
    const c = await cdp()
    const ev = x => c.send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true }).then(v => v.result.value)
    await c.send('Performance.enable'); await c.send('Runtime.enable')
    let url = 'null'
    const loaded = u => /^(https?|app):\/\//.test(u)
    for (let i = 0; i < 300 && !loaded(url); i++) { url = await ev('location.origin'); if (!loaded(url)) await sleep(20) }
    if (!loaded(url)) throw new Error(`app origin never loaded: ${url}`)
    await c.send('Page.navigate', { url: `${url}/?bench&mode=${mode.replace('-sections', '')}&ms=${MS}${mode.endsWith('-sections') ? '&split=sections' : ''}` })
    for (let i = 0; i < 200 && !(await ev('typeof window.__start === "function"')); i++) await sleep(50)
    await sleep(500)
    await c.send('HeapProfiler.collectGarbage')
    const m = async () => Object.fromEntries((await c.send('Performance.getMetrics')).metrics.map(x => [x.name, x.value]))
    const m0 = await m(); await ev('window.__start()')
    let b; for (let i = 0; i < 1200; i++) { b = await ev('window.__bench'); if (b?.done) break; await sleep(100) }
    const m1 = await m(); await c.send('HeapProfiler.collectGarbage')
    const heap = (await c.send('Runtime.getHeapUsage')).usedSize
    const d = k => Math.round((m1[k] - m0[k]) * 1000)
    const row = { mode, taskMs: d('TaskDuration'), scriptMs: d('ScriptDuration'), layoutMs: d('LayoutDuration'), wallMs: Math.round(b.wallMs), lastToPaintMs: Math.round(b.lastToPaintMs), heap1MB: +(heap / 1048576).toFixed(1), structure: b.structure }
    results.bench.push(row); console.log(JSON.stringify(row))
    c.close(); kill(child.pid); await sleep(1500)
  }
}
const median = a => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]
console.log('coldStartMs median', median(results.coldStart), results.coldStart, '| workingSetMB median', median(results.idleRamMB), '| privateMB median', median(results.privateMB), results.privateMB)
console.table(MODES.map(mo => { const xs = results.bench.filter(x => x.mode === mo); return { mode: mo, ...Object.fromEntries(['taskMs', 'scriptMs', 'layoutMs', 'wallMs', 'lastToPaintMs', 'heap1MB'].map(k => [k, median(xs.map(x => x[k]))])) } }))
const shapes = new Set(results.bench.map(x => x.structure)); console.log(shapes.size === 1 ? `structure identical: ${[...shapes][0]}` : `STRUCTURE MISMATCH ${[...shapes].join(' | ')}`)
mkdirSync('bench/results', { recursive: true })
writeFileSync(`bench/results/${new Date().toISOString().slice(0, 10)}-${SHELL}.json`, JSON.stringify(results, null, 2))
