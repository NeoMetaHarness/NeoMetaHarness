import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface ScheduledAsk {
  id: string;
  schedule: string;
  text: string;
  botId: string;
  mode: 'observe' | 'act';
  requesterRole?: 'member' | 'admin' | 'owner';
}

const LIMITS = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]] as const;

function cronField(value: string, min: number, max: number): Set<number> {
  const values = new Set<number>();
  for (const part of value.split(',')) {
    const match = /^(\*|\d+|\d+-\d+)(?:\/(\d+))?$/.exec(part);
    if (!match) throw new Error(`Invalid cron field: ${value}`);
    const step = match[2] ? Number(match[2]) : 1;
    if (step < 1 || step > max + 1) throw new Error('Invalid cron step');
    const [start, end] = match[1] === '*' ? [min, max]
      : match[1]!.includes('-') ? match[1]!.split('-').map(Number)
      : [Number(match[1]), Number(match[1])];
    if (start! < min || end! > max || start! > end!) throw new Error('Cron field out of range');
    for (let number = start!; number <= end!; number += step) values.add(number);
  }
  return values;
}

export function matchesCron(schedule: string, instant: Date): boolean {
  const fields = schedule.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error('Expected five-field UTC cron expression');
  const sets = fields.map((field, index) => {
    const [min, max] = LIMITS[index]!;
    return cronField(field, min, max);
  });
  const weekday = instant.getUTCDay();
  const dayMatches = sets[2]!.has(instant.getUTCDate());
  const weekdayMatches = sets[4]!.has(weekday) || (weekday === 0 && sets[4]!.has(7));
  const dayAllowed = fields[2] !== '*' && fields[4] !== '*'
    ? dayMatches || weekdayMatches : dayMatches && weekdayMatches;
  return sets[0]!.has(instant.getUTCMinutes()) && sets[1]!.has(instant.getUTCHours())
    && dayAllowed && sets[3]!.has(instant.getUTCMonth() + 1);
}

/** Neo timer feeds scheduled asks back into the Inbox, unlike the Hermes cron dashboard route. */
export class NeoCronSource {
  private readonly jobs = new Map<string, ScheduledAsk>();
  private timer?: ReturnType<typeof setInterval>;
  private lastMinute = Math.floor(Date.now() / 60000);
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly file: string, private readonly receive: (job: ScheduledAsk) => Promise<void>) {}

  async start(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8')) as ScheduledAsk[];
      for (const job of raw) {
        matchesCron(job.schedule, new Date());
        this.jobs.set(job.id, job);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    this.lastMinute = Math.floor(Date.now() / 60000);
    this.timer = setInterval(() => { void this.tick().catch((error) => console.error('Neo cron:', error)); }, 10000);
    this.timer.unref();
  }

  list(): ScheduledAsk[] { return [...this.jobs.values()].map((job) => ({ ...job })); }

  private save(): Promise<void> {
    this.writing = this.writing.then(async () => {
      await mkdir(dirname(this.file), { recursive: true });
      const temp = `${this.file}.${randomUUID()}.tmp`;
      await writeFile(temp, JSON.stringify(this.list()), { mode: 0o600 });
      await rename(temp, this.file);
    });
    return this.writing;
  }

  async create(input: Omit<ScheduledAsk, 'id'>): Promise<ScheduledAsk> {
    matchesCron(input.schedule, new Date());
    const job = { ...input, id: randomUUID() };
    this.jobs.set(job.id, job);
    await this.save();
    return { ...job };
  }

  async delete(id: string): Promise<{ deleted: boolean }> {
    const deleted = this.jobs.delete(id);
    if (deleted) await this.save();
    return { deleted };
  }

  async fire(id: string): Promise<void> {
    const job = this.jobs.get(id);
    if (!job) throw new Error('Scheduled ask not found');
    await this.receive(job);
  }

  async tick(now = new Date()): Promise<void> {
    const minute = Math.floor(now.getTime() / 60000);
    if (minute <= this.lastMinute) return;
    this.lastMinute = minute;
    await Promise.allSettled(this.list().filter((job) => matchesCron(job.schedule, now))
      .map((job) => this.receive(job)));
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.writing;
  }
}
