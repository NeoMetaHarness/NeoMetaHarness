import { createUserMessage } from '@deepseek-ai/dsh-llm';

// Pinned DSH 0.2.2-rc.1: packages/skill/tool-skill/src/index.ts:181
// documents the agent/pre-step continuation and injected UserMessage seam.
export const name = 'neo-soul';

export function apply(ctx) {
  const endpoint = process.env.NEO_MEMORY_ENDPOINT;
  const token = process.env.NEO_MEMORY_TOKEN;
  const profile = process.env.NEO_MEMORY_PROFILE;
  if (!endpoint || !/^[0-9a-f]{64}$/.test(token ?? '') || !profile) return;

  ctx.on('agent/pre-step', async (_input, next) => {
    const decision = await next();
    if (decision.kind === 'reject') return decision;
    try {
      const response = await fetch(`${endpoint}/soul?engine=dsh&profile=${encodeURIComponent(profile)}`, {
        headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(2000),
      });
      if (!response.ok) return decision;
      const { soul } = await response.json();
      if (typeof soul !== 'string' || !soul.trim()) return decision;
      const text = `<bot-persona>\n${soul.slice(0, 4000)}\n</bot-persona>`;
      return { ...decision, messages: [...decision.messages, createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'custom-context', form: 'snapshot', sections: [{ name: 'custom-context', text }] },
      })] };
    } catch (error) {
      ctx.logger.warn(`Neo soul projection skipped: ${String(error)}`);
      return decision;
    }
  });
}
