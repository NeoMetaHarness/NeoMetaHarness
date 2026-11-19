import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);

/** An argument-vector CLI boundary. No command is evaluated by a shell in production. */
export interface DockerCli {
  run(name: string, image: string, port: number, password?: string): Promise<void>;
  port(name: string, port: number): Promise<number>;
  release(name: string): Promise<void>;
  terminate(name: string): Promise<void>;
}

export class DockerCommandCli implements DockerCli {
  private async call(args: string[], secret?: string): Promise<string> {
    // Test shims on Windows are .cmd files. All tokens are fixed or strictly
    // validated before reaching this branch, including the image reference.
    const shim = process.env.NMH_DOCKER_CLI === 'docker.cmd' && process.platform === 'win32';
    const command = shim ? 'cmd.exe' : 'docker';
    if (shim && args.some((value) => !/^[a-zA-Z0-9._:/@=-]+$/.test(value))) {
      throw new Error('Docker shim received an unsafe argument');
    }
    const argv = shim ? ['/d', '/s', '/c', `docker.cmd ${args.join(' ')}`] : args;
    const { stdout } = await execute(command, argv, {
      env: { ...process.env, ...(secret === undefined ? {} : { VNC_PASSWORD: secret }) },
      windowsHide: true, timeout: 30000, maxBuffer: 65536,
    });
    return stdout.trim();
  }

  async run(name: string, image: string, port: number, password?: string): Promise<void> {
    const args = ['run', '--detach', '--pull=never', '--name', name,
      '--publish', `127.0.0.1::${port}/tcp`, '--network', 'bridge'];
    if (password !== undefined) args.push('--env', 'VNC_PASSWORD');
    args.push(image);
    const id = await this.call(args, password);
    if (!/^[a-f0-9]{12,64}$/i.test(id)) throw new Error('Docker did not return a container ID');
  }

  async port(name: string, port: number): Promise<number> {
    const output = await this.call(['port', name, `${port}/tcp`]);
    const found = /^127\.0\.0\.1:(\d{1,5})$/.exec(output);
    const published = found ? Number(found[1]) : 0;
    if (published < 1 || published > 65535) throw new Error('Docker VNC port is not bound to 127.0.0.1');
    return published;
  }

  async release(name: string): Promise<void> {
    await this.call(['stop', '--time', '2', name]);
    await this.call(['rm', '--force', name]);
  }

  async terminate(name: string): Promise<void> {
    await this.call(['kill', name]);
    await this.call(['rm', '--force', name]);
  }
}
