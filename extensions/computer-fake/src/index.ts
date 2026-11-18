import { defineExtension } from '@neometaharness/kernel';
import type { Computer, ComputerInput, ComputerProvider, ComputerRegistry, Capture } from '@neometaharness/computers';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/uVUAAAAASUVORK5CYII=';
export type FakeCall = { computerId: string; action: string; x?: number; y?: number; text?: string };
export class FakeComputerProvider implements ComputerProvider {
  readonly calls: FakeCall[] = [];
  readonly capabilities = { screen: true, input: true, browserCdp: false, shell: false, files: false, snapshot: false };
  readonly computers = new Map<string, Computer>();

  provision(spec: Record<string, unknown>): Computer { return this.attach(String(spec.id ?? 'fake')); }

  attach(target: string): Computer {
    const record = (call: Omit<FakeCall, 'computerId'>) => this.calls.push({ computerId: target, ...call });
    const computer: Computer = {
      screen: () => ({ protocol: 'png' }),
      lease: () => {},
      input: (input: ComputerInput) => {
        if (input.action === 'click') record({ action: 'click', x: input.x, y: input.y });
        else if (input.action === 'type') record({ action: 'type', text: input.text });
        else record({ action: input.action });
      },
      capture: (): Capture => {
        record({ action: 'capture' });
        return { png, width: 1, height: 1 };
      },
    };
    this.computers.set(target, computer);
    return computer;
  }

  release(id: string) { this.computers.delete(id); }
}

export default defineExtension({
  activate(ctx) {
    const registry = ctx.inject<ComputerRegistry>('computers');
    if (!registry) throw new Error('Missing computer registry');
    const fake = new FakeComputerProvider();
    ctx.effect(() => registry.registerProvider('computer-fake', fake));
    ctx.route('calls', () => [...fake.calls]);
    ctx.health(() => ({ ok: true }));
  },
});