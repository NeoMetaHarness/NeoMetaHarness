#!/usr/bin/env node
// Verifies the PWA basics over CDP: manifest parses, service worker activates, app shell loads offline.
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const BASE = 'http://127.0.0.1:4318', PORT = 9877
const preview = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--port', '4318', '--strictPort', '--host', '127.0.0.1'], { stdio: 'ignore' })
const chrome = spawn(process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'neo-pwa-'))}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' })
try {
  for (let i = 0; i < 60; i++) { try { await fetch(BASE); await fetch(`http://127.0.0.1:${PORT}/json/version`); break } catch { await sleep(250) } }
  const ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()
  const ws = new WebSocket(ver.webSocketDebuggerUrl); await new Promise(r => (ws.onopen = r))
  let id = 0; const pend = new Map(); ws.onmessage = e => { const m = JSON.parse(e.data); pend.get(m.id)?.(m); pend.delete(m.id) }
  const send = (method, params = {}, sessionId) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params, sessionId })) })
  const { result: { targetId } } = await send('Target.createTarget', { url: BASE })
  const { result: { sessionId: s } } = await send('Target.attachToTarget', { targetId, flatten: true })
  const ev = async x => (await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true }, s)).result?.result?.value
  await sleep(2500)
  const manifest = await send('Page.getAppManifest', {}, s)
  const swState = await ev('navigator.serviceWorker.ready.then(r => r.active && r.active.state)')
  await ev('location.reload()'); await sleep(1500)                       // second load populates the cache
  await send('Network.enable', {}, s)
  await send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }, s)
  await send('Page.reload', {}, s); await sleep(2500)
  const offlineNav = await ev('document.querySelector("nav, [class*=side-nav]") ? "app shell rendered" : document.body.innerText.slice(0,80)')
  console.log(JSON.stringify({ manifestErrors: manifest.result?.errors?.length ?? 'n/a', manifestUrl: manifest.result?.url, swState, offline: offlineNav }, null, 1))
  ws.close()
} finally { chrome.kill(); preview.kill() }
