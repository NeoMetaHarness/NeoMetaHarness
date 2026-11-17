#!/usr/bin/env node
// Streaming-render bench over raw CDP (Node 22 WebSocket, no Playwright).
// Usage: node bench/run.mjs [--runs 5] [--ms 16000] [--modes naive,coalesced,dom]
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d }
const RUNS = +arg('--runs', 5), MS = +arg('--ms', 16000), MODES = arg('--modes', 'naive,coalesced,dom,blocks,blocks-sections').split(',')
const CHROME = process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const BASE = 'http://127.0.0.1:4317'
const sleep = ms => new Promise(r => setTimeout(r, ms))

const preview = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--port', '4317', '--strictPort', '--host', '127.0.0.1'], { stdio: 'ignore' })
async function waitHttp(url) { for (let i = 0; i < 100; i++) { try { if ((await fetch(url)).ok) return } catch {} await sleep(200) } throw new Error('preview not up') }

async function cdpSession(port) {
  const ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
  const ws = new WebSocket(ver.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  let id = 0; const pending = new Map()
  ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
    const mid = ++id; pending.set(mid, m => m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result))
    ws.send(JSON.stringify({ id: mid, method, params, sessionId }))
  })
  return { send, close: () => ws.close() }
}

const metrics = async (send, s) => Object.fromEntries((await send('Performance.getMetrics', {}, s)).metrics.map(m => [m.name, m.value]))

async function runOnce(cdp, mode) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
  const { sessionId: s } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
  await cdp.send('Performance.enable', {}, s); await cdp.send('Runtime.enable', {}, s)
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 940, deviceScaleFactor: 2, mobile: false }, s)
  await cdp.send('Page.navigate', { url: `${BASE}/?bench&mode=${mode.replace('-sections', '')}&ms=${MS}${mode.endsWith('-sections') ? '&split=sections' : ''}` }, s)
  const ev = expr => cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, s).then(r => r.result.value)
  for (let i = 0; i < 200 && !(await ev('typeof window.__start === "function"')); i++) await sleep(50)
  await sleep(500)
  await cdp.send('HeapProfiler.collectGarbage', {}, s)
  const heap0 = (await cdp.send('Runtime.getHeapUsage', {}, s)).usedSize
  const m0 = await metrics(cdp.send, s)
  await ev('window.__start()')
  let r; for (let i = 0; i < 1200; i++) { r = await ev('window.__bench'); if (r?.done) break; await sleep(100) }
  const m1 = await metrics(cdp.send, s)
  await cdp.send('HeapProfiler.collectGarbage', {}, s)
  const heap1 = (await cdp.send('Runtime.getHeapUsage', {}, s)).usedSize
  await cdp.send('Target.closeTarget', { targetId })
  const d = k => Math.round((m1[k] - m0[k]) * 1000)
  return { mode, taskMs: d('TaskDuration'), scriptMs: d('ScriptDuration'), layoutMs: d('LayoutDuration'), styleMs: d('RecalcStyleDuration'),
    wallMs: Math.round(r.wallMs), lastToPaintMs: Math.round(r.lastToPaintMs), worstLateMs: Math.round(r.worstLateMs), updates: r.updates, structure: r.structure,
    heap0MB: +(heap0 / 1048576).toFixed(1), heap1MB: +(heap1 / 1048576).toFixed(1) }
}

const median = a => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)] }
try {
  await waitHttp(BASE)
  const results = []
  for (let r = 0; r < RUNS; r++) {
    for (const mode of (r % 2 ? [...MODES].reverse() : MODES)) {   // alternate order each round
      const port = 9300 + Math.floor(Math.random() * 500)
      const prof = mkdtempSync(join(tmpdir(), 'neo-bench-'))
      const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`, '--no-first-run', '--no-default-browser-check', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', 'about:blank'], { stdio: 'ignore' })
      try {
        for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${port}/json/version`); break } catch { await sleep(200) } }
        const cdp = await cdpSession(port)
        const res = await runOnce(cdp, mode); results.push(res); console.log(JSON.stringify(res)); cdp.close()
      } finally { chrome.kill() }
    }
  }
  const keys = ['taskMs', 'scriptMs', 'layoutMs', 'styleMs', 'wallMs', 'lastToPaintMs', 'worstLateMs', 'updates', 'heap0MB', 'heap1MB']
  const summary = MODES.map(m => Object.fromEntries([['mode', m], ...keys.map(k => [k, median(results.filter(x => x.mode === m).map(x => x[k]))])]))
  console.table(summary)
  const shapes = new Set(results.map(x => x.structure))
  console.log(shapes.size === 1 ? `structure identical across all runs: ${[...shapes][0]}` : `STRUCTURE MISMATCH: ${[...shapes].join(' | ')}`)
  mkdirSync('bench/results', { recursive: true })
  writeFileSync(`bench/results/${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify({ runs: RUNS, ms: MS, chrome: CHROME, results, summary }, null, 2))
} finally { preview.kill() }
