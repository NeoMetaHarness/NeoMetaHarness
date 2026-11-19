import type { Capture, Computer, ComputerInput, ComputerProvider, LeaseHolder } from '@neometaharness/computers';

/** A local desktop adapter. The host is the only authority that can instantiate it. */
export interface LocalDriver {
  screenshot(): Promise<Capture>;
  click(x: number, y: number): Promise<void>;
  move(x: number, y: number): Promise<void>;
  type(text: string): Promise<void>;
  key(keys: string): Promise<void>;
  scroll(direction: string, amount: number): Promise<void>;
  /** Must interrupt any pending input immediately. */
  close(): void | Promise<void>;
}

export type LocalDriverFactory = () => LocalDriver | Promise<LocalDriver>;
export const LOCAL_DESKTOP_ID = 'local-desktop';

class LocalComputer implements Computer {
  private holder: LeaseHolder = 'agent';
  private stopped = false;
  private driver: LocalDriver | undefined;
  private opening: Promise<LocalDriver> | undefined;

  constructor(private readonly factory: LocalDriverFactory, private readonly allowed: () => boolean) {}

  private canControl(): boolean { return !this.stopped && this.allowed() && this.holder !== 'human'; }

  private async device(): Promise<LocalDriver> {
    if (!this.canControl()) throw new Error('Local desktop control unavailable');
    if (!this.opening) this.opening = Promise.resolve().then(this.factory);
    const driver = await this.opening;
    if (!this.canControl()) {
      await driver.close();
      throw new Error('Local desktop control revoked');
    }
    this.driver = driver;
    return driver;
  }

  screen() { return { protocol: 'png' as const }; }

  lease(holder: LeaseHolder): void {
    this.holder = holder;
    if (holder === 'human') this.stop();
    else { this.stopped = false; this.opening = undefined; }
  }

  stop(): void {
    this.stopped = true;
    const driver = this.driver;
    this.driver = undefined;
    if (driver) void driver.close();
    // The factory may still be resolving. Close that driver as soon as it arrives.
    if (this.opening) void this.opening.then((pending) => pending.close()).catch(() => {});
  }

  interrupt(): void { this.stop(); }
  resumeInput(): void {
    if (this.holder === 'agent') { this.stopped = false; this.opening = undefined; }
  }

  async input(input: ComputerInput): Promise<void> {
    const driver = await this.device();
    if (input.action === 'click') return driver.click(input.x, input.y);
    if (input.action === 'move') return driver.move(input.x, input.y);
    if (input.action === 'type') return driver.type(input.text);
    if (input.action === 'key') return driver.key(input.keys);
    return driver.scroll(input.direction, input.amount);
  }

  async capture(): Promise<Capture> {
    // Screen viewing remains available during human takeover or a kill switch.
    if (!this.allowed()) throw new Error('Local desktop control unavailable');
    if (this.stopped || this.holder === 'human') {
      const viewer = await this.factory();
      try { return await viewer.screenshot(); }
      finally { await viewer.close(); }
    }
    return (await this.device()).screenshot();
  }
}

export class LocalComputerProvider implements ComputerProvider {
  readonly capabilities = { screen: true, input: true, browserCdp: false, shell: false, files: false, snapshot: false };
  private enabled = false;
  private readonly computers = new Map<string, LocalComputer>();

  constructor(private readonly factory: LocalDriverFactory) {}

  status(): { enabled: boolean } { return { enabled: this.enabled }; }

  /** Invoked only via the authenticated owner-only Gateway route. */
  setEnabled(enabled: boolean): { enabled: boolean } {
    this.enabled = enabled;
    if (!enabled) for (const computer of this.computers.values()) computer.stop();
    return this.status();
  }

  provision(): Computer { return this.attach(LOCAL_DESKTOP_ID); }

  attach(target: string): Computer {
    if (target !== LOCAL_DESKTOP_ID) throw new Error('Unsupported local desktop');
    if (!this.enabled) throw new Error('Owner has not enabled local desktop control');
    if (this.computers.has(target)) throw new Error('Local desktop already attached');
    const computer = new LocalComputer(this.factory, () => this.enabled);
    this.computers.set(target, computer);
    return computer;
  }

  release(id: string): void {
    this.computers.get(id)?.stop();
    this.computers.delete(id);
  }

  close(): void {
    this.setEnabled(false);
    for (const id of this.computers.keys()) this.release(id);
  }
}
