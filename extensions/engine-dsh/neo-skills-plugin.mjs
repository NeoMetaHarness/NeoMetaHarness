import { readFile, readdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { createUserMessage } from '@deepseek-ai/dsh-llm';

// Pinned DSH 0.2.2-rc.1: packages/skill/tool-skill/src/index.ts:181
// injects scoped messages via agent/pre-step. Registry.ts:577 enforces the
// target autonomy ceiling before projecting any SKILL.md into DSH_HOME/skills.
export const name = 'neo-skills';

export function apply(ctx) {
  const home = process.env.DSH_HOME;
  if (!home) return;

  ctx.on('agent/pre-step', async (_input, next) => {
    const decision = await next();
    if (decision.kind === 'reject') return decision;
    const root = join(home, 'skills');
    let dirs;
    try { dirs = (await readdir(root, { withFileTypes: true })).filter((entry) =>
      entry.isDirectory() && /^[a-z0-9_-]{1,80}$/.test(entry.name)).slice(0, 12); }
    catch (error) {
      if (error.code === 'ENOENT') return decision;
      ctx.logger.warn(`Neo skills lookup skipped: ${String(error)}`);
      return decision;
    }
    const skills = [];
    for (const dir of dirs) {
      try {
        const folder = join(root, dir.name);
        if ((await lstat(folder)).isSymbolicLink()) continue;
        const marker = JSON.parse(await readFile(join(folder, '.neo-skill-registry.json'), 'utf8'));
        if (typeof marker.name !== 'string' || marker.name.split('/').at(-1) !== dir.name) continue;
        const file = join(folder, 'SKILL.md');
        if ((await lstat(file)).isSymbolicLink()) continue;
        const content = (await readFile(file, 'utf8')).slice(0, 1200);
        skills.push(`## ${marker.name}\n${content}`);
      } catch { /* Only reviewed, registry-owned projections are usable. */ }
    }
    if (!skills.length) return decision;
    const text = `<neo-registry-skills>\n${skills.join('\n').slice(0, 9000)}\n</neo-registry-skills>`;
    return { ...decision, messages: [...decision.messages, createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'custom-context', form: 'snapshot', sections: [{ name: 'custom-context', text }] },
    })] };
  });
}
