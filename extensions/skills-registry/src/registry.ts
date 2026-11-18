import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdir, readFile, readdir, unlink, rmdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { SkillProjection } from '@neometaharness/kernel';

const exec = promisify(execFile);
const marker = '.neo-skill-registry.json';
const validName = /^[a-z][a-z0-9_-]{0,79}$/;
type Trust = 'untrusted' | 'observed' | 'confirmed';
type Engine = 'hermes' | 'dsh';
type Assignment = { name: string; engine: Engine; targetId: string };
export type SkillRecord = {
  name: string; version: number; trust: Trust; sourceProfile: string;
  sourcePath: string; updatedAt: number;
};

function safeName(name: string): string {
  if (!validName.test(name)) throw new Error(`Invalid skill or profile name ${name}`);
  return name;
}

/** The registry owns its own Git history and only files marked as Neo projections. */
export class SkillRegistry implements SkillProjection {
  private readonly repo: string;
  private readonly assignmentsFile: string;
  private assignments: Assignment[] = [];
  private readonly homes = new Map<string, string>();
  private readonly seen = new Map<string, Map<string, string>>();
  private readonly projected = new Set<string>();
  private pending: Promise<unknown> = Promise.resolve();
  private disposed = false;

  constructor(private readonly dataDir: string) {
    this.repo = join(dataDir, 'repo');
    this.assignmentsFile = join(dataDir, 'assignments.json');
  }

  private async git(...args: string[]): Promise<string> {
    const { stdout } = await exec('git', ['-C', this.repo, ...args], { windowsHide: true, maxBuffer: 4_000_000 });
    return stdout;
  }

  async start(): Promise<void> {
    await mkdir(this.repo, { recursive: true });
    if (!existsSync(join(this.repo, '.git'))) await this.git('init');
    if (existsSync(this.assignmentsFile)) {
      const parsed: unknown = JSON.parse(await readFile(this.assignmentsFile, 'utf8'));
      if (!Array.isArray(parsed)) throw new Error('Invalid skill assignment storage');
      this.assignments = parsed.filter((item): item is Assignment => typeof item === 'object' && item !== null
        && validName.test((item as Assignment).name) && (item as Assignment).engine in { hermes: 1, dsh: 1 }
        && typeof (item as Assignment).targetId === 'string'
        && /^[a-zA-Z0-9_-]{1,100}$/.test((item as Assignment).targetId));
    }
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.pending.then(operation);
    this.pending = next.catch(() => {});
    return next;
  }

  private skillDir(name: string): string { return join(this.repo, 'skills', safeName(name)); }

  private async record(name: string): Promise<SkillRecord> {
    return JSON.parse(await readFile(join(this.skillDir(name), 'metadata.json'), 'utf8')) as SkillRecord;
  }

  async list(): Promise<SkillRecord[]> {
    const root = join(this.repo, 'skills');
    if (!existsSync(root)) return [];
    const records = await Promise.all((await readdir(root)).filter((name) => validName.test(name)).map((name) => this.record(name)));
    return records.sort((a, b) => a.name.localeCompare(b.name));
  }

  async get(name: string): Promise<{ metadata: SkillRecord; content: string }> {
    return { metadata: await this.record(name), content: await readFile(join(this.skillDir(name), 'SKILL.md'), 'utf8') };
  }

