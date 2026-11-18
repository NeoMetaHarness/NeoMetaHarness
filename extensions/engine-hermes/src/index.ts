import { defineExtension } from '@neometaharness/kernel';
import type { ComputerRegistry } from '@neometaharness/computers';
import { projectHermesComputer } from '@neometaharness/computers/hermes';
import { HermesRuntime, ProfileFileCredentials, VaultCredentials } from './runtime.js';
import { projectHermesMemory, type MemoryBridge } from './memory.js';
import type { SkillsBridge } from '@neometaharness/kernel';
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
    const skillsBridge = ctx.inject<SkillsBridge>('skillsBridge');
    const service = new HermesRuntime(credentials, async (profile, profileHome) => {
      const computerVersion = computers ? await projectHermesComputer(computers, profile, profileHome) : undefined;
      const memoryVersion = await projectHermesMemory(memory, profile, profileHome);
      const skillsVersion = await skillsBridge?.hermesReady(profile, profileHome);
      return JSON.stringify([computerVersion, memoryVersion, skillsVersion]);
    });
    await service.start();
    ctx.provide('agentRuntime', service);
    ctx.effect(() => () => service.disconnect());
    ctx.health(() => ({ ok: service.connected, pid: service.pid }));

    ctx.route('profiles/list', () => service.listProfiles());
    ctx.route('profiles/create', ({ body }) => service.createProfile((body as { name: string }).name));
    ctx.route('profiles/delete', async ({ body }) => {
      const name = (body as { name: string }).name;
      const result = await service.deleteProfile(name);
      skillsBridge?.forgetHermes(name);
      return result;
    });
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
    ctx.route('cron/list', ({ body }) => service.listCron((body as { profile?: string } | undefined)?.profile));
    ctx.route('cron/create', ({ body }) => {
      const { prompt, schedule, profile, name } = body as { prompt: string; schedule: string; profile?: string; name?: string };
      return service.createCron(prompt, schedule, profile, name);
    });
    ctx.route('cron/update', ({ body }) => {
      const { id, profile, prompt, schedule, name } = body as { id: string; profile?: string; prompt?: string; schedule?: string; name?: string };
      return service.updateCron(id, { prompt, schedule, name }, profile);
    });
    ctx.route('cron/pause', ({ body }) => {
      const { id, profile, paused } = body as { id: string; profile?: string; paused: boolean };
      return service.pauseCron(id, paused, profile);
    });
    ctx.route('cron/trigger', ({ body }) => {
      const { id, profile } = body as { id: string; profile?: string };
      return service.triggerCron(id, profile);
    });
    ctx.route('cron/history', ({ body }) => {
      const { id, profile } = body as { id: string; profile?: string };
      return service.cronHistory(id, profile);
    });
    ctx.route('cron/delete', ({ body }) => {
      const { id, profile } = body as { id: string; profile?: string };
      return service.deleteCron(id, profile);
    });
    ctx.route('skills/list', ({ body }) => service.listSkills((body as { profile: string }).profile));
    ctx.route('skills/hub', ({ body }) => service.officialSkills((body as { profile: string }).profile));
    ctx.route('skills/curator', ({ body }) => service.curatorStatus((body as { profile: string }).profile));
    ctx.route('skills/pause', ({ body }) => {
      const { profile, paused } = body as { profile: string; paused: boolean };
      return service.pauseCurator(profile, paused);
    });
    let active = true;
    ctx.effect(() => () => { active = false; });
    const syncAfterRun = async (profile: string, runId: string) => {
      try {
        for await (const event of service.events(profile, runId)) {
          if (!active) break;
          if (event.type === 'run.completed') {
            await skillsBridge?.sync(profile);
            break;
          }
          if (event.type === 'run.failed' || event.type === 'run.cancelled' || event.type === 'run.interrupted') break;
        }
      } catch (error) {
        if (active) console.error('Skill registry learn sync failed', error);
      }
    };
    ctx.route('skills/run', async ({ body }) => {
      const profile = (body as { profile: string }).profile;
      const result = await service.runCurator(profile);
      if (result.ok && result.pid > 0) {
        void (async () => {
          for (let check = 0; check < 300 && active; check++) {
            await new Promise<void>((done) => setTimeout(done, 1000));
            try { process.kill(result.pid, 0); } catch {
              if (active) await skillsBridge?.sync(profile);
              return;
            }
          }
        })().catch((error) => { if (active) console.error('Skill registry curator sync failed', error); });
      }
      return result;
    });
    ctx.route('skills/graph', ({ body }) => service.learningGraph((body as { profile: string }).profile));
    ctx.route('skills/learn', async ({ body }) => {
      const { profile, description } = body as { profile: string; description: string };
      const result = await service.learn(profile, description);
      if (skillsBridge) void syncAfterRun(profile, result.run_id);
      return result;
    });
  },
});
