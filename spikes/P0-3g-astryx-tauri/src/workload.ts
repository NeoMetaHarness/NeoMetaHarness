// Seeded markdown workload in the shape of PandaCode's W1 bench: ~50 KB split into 25-byte deltas.
function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const WORDS = 'agent harness memory skill computer channel model router extension gateway super ticket review stream token budget plugin engine'.split(' ')

export function makeReply(bytes = 50_000, seed = 0x7a3c1e): string {
  const rnd = mulberry32(seed)
  const w = () => WORDS[Math.floor(rnd() * WORDS.length)]
  const sentence = () => {
    const n = 6 + Math.floor(rnd() * 10)
    const parts = Array.from({ length: n }, (_, i) => (i === 2 ? `**${w()}**` : i === 5 ? `\`${w()}()\`` : w()))
    return parts.join(' ') + '. '
  }
  let out = ''
  let section = 1
  while (out.length < bytes) {
    out += `## Section ${section++}\n\n`
    out += sentence() + sentence() + `See [${w()}](https://example.com/${w()}).\n\n`
    out += `- ${sentence()}\n- ${sentence()}\n- ${sentence()}\n\n`
    out += '```ts\nconst ' + w() + ' = await ' + w() + '.run({ budget: ' + Math.floor(rnd() * 100) + ' })\n```\n\n'
    out += `> ${sentence()}\n\n`
    out += `| ${w()} | ${w()} |\n|---|---|\n| ${w()} | ${Math.floor(rnd() * 1000)} |\n\n`
  }
  return out.slice(0, bytes) + '\n\nEnd of reply W1.'
}

export function toDeltas(text: string, size = 25): string[] {
  const out: string[] = []
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size))
  return out
}