  async import(input: { name: string; content: string; sourceProfile: string; sourcePath: string; trust?: Trust }): Promise<SkillRecord> {
    return this.serialize(async () => {
      safeName(input.name);
      safeName(input.sourceProfile);
      const content = input.content.replace(/\r\n/g, '\n');
      if (content.length > 200_000 || !/^---\s*\n[\s\S]*?\n---\s*\n/.test(content)) {
        throw new Error('Skill requires SKILL.md frontmatter (max 200 KB)');
      }
      const folder = this.skillDir(input.name);
      const previous = existsSync(join(folder, 'metadata.json')) ? await this.get(input.name) : undefined;
      if (previous?.content === content && previous.metadata.sourceProfile === input.sourceProfile
        && previous.metadata.trust === (input.trust ?? 'observed')
        && previous.metadata.sourcePath === input.sourcePath) return previous.metadata;
      const next: SkillRecord = {
        name: input.name, version: (previous?.metadata.version ?? 0) + 1,
        sourceProfile: input.sourceProfile, sourcePath: input.sourcePath,
        trust: input.trust ?? 'observed', updatedAt: Date.now(),
      };
      await mkdir(folder, { recursive: true });
      await writeFile(join(folder, 'SKILL.md'), content, 'utf8');
      await writeFile(join(folder, 'metadata.json'), JSON.stringify(next, null, 2) + '\n', 'utf8');
      await this.git('add', '--', `skills/${input.name}`);
      await this.git('-c', 'user.name=Neo Skill Registry', '-c', 'user.email=skills@localhost',
        'commit', '-m', `skill ${input.name} v${next.version}`);
      await this.refreshAll(input.name);
      return next;
    });
  }

  async versions(name: string): Promise<{ version: number; hash: string; metadata: SkillRecord }[]> {
    safeName(name);
    const history = (await this.git('log', '--format=%H', '--', `skills/${name}`)).trim();
    if (!history) return [];
    const commits = history.split(/\r?\n/).reverse();
    return Promise.all(commits.map(async (hash, index) => {
      const raw = await this.git('show', `${hash}:skills/${name}/metadata.json`);
      return { version: index + 1, hash, metadata: JSON.parse(raw) as SkillRecord };
    }));
  }

  async diff(name: string, from: number, to: number): Promise<{ diff: string }> {
    const versions = await this.versions(name);
    const a = versions.find((version) => version.version === from);
    const b = versions.find((version) => version.version === to);
    if (!a || !b) throw new Error('Unknown skill version');
    return { diff: await this.git('diff', a.hash, b.hash, '--', `skills/${name}/SKILL.md`) };
  }

  async rollback(name: string, version: number): Promise<SkillRecord> {
    const versions = await this.versions(name);
    const target = versions.find((item) => item.version === version);
    if (!target) throw new Error('Unknown skill version');
    const content = await this.git('show', `${target.hash}:skills/${name}/SKILL.md`);
    return this.import({
      name, content, sourceProfile: target.metadata.sourceProfile,
      sourcePath: target.metadata.sourcePath, trust: target.metadata.trust,
    });
  }

