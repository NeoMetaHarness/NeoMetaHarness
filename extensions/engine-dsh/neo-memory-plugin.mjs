import { createUserMessage } from '@deepseek-ai/dsh-llm';

// Pinned DSH hooks: packages/skill/tool-skill/src/index.ts:181 (agent/pre-step),
// packages/deliverables/workspace-changes/src/index.ts:145 (session/event).
export const name = 'neo-memory-context';

export function apply(ctx) {
  const endpoint = process.env.NEO_MEMORY_ENDPOINT;
  const token = process.env.NEO_MEMORY_TOKEN;
  const profile = process.env.NEO_MEMORY_PROFILE;
  if (!endpoint || !/^[0-9a-f]{64}$/.test(token ?? '') || !profile) return;

  const pending = new Map();
  const request = async (path, options = {}) => {
    const response = await fetch(`${endpoint}/${path}`, {
      ...options,
      headers: { authorization: `Bearer ${token}`, ...options.headers },
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) throw new Error(`Neo memory unavailable (${response.status})`);
    return response.json();
  };
  ctx.on('agent/pre-step', async ({ messages, signal }, next) => {
    const decision = await next();
    if (decision.kind === 'reject') return decision;
    const lastUser = [...messages].reverse().find((message) =>
      message.role === 'user' && message.source?.kind === 'user');
    const query = lastUser?.content?.filter((block) => block.type === 'text')
      .map((block) => block.text).join(' ').slice(0, 500) ?? '';
    try {
      const response = await request(`context?engine=dsh&profile=${encodeURIComponent(profile)}&q=${encodeURIComponent(query)}`);
      signal.throwIfAborted();
      if (!response.context) return decision;
      const text = `<memory-context>\n${response.context}\n</memory-context>`;
      return { ...decision, messages: [...decision.messages, createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'custom-context', form: 'snapshot', sections: [{ name: 'custom-context', text }] },
      })] };
    } catch (error) {
      ctx.logger.warn(`Neo memory prefetch skipped: ${String(error)}`);
      return decision;
    }
  });

  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/start') {
      pending.set(session, { user: '', assistant: '', turn: event.data.turn });
      return;
    }
    const turn = pending.get(session);
    if (!turn) return;
    if (event.type === 'user/message' && event.data.source?.kind === 'user') {
      turn.user = event.data.content.filter((block) => block.type === 'text')
        .map((block) => block.text).join(' ').slice(0, 16000);
    } else if (event.type === 'assistant/message') {
      const text = event.data.message.content.filter((block) => block.type === 'text')
        .map((block) => block.text).join('').slice(0, 16000);
      if (text) turn.assistant = text;
    } else if (event.type === 'turn/end') {
      pending.delete(session);
      if (event.data.reason?.kind !== 'completed' || !turn.assistant.trim()) return;
      const write = request('write', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'turn', engine: 'dsh', profile,
          session_id: profile, user: turn.user, assistant: turn.assistant }),
      }).catch((error) => ctx.logger.warn(`Neo memory write-back skipped: ${String(error)}`));
      writes.add(write);
      void write.finally(() => writes.delete(write));
    }
  });
  const writes = new Set();
  ctx.on('session/flush', async () => { await Promise.all([...writes]); });
  ctx.on('session/disposed', (session) => pending.delete(session));
}
