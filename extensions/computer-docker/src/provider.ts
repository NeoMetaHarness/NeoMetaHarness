import type { Computer, ComputerAttachContext, ComputerProvider } from '@neometaharness/computers';
import type { VaultService } from '@neometaharness/vault';
import { VncComputerProvider } from '../../computer-vnc/src/provider.js';
import { DockerCommandCli, type DockerCli } from './docker-cli.js';

type Instance = { name: string; target?: string };
const imagePattern = /^[a-zA-Z0-9][a-zA-Z0-9._/@:-]{0,254}$/;
const secretPattern = /^[A-Z][A-Z0-9_]{0,127}$/;

/** Owns only containers it created and only VNC listeners published on loopback. */
export class DockerComputerProvider implements ComputerProvider {
  readonly capabilities = { screen: true, input: true, browserCdp: false, shell: false, files: false, snapshot: false };
  private readonly vnc: VncComputerProvider;
  private readonly instances = new Map<string, Instance>();
  private readonly pending = new Set<Promise<Computer>>();
  private disposed = false;

  constructor(private readonly vault: Pick<VaultService, 'get'>, private readonly docker: DockerCli = new DockerCommandCli()) {
    this.vnc = new VncComputerProvider(vault);
  }

  attach(): never { throw new Error('Docker desktops are created with computers.provision'); }

  provision(spec: Record<string, unknown>, context?: ComputerAttachContext): Promise<Computer> {
    if (this.disposed) throw new Error('Docker provider disabled');
    const id = spec.id, image = spec.image, secretName = spec.secretName;
    const port = spec.vncPort ?? 5900;
    if (typeof id !== 'string' || !/^neo-[a-f0-9]{24}$/.test(id)) throw new Error('Invalid managed computer ID');
    if (typeof image !== 'string' || !imagePattern.test(image)) throw new Error('Invalid local Docker image');
    if (!Number.isInteger(port) || Number(port) < 1 || Number(port) > 65535) throw new Error('Invalid VNC port');
    if (secretName !== undefined && (typeof secretName !== 'string' || !secretPattern.test(secretName))) throw new Error('Invalid vault secret name');
    if (!context?.workspaceId) throw new Error('Authenticated workspace required for Docker provisioning');
    const pending = this.start(id, image, Number(port), secretName as string | undefined, context.workspaceId);
    this.pending.add(pending);
    void pending.finally(() => this.pending.delete(pending)).catch(() => {});
    return pending;
  }

  private async start(id: string, image: string, port: number, secretName: string | undefined, workspaceId: string): Promise<Computer> {
    const name = `neo-docker-${id}`;
    let password: string | undefined;
    if (secretName) {
      password = await this.vault.get({ kind: 'workspace', workspaceId }, secretName);
      if (password === undefined) throw new Error('Docker VNC vault secret is unavailable');
    }
    if (this.disposed) throw new Error('Docker provider disabled');
    this.instances.set(id, { name });
    try {
      await this.docker.run(name, image, port, password);
      if (this.disposed) throw new Error('Docker provider disabled');
      const published = await this.docker.port(name, port);
      const target = `127.0.0.1:${published}${secretName ? `#${secretName}` : ''}`;
      const instance = this.instances.get(id);
      if (!instance) throw new Error('Docker provider disabled');
      instance.target = target;
      let lastError: unknown;
      for (let attempt = 0; attempt < 20; attempt++) {
        if (this.disposed) throw new Error('Docker provider disabled');
        try { return await this.vnc.attach(target, { workspaceId }); }
        catch (error) { lastError = error; await new Promise(resolve => setTimeout(resolve, 300)); }
      }
      throw lastError;
    } catch (error) {
      await this.cleanup(id, true).catch(() => {});
      throw error;
    }
  }

  release(id: string): Promise<void> { return this.cleanup(id, false); }
  terminate(id: string): Promise<void> { return this.cleanup(id, true); }

  private async cleanup(id: string, force: boolean): Promise<void> {
    const instance = this.instances.get(id);
    if (!instance) return;
    this.instances.delete(id);
    if (instance.target) this.vnc.release(instance.target);
    if (force) await this.docker.terminate(instance.name);
    else await this.docker.release(instance.name);
  }

  async close(): Promise<void> {
    this.disposed = true;
    this.vnc.close();
    await Promise.allSettled([...this.pending]);
    await Promise.allSettled([...this.instances.keys()].map(id => this.terminate(id)));
  }
}
