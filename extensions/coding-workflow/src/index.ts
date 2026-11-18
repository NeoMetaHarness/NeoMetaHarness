import { defineExtension, type ExtensionContext } from '@neometaharness/kernel';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createAcpBridge } from './bridge.js';

const execute = promisify(execFile);
const git = async (cwd: string, args: string[]) => (await execute('git', ['-C', cwd, ...args], {
  windowsHide: true, maxBuffer: 4 * 1024 * 1024,
  env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
})).stdout.trim();
type T3 = {
  connected: boolean;
  workflowRequest(method: string, input: unknown): Promise<any>;
  workflowCommand(input: Record<string, unknown>): Promise<unknown>;
  subscribeThread(id: string): AsyncIterable<any>;
  listThreads(): Promise<{ projects: Array<{ id: string; workspaceRoot: string }> }>;
  terminalOutput(input: { threadId: string; terminalId: string }, signal?: AbortSignal): AsyncIterable<any>;
  onWorkflowDisconnect(cleanup: () => Promise<void>): () => void;
};

export default defineExtension({
  async activate(ctx) {
    const data = ctx.inject<string>('extensionDataDir');
    if (!data) throw new Error('Coding workflow requires extension storage');
    const storage = join(data, 'coding-workflow');
    await mkdir(storage, { recursive: true });
    const t3 = () => {
      const service = ctx.inject<T3>('codingControlPlane');
      if (!service?.connected) throw new Error('T3 extension is disabled or disconnected');
      return service;
    };
    const thread = async (id: string) => {
      for await (const frame of t3().subscribeThread(id)) {
        if (frame.kind === 'snapshot') {
          const current = frame.payload.projection.thread;
          const project = (await t3().listThreads()).projects.find(p => p.id === current.projectId);
          if (!project) throw new Error('Project not found');
          return { ...current, workspaceRoot: project.workspaceRoot,
            activeRunId: frame.payload.projection.runs.find((r: any) => ['pending', 'running', 'waiting'].includes(r.status))?.id ?? null };
        }
      }
      throw new Error('Thread not found');
    };
    const owned = new Map<string, { cwd: string; branch: string }>();
    const busy = new Set<string>();
    const exclusive = async <T>(id: string, fn: () => Promise<T>) => {
      if (busy.has(id)) throw new Error('Thread workflow operation is already running');
      busy.add(id);
      try { return await fn(); } finally { busy.delete(id); }
    };
    const bridge = await createAcpBridge(ctx, storage, async (cwd) => {
      const actual = await realpath(cwd);
      const roots = (await t3().listThreads()).projects.map(p => p.workspaceRoot);
      for (const root of [...roots, ...[...owned.values()].map(v => v.cwd)]) {
        if (actual === await realpath(root)) return;
      }
      throw new Error('ACP cwd is not a registered project or thread worktree');
    });
    const terminalIds = new Map<string, string>();
    let registered = false;
    let unregisterDisconnect: (() => void) | undefined;
    ctx.effect(() => async () => {
      unregisterDisconnect?.();
      const control = ctx.inject<T3>('codingControlPlane');
      for (const [threadId, terminalId] of terminalIds) {
        await control?.workflowRequest('terminal.close', { threadId, terminalId }).catch(() => {});
      }
      if (registered) await control?.workflowRequest('server.updateSettings', {
        patch: {}, providerInstanceMutation: { operation: 'remove', instanceId: 'neo-coding' },
      }).catch(() => {});
      await bridge.close();
    });
    ctx.health(() => ({ ok: !!ctx.inject('codingControlPlane') }));
    ctx.route('register', async ({ body }) => {
      if (!ctx.inject('dshAgentRuntime')) throw new Error('DSH extension is disabled');
      const models = ctx.inject<{ active: boolean; resolve(role: string): Promise<unknown> }>('modelHub');
      if (!models?.active) throw new Error('Configure a coding model in the Models hub first');
      await models.resolve('coding');
      bridge.setWorkspace((body as { workspaceId: string }).workspaceId);
      await t3().workflowRequest('server.updateSettings', { patch: {}, providerInstanceMutation: {
        operation: 'upsert', instanceId: 'neo-coding', instance: {
          driver: 'acpRegistry', displayName: 'Neo coding (DSH)', enabled: true,
          config: { source: 'local', commandPath: process.execPath,
            commandArgs: [fileURLToPath(new URL('./acp.mjs', import.meta.url)), bridge.endpoint, bridge.tokenFile] },
        },
      } });
      registered = true;
      unregisterDisconnect?.();
      const control = t3();
      unregisterDisconnect = control.onWorkflowDisconnect(async () => {
        await control.workflowRequest('server.updateSettings', {
          patch: {}, providerInstanceMutation: { operation: 'remove', instanceId: 'neo-coding' },
        }).catch(() => {});
        registered = false;
        await bridge.stopSessions();
      });
      return { providerId: 'neo-coding', model: 'default' };
    });
    ctx.route('switch', async ({ body }) => {
      const input = body as { threadId: string; providerId: string; model: string };
      const current = await thread(input.threadId);
      if (current.activeRunId) throw new Error('Wait for the current run before switching providers');
      if (input.providerId === 'neo-coding' && !ctx.inject('dshAgentRuntime')) throw new Error('DSH extension is disabled');
      return t3().workflowCommand({ type: 'thread.model-selection.set', threadId: input.threadId,
        modelSelection: { instanceId: input.providerId, model: input.model } });
    });
    ctx.route('worktree', ({ body }) => {
      const input = body as { threadId: string; branch: string };
      return exclusive(input.threadId, async () => {
        const current = await thread(input.threadId);
        if (current.activeRunId || current.worktreePath) throw new Error('Create a worktree before starting the thread');
        await git(current.workspaceRoot, ['check-ref-format', '--branch', input.branch]);
        const result = await t3().workflowRequest('vcs.createWorktree', {
          cwd: current.workspaceRoot, refName: 'HEAD', newRefName: input.branch, path: null,
        });
        const cwd = result.worktree.path;
        await t3().workflowCommand({ type: 'thread.metadata.update', threadId: input.threadId,
          worktreePath: cwd, branch: input.branch, expectedEmpty: true,
          expectedWorktreePath: null, expectedBranch: current.branch ?? null });
        owned.set(input.threadId, { cwd, branch: input.branch });
        return { path: cwd, branch: input.branch };
      });
    });
    ctx.route('terminal/open', async ({ body }) => {
      const { threadId } = body as { threadId: string };
      const current = await thread(threadId);
      const terminalId = terminalIds.get(threadId) ?? randomUUID();
      const result = await t3().workflowRequest('terminal.open', { threadId, terminalId,
        cwd: current.worktreePath ?? current.workspaceRoot, worktreePath: current.worktreePath ?? null });
      terminalIds.set(threadId, terminalId);
      return { terminalId, snapshot: result };
    });
    ctx.route('terminal/output', ({ body }) => {
      const input = body as { threadId: string; terminalId: string; signal?: AbortSignal };
      return t3().terminalOutput({ threadId: input.threadId, terminalId: input.terminalId }, input.signal);
    });
    ctx.route('terminal/run', async ({ body }) => {
      const input = body as { threadId: string; command: string };
      if (/[\r\n\0]/.test(input.command)) throw new Error('Enter one terminal command');
      const terminalId = terminalIds.get(input.threadId);
      if (!terminalId) throw new Error('Open terminal output first');
      await t3().workflowRequest('terminal.write', { threadId: input.threadId, terminalId, data: input.command + '\r' });
      return { submitted: true };
    });
    ctx.route('prepare', ({ body }) => {
      const input = body as { threadId: string; title: string; description: string; files: string[] };
      return exclusive(input.threadId, async () => {
        const current = await thread(input.threadId);
        if (current.activeRunId) throw new Error('Wait for the run before preparing a PR');
        const worktree = current.worktreePath;
        if (!worktree || !current.branch) throw new Error('Thread needs a branch and worktree');
        const root = await realpath(worktree);
        for (const file of input.files) {
          if (!file || isAbsolute(file) || file.startsWith('-') || file.split(/[\\/]/).includes('..')) throw new Error('Invalid selected file');
          // realpath also prevents selecting symlink targets outside the worktree.
          const resolved = await realpath(join(root, file));
          const rel = relative(root, resolved);
          if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('Selected file escapes worktree');
        }
        const branch = await git(root, ['symbolic-ref', '--short', 'HEAD']);
        if (branch !== current.branch) throw new Error('Worktree branch differs from thread');
        if (await git(root, ['diff', '--cached', '--name-only'])) throw new Error('Review existing staged changes first');
        await git(root, ['add', '--', ...input.files]);
        await git(root, ['-c', 'core.hooksPath=', 'commit', '-m', input.title, '--', ...input.files]);
        const commit = await git(root, ['rev-parse', 'HEAD']);
        const descriptionFile = join(storage, `${randomUUID()}.pr.md`);
        await writeFile(descriptionFile, `# ${input.title}\n\n${input.description}\n\nBranch: ${branch}\nCommit: ${commit}\n`, { mode: 0o600 });
        return { branch, commit, descriptionFile };
      });
    });
  },
});
