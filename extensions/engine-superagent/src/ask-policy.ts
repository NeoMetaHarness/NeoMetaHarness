export type RequesterRole = 'viewer' | 'member' | 'admin' | 'owner';

/** Reject destructive requests before delegating a ticket to a tool-capable bot. */
export function blockedReason(role: RequesterRole, mode: 'observe' | 'act', text: string): string | undefined {
  if (mode !== 'act') return undefined;
  if (role === 'viewer') return 'Viewer role can observe and propose, but cannot act. Request blocked.';
  if (role !== 'admin' && role !== 'owner'
    && /\b(delete|destroy|erase|wipe|purge|truncate|drop|remove|overwrite|format|reset|revoke)\b/i.test(text)) {
    return 'Destructive actions require an admin or owner role. Request blocked.';
  }
  return undefined;
}
