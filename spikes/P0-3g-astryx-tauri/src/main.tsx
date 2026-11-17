import '@astryxdesign/core/reset.css'
import '@astryxdesign/core/astryx.css'
import '@astryxdesign/theme-neutral/theme.css'
import { StrictMode, memo, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Theme } from '@astryxdesign/core/theme'
import { neutralTheme } from '@astryxdesign/theme-neutral/built'
import { AppShell } from '@astryxdesign/core/AppShell'
import { SideNav, SideNavHeading, SideNavItem, SideNavSection } from '@astryxdesign/core/SideNav'
import { ChatComposer, ChatLayout, ChatMessage, ChatMessageBubble, ChatMessageList } from '@astryxdesign/core/Chat'
import { Markdown } from '@astryxdesign/core/Markdown'
import { makeReply, toDeltas } from './workload'

// Bench modes (PandaCode W1 shape). The deltas arrive from a timer, like a provider stream.
//   naive     : React state update for every delta → Astryx Markdown (isStreaming)
//   coalesced : deltas buffered, flushed to React state every 33 ms → Astryx Markdown (isStreaming)
//   dom       : deltas appended to a Text node outside React (flushed every 33 ms); Astryx Markdown once at the end
//   blocks    : finished markdown blocks render once each (memoized Astryx Markdown); only the open tail block is a raw
//               Text node outside React. Formatted output while streaming, with near-dom cost. (Candidate production design.)
type Mode = 'naive' | 'coalesced' | 'dom' | 'blocks'

const Block = memo(function Block({ md }: { md: string }) {
  return <Markdown contentWidth="100%">{md}</Markdown>
})

// Split at blank lines that are outside a ``` fence. Returns [finishedBlocks, openTail].
function splitBlocks(text: string): [string[], string] {
  const out: string[] = []; let start = 0, fence = false
  for (let i = 0; i < text.length; i++) {
    if (text.startsWith('```', i) && (i === 0 || text[i - 1] === '\n')) fence = !fence
    if (!fence && text[i] === '\n' && text[i + 1] === '\n' && (!SECTIONS || text[i + 2] === '#')) { out.push(text.slice(start, i)); start = i + 2; i++ }
  }
  return [out, text.slice(start)]
}
const params = new URLSearchParams(location.search)
const mode = (params.get('mode') ?? 'coalesced') as Mode
const autostart = params.has('bench')
// ?split=sections: split only before a heading (fewer, larger blocks → fewer Markdown mounts). Read lazily by splitBlocks.
const SECTIONS = params.get('split') === 'sections'
const DURATION_MS = Number(params.get('ms') ?? 16_000)
const FLUSH_MS = 33

declare global { interface Window { __bench?: { done: boolean; wallMs: number; lastToPaintMs: number; worstLateMs: number; updates: number; structure?: string } } }

