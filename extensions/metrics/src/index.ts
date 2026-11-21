import { defineExtension } from '@neometaharness/kernel';
import { SuccessMetrics, type MetricsSources } from './metrics.js';

type RegistryMetrics = {
  list: () => Promise<{ name: string; evaluation?: { status: string } }[]>;
  listAssignments: () => { name: string }[];
};

export default defineExtension({
  activate(ctx) {
    ctx.route('summary', ({ body }) => {
      const superagent = ctx.inject<Pick<MetricsSources, 'inbox' | 'decisions'>>('superagentMetrics');
      const registry = ctx.inject<RegistryMetrics>('skillRegistry');
      const service = new SuccessMetrics({
        inbox: () => superagent?.inbox() ?? [],
        decisions: (workspace) => superagent?.decisions(workspace) ?? Promise.resolve([]),
        qualifiedSkills: registry ? async () => {
          const assigned = new Set(registry.listAssignments().map((entry) => entry.name));
          const skills = await registry.list();
          return skills.filter((skill) => assigned.has(skill.name)
            && ['passed', 'overridden'].includes(skill.evaluation?.status ?? '')).length;
        } : undefined,
      });
      return service.summary((body ?? {}) as { workspace?: string; onboardingCompletedAt?: string | null });
    });
    ctx.health(() => ({ ok: true }));
  },
});
