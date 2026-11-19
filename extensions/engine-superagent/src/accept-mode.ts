import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AcceptMode } from '@neometaharness/contracts';

// Mirrors contracts' acceptModeSchema; the contracts package resolves a different zod build than this one.
const acceptModeSchema = z.enum(['observe', 'act-with-approval', 'act']) satisfies z.ZodType<AcceptMode>;
const fileSchema = z.object({ workspaces: z.record(z.string(), acceptModeSchema) });

/**
 * Per-workspace accept mode for inferred Source work (docs/02-architecture.md "Accept modes").
 * - observe: work becomes a Suggestion a member accepts or dismisses (the default).
 * - act-with-approval: work starts, but its outward result (a GitHub reply) waits for admin approval.
 * - act: work starts and its result is delivered. Destructive work is always a Suggestion only an admin can accept.
 */
export class AcceptModeStore {
  private workspaces: Record<string, AcceptMode> = {};
  constructor(private readonly filename: string) {}

  /** Returns false when no mode was ever stored, so a caller can seed one. */
  load(): boolean {
    if (!existsSync(this.filename)) return false;
    this.workspaces = fileSchema.parse(JSON.parse(readFileSync(this.filename, 'utf8'))).workspaces;
    return true;
  }

  get(workspaceId = 'default'): AcceptMode { return this.workspaces[workspaceId] ?? 'observe'; }

  set(mode: AcceptMode, workspaceId = 'default'): AcceptMode {
    const next = { ...this.workspaces, [workspaceId]: acceptModeSchema.parse(mode) };
    mkdirSync(dirname(this.filename), { recursive: true, mode: 0o700 });
    const temporary = `${this.filename}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify({ workspaces: next }), { flag: 'wx', mode: 0o600 });
      renameSync(temporary, this.filename);
    } finally { if (existsSync(temporary)) unlinkSync(temporary); }
    this.workspaces = next;
    return mode;
  }
}
