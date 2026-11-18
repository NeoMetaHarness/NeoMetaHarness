import { implement, ORPCError } from '@orpc/server';
import { neoContract } from '@neometaharness/contracts';
import type { NeoKernel } from '@neometaharness/kernel';
import type { GatewayAuthContext } from './rbac.js';
import { authorize } from './policy.js';
import { coalesceTerminal } from './coding-output.js';

export function codingWorkflowRouter(kernel: NeoKernel) {
  const os = implement(neoContract).$context<GatewayAuthContext>().x['coding-workflow'];
  const invoke = async (route: string, input: unknown) => {
    const path = `/x/coding-workflow/${route}`;
    if (!kernel.hasRoute(path)) throw new ORPCError('NOT_FOUND', { message: 'Coding workflow is disabled' });
    try { return await kernel.invokeRoute(path, 'RPC', input) as any; }
    catch (error) {
      if (error instanceof ORPCError) throw error;
      const message = error && typeof error === 'object' && 'message' in error
        ? String(error.message) : 'Coding workflow failed';
      throw new ORPCError(/disabled|disconnected/i.test(message) ? 'SERVICE_UNAVAILABLE' : 'BAD_REQUEST', { message });
    }
  };
  return {
    register: os.register.handler(async ({ context }) => {
      authorize('x.coding-workflow.register', context);
      return invoke('register', { workspaceId: context.workspaceId ?? 'default' });
    }),
    switch: os.switch.handler(async ({ input, context }) => {
      authorize('x.coding-workflow.switch', context); return invoke('switch', input);
    }),
    worktree: os.worktree.handler(async ({ input, context }) => {
      authorize('x.coding-workflow.worktree', context); return invoke('worktree', input);
    }),
    terminal: {
      run: os.terminal.run.handler(async ({ input, context }) => {
        authorize('x.coding-workflow.terminal.run', context); return invoke('terminal/run', input);
      }),
      open: os.terminal.open.handler(async ({ input, context }) => {
        authorize('x.coding-workflow.terminal.open', context); return invoke('terminal/open', input);
      }),
      output: os.terminal.output.handler(async function* ({ input, context, signal }) {
        authorize('x.coding-workflow.terminal.output', context);
        try { yield* coalesceTerminal(await invoke('terminal/output', { ...input, signal }) as AsyncIterable<unknown>); }
        catch (error) {
          const message = error && typeof error === 'object' && 'message' in error
            ? String(error.message) : 'Terminal output unavailable';
          throw new ORPCError('SERVICE_UNAVAILABLE', { message });
        }
      }),
    },
    prepare: os.prepare.handler(async ({ input, context }) => {
      authorize('x.coding-workflow.prepare', context); return invoke('prepare', input);
    }),
  };
}