  private async candidates(home: string): Promise<{ name: string; source: string; content: string }[]> {
    const root = join(home, 'skills');
    if (!existsSync(root)) return [];
    const candidates: { name: string; source: string; content: string }[] = [];
    // Hermes writes both skills/<name> and skills/<category>/<name>.
    const directories = [root];
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (entry.isDirectory() && validName.test(entry.name) && !existsSync(join(root, entry.name, 'SKILL.md'))) {
        directories.push(join(root, entry.name));
      }
    }
    for (const parent of directories) {
      for (const entry of await readdir(parent, { withFileTypes: true })) {
        if (!entry.isDirectory() || !validName.test(entry.name)) continue;
        const directory = join(parent, entry.name);
        const source = join(directory, 'SKILL.md');
        if (!existsSync(source) || existsSync(join(directory, marker)) || (await lstat(source)).isSymbolicLink()) continue;
        candidates.push({ name: entry.name, source, content: await readFile(source, 'utf8') });
      }
    }
    return candidates;
  }

  private fingerprint(content: string): string {
    return createHash('sha256').update(content.replace(/\r\n/g, '\n')).digest('hex');
  }

  async sync(profile: string, home: string): Promise<SkillRecord[]> {
    safeName(profile);
    const seen = this.seen.get(profile) ?? new Map<string, string>();
    const imported: SkillRecord[] = [];
    for (const { name, source, content } of await this.candidates(home)) {
      const hash = this.fingerprint(content);
      if (seen.get(source) === hash) continue;
      imported.push(await this.import({ name, content, sourceProfile: profile, sourcePath: source }));
      seen.set(source, hash);
    }
    this.seen.set(profile, seen);
    return imported;
  }

  private key(engine: Engine, targetId: string): string { return `${engine}:${targetId}`; }

  async hermes(profile: string, home: string): Promise<string> {
    this.homes.set(this.key('hermes', safeName(profile)), home);
    if (!this.seen.has(profile)) {
      const initial = await this.candidates(home);
      this.seen.set(profile, new Map(initial.map(({ source, content }) => [source, this.fingerprint(content)])));
    }
    await this.refresh('hermes', profile);
    const rows = this.assignments.filter((item) => item.engine === 'hermes' && item.targetId === profile);
    return createHash('sha256').update(JSON.stringify(await Promise.all(rows.map((item) => this.record(item.name))))).digest('hex');
  }

  async dsh(sessionId: string, home: string): Promise<void> {
    this.homes.set(this.key('dsh', sessionId), home);
    await this.refresh('dsh', sessionId);
  }

  async assign(input: { name: string; engine: Engine; targetId: string; assigned: boolean }): Promise<{ assigned: boolean }> {
    return this.serialize(async () => {
    safeName(input.name);
    if (input.engine !== 'dsh' && input.engine !== 'hermes') throw new Error('Unknown engine');
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(input.targetId)) throw new Error('Invalid target');
    if (input.assigned) await this.record(input.name);
    this.assignments = this.assignments.filter((row) => row.name !== input.name || row.engine !== input.engine || row.targetId !== input.targetId);
    if (input.assigned) this.assignments.push({ name: input.name, engine: input.engine, targetId: input.targetId });
    await writeFile(this.assignmentsFile, JSON.stringify(this.assignments, null, 2) + '\n', 'utf8');
    await this.refresh(input.engine, input.targetId);
    return { assigned: input.assigned };
    });
  }

  listAssignments(): Assignment[] { return [...this.assignments]; }

  private async refreshAll(name: string): Promise<void> {
    for (const row of this.assignments.filter((item) => item.name === name)) await this.refresh(row.engine, row.targetId);
  }

  private async refresh(engine: Engine, targetId: string): Promise<void> {
    const home = this.homes.get(this.key(engine, targetId));
    if (!home || this.disposed) return;
    const root = join(home, 'skills');
    for (const path of [...this.projected]) {
      if (!path.startsWith(root + '\\') && !path.startsWith(root + '/')) continue;
      const name = path.slice(root.length + 1);
      if (!this.assignments.some((item) => item.name === name && item.engine === engine && item.targetId === targetId)) {
        await this.removeOwned(path);
        this.projected.delete(path);
      }
    }
    for (const row of this.assignments.filter((item) => item.engine === engine && item.targetId === targetId)) {
      const destination = join(root, row.name);
      if (existsSync(destination)) {
        if (!existsSync(join(destination, marker)) || (await lstat(destination)).isSymbolicLink()) {
          throw new Error(`Skill destination already in use: ${row.name}`);
        }
        const owned = JSON.parse(await readFile(join(destination, marker), 'utf8')) as { name: string };
        if (owned.name !== row.name) throw new Error(`Skill destination marker mismatch: ${row.name}`);
      }
      const { content, metadata } = await this.get(row.name);
      await mkdir(destination, { recursive: true });
      await writeFile(join(destination, 'SKILL.md'), content, 'utf8');
      await writeFile(join(destination, marker), JSON.stringify({ name: row.name, version: metadata.version }) + '\n', 'utf8');
      this.projected.add(destination);
    }
  }

  private async removeOwned(path: string): Promise<void> {
    if (!existsSync(join(path, marker))) return;
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) return;
    const record = JSON.parse(await readFile(join(path, marker), 'utf8')) as { name: string };
    if (record.name === path.split(/[\\/]/).at(-1)) {
      await unlink(join(path, 'SKILL.md')).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
      await unlink(join(path, marker));
      await rmdir(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOTEMPTY') throw error; });
    }
  }

  async removeAll(): Promise<void> {
    this.disposed = true;
    await this.pending;
    for (const path of this.projected) await this.removeOwned(path);
    this.projected.clear();
    this.homes.clear();
    this.seen.clear();
  }
}
