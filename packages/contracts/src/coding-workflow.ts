import { oc, eventIterator } from '@orpc/contract';
import { z } from 'zod';

const thread = z.object({ threadId: z.string().min(1) });
export const codingWorkflowContract = {
  register: oc.output(z.object({ providerId: z.string(), model: z.string() })),
  switch: oc.input(thread.extend({ providerId: z.string().min(1), model: z.string().min(1) }))
    .output(z.object({ sequence: z.number() })),
  worktree: oc.input(thread.extend({ branch: z.string().min(1).max(160) }))
    .output(z.object({ path: z.string(), branch: z.string() })),
  terminal: {
    open: oc.input(thread).output(z.object({ terminalId: z.string(), snapshot: z.unknown() })),
    output: oc.input(thread.extend({ terminalId: z.string().min(1) })).output(eventIterator(z.unknown())),
    run: oc.input(thread.extend({ command: z.string().min(1).max(4000).regex(/^[^\r\n\0]+$/) }))
      .output(z.object({ submitted: z.boolean() })),
  },
  prepare: oc.input(thread.extend({ title: z.string().min(1).max(200), description: z.string().max(20000),
    files: z.array(z.string().min(1)).min(1).max(100) }))
    .output(z.object({ branch: z.string(), commit: z.string(), descriptionFile: z.string() })),
};
