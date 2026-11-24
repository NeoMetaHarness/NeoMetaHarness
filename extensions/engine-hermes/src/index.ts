import { defineExtension } from '@neometaharness/kernel';
import { timingSafeEqual } from 'node:crypto';
import type { ComputerRegistry } from '@neometaharness/computers';
import { projectHermesComputer } from '@neometaharness/computers/hermes';
import { HermesRuntime, ProfileFileCredentials, VaultCredentials, hermesVenvReady, resolveHermesSource } from './runtime.js';
import { HermesInstaller, READY } from './install.js';
import { projectHermesMemory, type MemoryBridge } from './memory.js';
import type { ComputerMcpBridge, McpProjectionBridge, SkillsBridge } from '@neometaharness/kernel';
import type { VaultService } from '@neometaharness/vault';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

type ModelProjector = { projectHermes(profile: string, home: string): Promise<string | undefined> };

export default defineExtension({
  async activate(ctx) {
    const storage = ctx.inject<string>('extensionDataDir');
    // P7-16: installed apps keep engine sources, venvs and uv's cache in the Gateway's engines folder (local app
    // data), outside the versioned runtime. Without one (an in-memory Gateway) nothing is installed.
    const enginesDir = ctx.inject<string>('enginesDir');
    // The repository or unpacked runtime the Gateway serves; it holds upstream.lock.json.
    const runtimeRoot = ctx.inject<string>('runtimeRoot');
    const source = resolveHermesSource(enginesDir, runtimeRoot);
    if (!source || (source.origin === 'app-data' && !await hermesVenvReady(source.path, source.layout))) {
      // Not installed: stay up so Extensions and onboarding can install Hermes. No agentRuntime is provided, so
      // channels reports that it needs Hermes until the install reactivates this extension.
      const installer = new HermesInstaller({
        enginesDir, runtimeRoot,
        ...(process.env.NODE_ENV === 'test' && process.env.NMH_TEST_ENGINE_DOWNLOAD_BASE ? { downloadBase: process.env.NMH_TEST_ENGINE_DOWNLOAD_BASE } : {}),
        onInstalled: () => { void ctx.reactivate().catch((error) => console.error('Hermes restart after install failed', error)); },
        log: (message, error) => console.error(message, error),
      });
      ctx.effect(() => () => installer.cancel());
      // Not installed is a normal state, not a fault: the UI reads install/status, not health.
      ctx.health(() => ({ ok: true }));
      ctx.route('install/status', () => installer.current());
      ctx.route('install/start', () => installer.start());
      return;
    }
    ctx.route('install/status', () => READY);
    ctx.route('install/start', () => READY);
    const restoredHome = storage ? join(storage, 'engine-hermes', 'home') : undefined;
    // An app-data install also keeps the Hermes home (bots, sessions) in the data folder, so updates keep it.
    const home = resolve(process.env.NMH_HERMES_HOME ?? (restoredHome && (existsSync(restoredHome) || source.origin === 'app-data')
      ? restoredHome : fileURLToPath(new URL('../.cache/home', import.meta.url))));
    const vault = ctx.inject<VaultService>('vault');
    const credentials = vault ? new VaultCredentials(vault, home) : new ProfileFileCredentials(home);
    const computers = ctx.inject<ComputerRegistry>('computers');
    const memory = ctx.inject<MemoryBridge>('memoryBridge');
    const skillsBridge = ctx.inject<SkillsBridge>('skillsBridge');
    const profileWorkspace = ctx.inject<(profile: string) => Promise<string | undefined>>('computerProfileWorkspace');
    const service = new HermesRuntime(credentials, async (profile, profileHome) => {
      const workspaceId = await profileWorkspace?.(profile);
      const computerBinding = computers ? await projectHermesComputer(computers, profile, profileHome, workspaceId) : undefined;
      const memoryVersion = await projectHermesMemory(memory, profile, profileHome);
      const skillsVersion = await skillsBridge?.hermesReady(profile, profileHome);
      // hermes-agent@v0.23.2 tools/mcp_tool_transport.py:375-395 consumes configured stdio servers.
      const computerMcp = await ctx.inject<ComputerMcpBridge>('computerMcpBridge')?.ready('hermes', profile, profileHome, workspaceId ?? 'default');
      const appsMcp = await ctx.inject<McpProjectionBridge>('appsMcpBridge')?.ready('hermes', profile, profileHome, workspaceId ?? 'default');
      const modelVersion = await ctx.inject<ModelProjector>('modelHub')?.projectHermes(profile, profileHome);
      // The Neo backend reads binding.json on every action. Swapping the
      // computer capability never requires restarting this Hermes bot.
      return JSON.stringify([computerBinding ? 'neo_vnc' : undefined, memoryVersion, skillsVersion, modelVersion, computerMcp ? true : undefined, appsMcp ? true : undefined]);
    }, home);
    await service.start(source);
    ctx.provide('agentRuntime', service);
    ctx.provide('hermesScreen', {
      async connect(profile: string, workspaceId: string, token: string) {
        if (!vault || !workspaceId || !/^[a-f0-9]{64}$/.test(token)) throw new Error('Hermes screen authorization denied');
        const expected = await vault.get({ kind: 'engine', workspaceId, subjectId: `engine-hermes/${profile}` }, 'NEO_SCREEN_VIEW_TOKEN');
        if (!expected || expected.length !== token.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(token))) {
          throw new Error('Hermes screen authorization denied');
        }
        return service.screenConnection(profile);
      },
    });

    ctx.effect(() => async () => {
      await ctx.inject<ComputerMcpBridge>('computerMcpBridge')?.forgetEngine('hermes');
      await ctx.inject<McpProjectionBridge>('appsMcpBridge')?.forgetEngine('hermes');
      await service.disconnect();
    });
    ctx.health(() => ({ ok: service.connected, pid: service.pid }));

    ctx.route('subscription/start', ({ body }) => service.subscription.start((body as { profile: string }).profile));
    ctx.route('subscription/poll', ({ body }) => {
      const { profile, sessionId } = body as { profile: string; sessionId: string };
      return service.subscription.poll(profile, sessionId);
    });
    ctx.route('subscription/cancel', ({ body }) => {
      const { profile, sessionId } = body as { profile: string; sessionId: string };
      return service.subscription.cancel(profile, sessionId);
    });

    ctx.route('profiles/list', () => service.listProfiles());
    ctx.route('profiles/create', ({ body }) => service.createProfile((body as { name: string }).name));
    ctx.route('profiles/delete', async ({ body }) => {
      const name = (body as { name: string }).name;
      const result = await service.deleteProfile(name);
      skillsBridge?.forgetHermes(name);
      await ctx.inject<ComputerMcpBridge>('computerMcpBridge')?.forget('hermes', name);
      await ctx.inject<McpProjectionBridge>('appsMcpBridge')?.forget('hermes', name);
      return result;
    });
    ctx.route('runs/start', ({ body }) => {
      const { profile, input, instructions, sessionId } = body as {
        profile: string; input: string; instructions?: string; sessionId?: string;
      };
      return service.startRun(profile, input, { instructions, sessionId });
    });
    ctx.route('runs/status', ({ method, body }) => {
      if (method !== 'RPC') return;
      const { profile, runId } = body as { profile: string; runId: string };
      return service.runStatus(profile, runId);
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
    ctx.route('kanban/boards', () => service.kanbanBoards());
    ctx.route('kanban/create-board', ({ body }) => {
      const { slug, name } = body as { slug: string; name?: string };
      return service.createKanbanBoard(slug, name);
    });
    ctx.route('kanban/board', ({ body }) => service.kanbanBoard((body as { workspace: string }).workspace));
    ctx.route('kanban/create', ({ body }) => {
      const { workspace, title, body: detail, assignee } = body as { workspace: string; title: string; body?: string; assignee: string };
      return service.createKanbanTask(workspace, title, assignee, detail);
    });
    ctx.route('kanban/assign', ({ body }) => {
      const { workspace, id, assignee } = body as { workspace: string; id: string; assignee: string };
      return service.assignKanbanTask(workspace, id, assignee);
    });
    ctx.route('kanban/task', ({ body }) => {
      const { workspace, id } = body as { workspace: string; id: string };
      return service.kanbanTask(workspace, id);
    });
    ctx.route('kanban/dispatch', ({ body }) => service.dispatchKanban((body as { workspace: string }).workspace));
    ctx.route('skills/list', ({ body }) => service.listSkills((body as { profile: string }).profile));
    ctx.route('skills/hub', ({ body }) => service.officialSkills((body as { profile: string }).profile));
    ctx.route('skills/preview', ({ body }) => {
      const { profile, identifier } = body as { profile: string; identifier: string };
      return service.previewHubSkill(profile, identifier);
    });
    ctx.route('skills/scan', ({ body }) => {
      const { profile, identifier } = body as { profile: string; identifier: string };
      return service.scanHubSkill(profile, identifier);
    });
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
