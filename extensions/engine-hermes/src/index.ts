import { defineExtension } from '@neometaharness/kernel';
import type { ComputerRegistry } from '@neometaharness/computers';
import { projectHermesComputer } from '@neometaharness/computers/hermes';
import { HermesRuntime, ProfileFileCredentials, VaultCredentials } from './runtime.js';
import { projectHermesMemory, type MemoryBridge } from './memory.js';
import type { VaultService } from '@neometaharness/vault';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export default defineExtension({
  async activate(ctx) {
    const home = resolve(process.env.NMH_HERMES_HOME ?? fileURLToPath(new URL('../.cache/home', import.meta.url)));
    const vault = ctx.inject<VaultService>('vault');
    const credentials = vault ? new VaultCredentials(vault, home) : new ProfileFileCredentials(home);
    const computers = ctx.inject<ComputerRegistry>('computers');
    const memory = ctx.inject<MemoryBridge>('memoryBridge');
    const service = new HermesRuntime(credentials, async (profile, profileHome) => {
      const computerVersion = computers ? await projectHermesComputer(computers, profile, profileHome) : undefined;
      const memoryVersion = await projectHermesMemory(memory, profile, profileHome);
      return JSON.stringify([computerVersion, memoryVersion]);
    });
    await service.start();
    ctx.provide('agentRuntime', service);
    ctx.effect(() => () => service.disconnect());
    ctx.health(() => ({ ok: service.connected, pid: service.pid }));

    ctx.route('profiles/list', () => service.listProfiles());
    ctx.route('profiles/create', ({ body }) => service.createProfile((body as { name: string }).name));
    ctx.route('profiles/delete', ({ body }) => service.deleteProfile((body as { name: string }).name));
    ctx.route('runs/start', ({ body }) => {
      const { profile, input } = body as { profile: string; input: string };
      return service.startRun(profile, input);
    });
    ctx.route('runs/events', ({ body }) => {
      const { profile, runId, signal } = body as { profile: string; runId: string; signal?: AbortSignal };
      return service.events(profile, runId, signal);
    });
    ctx.route('runs/approve', ({ body }) => {
      const { profile, runId, choice } = body as { profile: string; runId: string; choice: 'once' | 'session' | 'deny' };
      return service.approve(profile, runId, choice);
    });
    ctx.route('runs/stop', ({ body }) => {
      const { profile, runId } = body as { profile: string; runId: string };
      return service.stopRun(profile, runId);
    });
    ctx.route('cron/list', () => service.listCron());
    ctx.route('cron/create', ({ body }) => {
      const { prompt, schedule } = body as { prompt: string; schedule: string };
      return service.createCron(prompt, schedule);
    });
    ctx.route('cron/delete', ({ body }) => service.deleteCron((body as { id: string }).id));
    ctx.route('skills/list', ({ body }) => service.listSkills((body as { profile: string }).profile));
    ctx.route('skills/hub', ({ body }) => service.officialSkills((body as { profile: string }).profile));
    ctx.route('skills/curator', ({ body }) => service.curatorStatus((body as { profile: string }).profile));
    ctx.route('skills/pause', ({ body }) => {
      const { profile, paused } = body as { profile: string; paused: boolean };
      return service.pauseCurator(profile, paused);
    });
    ctx.route('skills/run', ({ body }) => service.runCurator((body as { profile: string }).profile));
    ctx.route('skills/graph', ({ body }) => service.learningGraph((body as { profile: string }).profile));
    ctx.route('skills/learn', ({ body }) => {
      const { profile, description } = body as { profile: string; description: string };
      return service.learn(profile, description);
    });
  },
});