function StreamingReply() {
  const [text, setText] = useState('')
  const [blocks, setBlocks] = useState<string[]>([])
  const [streaming, setStreaming] = useState(false)
  const domRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!autostart) return
    // The driver calls window.__start() after taking its baseline metrics.
    ;(window as any).__start = () => run()
    function run() {
    const deltas = toDeltas(makeReply())
    const interval = DURATION_MS / deltas.length
    const t0 = performance.now()
    let i = 0, buffer = '', updates = 0, worstLate = 0, lastDeliveryAt = 0
    let flushTimer: number | undefined
    let textNode: Text | null = null
    let full = '', consumed = 0
    window.__bench = { done: false, wallMs: 0, lastToPaintMs: 0, worstLateMs: 0, updates: 0 }
    setStreaming(true)

    const flush = () => {
      flushTimer = undefined
      if (!buffer) return
      const chunk = buffer; buffer = ''; updates++
      if (mode === 'dom') {
        if (!textNode) { textNode = document.createTextNode(''); domRef.current!.appendChild(textNode) }
        textNode.appendData(chunk)
      } else if (mode === 'blocks') {
        full += chunk
        const [done, tail] = splitBlocks(full.slice(consumed))
        if (done.length) {
          consumed += done.reduce((n, b) => n + b.length + 2, 0)
          setBlocks(prev => [...prev, ...done])           // React renders only when a block completes
        }
        if (!textNode) { textNode = document.createTextNode(''); domRef.current!.appendChild(textNode) }
        textNode.data = tail                               // open block stays outside React
      } else setText(t => t + chunk)
    }
    const finish = () => {
      if (flushTimer !== undefined) clearTimeout(flushTimer)
      flush()
      if (mode === 'dom') { domRef.current!.textContent = ''; setText(deltas.join('')) }
      if (mode === 'blocks') { const tail = full.slice(consumed); if (textNode) textNode.data = ''; if (tail) setBlocks(prev => [...prev, tail]) }
      setStreaming(false)
      // Two rAFs: the frame after the one that holds the final DOM.
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const now = performance.now()
        const root = document.getElementById('reply')!
        const structure = ['h2', 'li', 'pre', 'table', 'blockquote', 'a'].map(t => `${t}:${root.querySelectorAll(t).length}`).join(' ')
        window.__bench = { done: true, wallMs: now - t0, lastToPaintMs: now - lastDeliveryAt, worstLateMs: worstLate, updates, structure }
      }))
    }
    // Fixed timeline: each tick delivers every delta that is already due (no drift from timer clamping).
    const tick = () => {
      const now = performance.now()
      while (i < deltas.length && t0 + i * interval <= now) {
        worstLate = Math.max(worstLate, now - (t0 + i * interval))
        const d = deltas[i++]
        lastDeliveryAt = now
        if (mode === 'naive') { updates++; setText(t => t + d) }
        else { buffer += d; if (flushTimer === undefined) flushTimer = window.setTimeout(flush, FLUSH_MS) }
      }
      if (i < deltas.length) setTimeout(tick, Math.max(0, t0 + i * interval - performance.now()))
      else finish()
    }
    setTimeout(tick, 0)
    }
  }, [])

  return (
    <ChatMessage sender="assistant" name="Neo">
      <ChatMessageBubble variant="ghost"><div id="reply">
        {mode === 'blocks'
          ? <>{blocks.map((b, i) => <Block key={i} md={b} />)}<div ref={domRef} style={{ whiteSpace: 'pre-wrap' }} /></>
          : mode === 'dom' && streaming
          ? <div ref={domRef} style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit' }} />
          : <Markdown isStreaming={streaming} contentWidth="100%">{text || '_waiting…_'}</Markdown>}
      </div></ChatMessageBubble>
    </ChatMessage>
  )
}

function App() {
  // Cold-start probe: wall-clock time when the app shell has committed (read by bench/tauri-run.mjs).
  useEffect(() => { requestAnimationFrame(() => { (window as any).__shellReadyAt = Date.now() }) }, [])
  return (
    <Theme theme={neutralTheme}>
      <AppShell
        sideNav={
          <SideNav header={<SideNavHeading heading="Neo" subheading={`spike g · ${mode}`} />}>
            <SideNavSection title="Workspace">
              <SideNavItem label="Inbox" icon="inbox" />
              <SideNavItem label="Agents" icon="person" isSelected />
              <SideNavItem label="Coding" icon="code" />
              <SideNavItem label="Computers" icon="desktop" />
              <SideNavItem label="Skills" icon="star" />
            </SideNavSection>
          </SideNav>
        }
      >
        <ChatLayout composer={<ChatComposer onSubmit={() => {}} placeholder="Ask Neo…" />}>
          <ChatMessageList isStreaming>
            <ChatMessage sender="user"><ChatMessageBubble>Stream the W1 workload.</ChatMessageBubble></ChatMessage>
            <StreamingReply />
          </ChatMessageList>
        </ChatLayout>
      </AppShell>
    </Theme>
  )
}

// PWA only: the Tauri desktop app ships its assets locally and must not cache them in a service worker.
const inTauri = '__TAURI_INTERNALS__' in window
if ('serviceWorker' in navigator && !autostart && !inTauri) navigator.serviceWorker.register('/sw.js').catch(() => {})
if (inTauri) navigator.serviceWorker?.getRegistrations().then(rs => rs.forEach(r => r.unregister()))
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)
