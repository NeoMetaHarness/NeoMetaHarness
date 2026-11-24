import { isAbsolute, join } from 'node:path';

export function system32(...parts: string[]): string {
  const root = process.env.SystemRoot;
  if (!root || !isAbsolute(root)) throw new Error('Windows system folder is unavailable');
  return join(root, 'System32', ...parts);
}
