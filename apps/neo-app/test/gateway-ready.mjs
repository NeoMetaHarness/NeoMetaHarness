import { createInterface } from 'node:readline';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

/** A failed boot still owns its process tree until all database handles close. */
export async function gatewayReady(child, { timeoutMs = 60000, onToken = () => {}, errors = () => '' } = {}) {
  const closed = new Promise(resolve => child.once('close', resolve));
  const lines = createInterface({ input: child.stdout });
  let timer;
  let onError;
  let onExit;
  try {
    return await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Gateway startup timed out after ${timeoutMs}ms: ${errors()}`)), timeoutMs);
      onError = reject;
      onExit = code => reject(new Error(`Gateway exited ${code}: ${errors()}`));
      child.once('error', onError);
      child.once('exit', onExit);
      lines.on('line', line => {
        if (line.startsWith('NEO_DESKTOP_TOKEN ')) onToken(line.slice('NEO_DESKTOP_TOKEN '.length).trim());
        if (!line.startsWith('GATEWAY_READY ')) return;
        try {
          const { port } = JSON.parse(line.slice('GATEWAY_READY '.length));
          if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid gateway ready port');
          resolve(port);
        } catch (error) { reject(error); }
      });
    });
  } catch (error) {
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      if (process.platform === 'win32') {
        spawnSync(join(process.env.SystemRoot, 'System32/taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      } else {
        // Callers spawn a detached process group on POSIX, so grandchildren also close.
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      }
    }
    // 'exit' can precede stdio closure; directory cleanup must wait for 'close'.
    let closeTimer;
    try {
      await Promise.race([closed, new Promise((_, reject) => {
        closeTimer = setTimeout(() => reject(new Error('Gateway process tree failed to close', { cause: error })), 10000);
      })]);
    } finally { clearTimeout(closeTimer); }
    throw error;
  } finally {
    clearTimeout(timer);
    child.off('error', onError);
    child.off('exit', onExit);
    lines.close();
    child.stdout.resume();
  }
}
