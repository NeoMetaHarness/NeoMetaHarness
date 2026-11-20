// P6-10: an item fired by a schedule keeps the schedule's workspace (cron-source.ts cronAsk feeds SuperagentService.ask).
import assert from 'node:assert/strict';
import { cronAsk } from '../src/cron-source.js';

const job = { id: 'job-1', schedule: '0 9 * * 1', text: 'Weekly report', botId: 'bot', mode: 'observe' as const };
assert.deepEqual(cronAsk({ ...job, workspace: 'org-corp', requesterRole: 'admin' }),
  { text: 'Weekly report', botId: 'bot', mode: 'observe', requesterRole: 'admin', workspace: 'org-corp' });
assert.deepEqual(cronAsk(job), { text: 'Weekly report', botId: 'bot', mode: 'observe', requesterRole: 'member' },
  'a schedule without a workspace (desktop, or the system upstream job) fires a workspace-less item');
console.log('CRON_ASK PASS fired items carry the schedule workspace');
