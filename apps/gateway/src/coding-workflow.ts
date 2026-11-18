import { implement, ORPCError } from '@orpc/server';
import { neoContract } from '@neometaharness/contracts';
import type { NeoKernel } from '@neometaharness/kernel';
import type { GatewayAuthContext } from './rbac.js';
import { authorize } from './policy.js';

export function codingWorkflowRouter(kernel: NeoKernel) {
  const os = implement(neoContract).$context<GatewayAuthContext>().x['coding-workflow'];
  const invoke = (route: string, input: unknown) => {
    const path = `/x/coding-workflow/${route}`;
    if (!kernel.hasRoute(path)) throw new ORPCError('NOT_FOUND', { message: 'Coding workflow is disabled' });
    return kernel.invokeRoute(path, 'RPC', input) as Promise<any>;
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
        yield* await invoke('terminal/output', { ...input, signal }) as AsyncIterable<unknown>;
      }),
    },
    prepare: os.prepare.handler(async ({ input, context }) => {
      authorize('x.coding-workflow.prepare', context); return invoke('prepare', input);
    }),
  };
}
