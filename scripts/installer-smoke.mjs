// Smoke-tests the installer payload built by scripts/installer-prepare.mjs with the bundled
// Node sidecar: payload size/path report, every cordis extension entry and the gateway server
// import cleanly, and the real gateway starts from the payload and shuts down on request.
// The payload is copied outside the repository first, so Node's upward module lookup cannot
// fall back to the repository's own node_modules and hide a missing runtime dependency.
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const tauri = join(root, 'apps', 'neo-app', 'src-tauri');
const payload = join(tauri, 'installer-payload');
const MAX_RELATIVE_PATH = 200; // install dir prefix + this must stay under Windows MAX_PATH (260)

if (!existsSync(join(payload, 'apps', 'gateway', 'src', 'main.ts'))) throw new Error('No installer payload. Run pnpm installer:prepare first.');
const suffix = process.platform === 'win32' ? '.exe' : '';
const sidecars = readdirSync(join(tauri, 'binaries')).filter((name) => name.startsWith('neo-gateway-') && name.endsWith(suffix));
if (sidecars.length !== 1) throw new Error(`Expected one bundled Node sidecar, found: ${sidecars.join(', ') || 'none'}`);
const scratch = mkdtempSync(join(tmpdir(), 'nmh-installer-smoke-'));
const runtime = join(scratch, 'gateway'); // mirrors <resource dir>/gateway in the installed app
const gatewayDir = join(runtime, 'apps', 'gateway');
const extensionsDir = join(runtime, 'extensions');
const node = join(scratch, sidecars[0]);
try {
  cpSync(payload, runtime, { recursive: true });
  cpSync(join(tauri, 'binaries', sidecars[0]), node);
  console.log(`staged payload outside the repository at ${scratch}`);

  // 1. Payload report.
  let files = 0;
  let bytes = 0;
  let longest = '';
  (function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else {
        files += 1;
        bytes += statSync(path).size;
        const rel = relative(runtime, path);
        if (rel.length > longest.length) longest = rel;
      }
    }
  })(runtime);
  console.log(`payload: ${files} files, ${(bytes / 1024 / 1024).toFixed(1)} MiB, longest path ${longest.length} chars: ${longest}`);
  if (longest.length > MAX_RELATIVE_PATH) throw new Error(`Payload path longer than ${MAX_RELATIVE_PATH} chars.`);

  // 2. Import every cordis extension entry and the gateway server with the bundled Node.
  const entries = [];
  for (const name of readdirSync(extensionsDir).sort()) {
    const manifestPath = join(extensionsDir, name, 'neo.extension.json');
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (manifest.runtime?.type !== 'cordis') continue;
    entries.push([name, pathToFileURL(join(extensionsDir, name, manifest.runtime.entry)).href]);
  }
  entries.push(['gateway/server', pathToFileURL(join(gatewayDir, 'src', 'server.ts')).href]);
  const probe = join(scratch, 'probe.mjs');
  writeFileSync(probe, `const entries = ${JSON.stringify(entries)};
let failed = 0;
for (const [name, url] of entries) {
  try { await import(url); console.log('import ok   ' + name); }
  catch (error) { failed += 1; console.log('import FAIL ' + name + ': ' + (error?.stack ?? error)); }
}
process.exit(failed ? 1 : 0);
`);
  const imported = spawnSync(node, ['--import', 'tsx', probe], { cwd: gatewayDir, stdio: 'inherit', timeout: 300_000 });
  if (imported.status !== 0) throw new Error(`Import smoke failed (${imported.error?.message ?? imported.status}).`);
  console.log(`imports: ${entries.length} modules OK`);

  // 3. Start the real gateway from the payload the way the desktop shell does.
  const port = await new Promise((resolvePort, reject) => {
    const child = spawn(node, ['--import', 'tsx', 'src/main.ts'], {
      cwd: gatewayDir,
      env: { ...process.env, NMH_PORT: '0', NMH_DB_PATH: join(scratch, 'neo.sqlite'), NMH_EXTENSIONS_DIR: extensionsDir, NEO_MODE: 'desktop' },
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    let ready;
    let buffer = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Gateway did not print GATEWAY_READY within 120 s.')); }, 120_000);
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      const match = buffer.match(/^GATEWAY_READY (\{.*\})$/m);
      if (match && ready === undefined) {
        ready = JSON.parse(match[1]).port;
        console.log(`gateway: ready on port ${ready}, sending shutdown`);
        child.stdin.write('shutdown\n');
      }
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      if (ready === undefined) reject(new Error(`Gateway exited before ready (code ${code}, signal ${signal}).`));
      else if (code !== 0) reject(new Error(`Gateway shutdown exited with code ${code}, signal ${signal}.`));
      else resolvePort(ready);
    });
  });
  console.log(`gateway: started on port ${port} and shut down cleanly`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
console.log('Installer payload smoke passed.');
