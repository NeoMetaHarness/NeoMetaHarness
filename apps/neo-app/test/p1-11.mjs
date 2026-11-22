import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, writeFileSync, rmSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(testDir, '..');
const repoDir = resolve(appDir, '../..');
const exe = join(appDir, 'src-tauri/target/debug/neo-meta-harness.exe');

async function eventually(fn, label, retries = 150) {
  let last;
  for (let i = 0; i < retries; i++) {
    try {
      const result = await fn();
      if (result) return result;
    } catch (e) { last = e; }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for ${label}${last ? `: ${last.message}` : ''}`);
}

async function availablePort() {
  const server = createNetServer();
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}

async function openWebview(port) {
  const page = await eventually(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`);
    return (await response.json()).find((item) => item.type === 'page' && /tauri\.localhost/.test(item.url));
  }, 'WebView2 debugging page');
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((done, reject) => { socket.onopen = done; socket.onerror = reject; });
  let id = 0;
  const pending = new Map();
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (!pending.has(message.id)) return;
    pending.get(message.id)(message);
    pending.delete(message.id);
  };
  const send = (method, params = {}) => new Promise((done, reject) => {
    const number = ++id;
    pending.set(number, (message) => message.error ? reject(new Error(message.error.message)) : done(message.result));
    socket.send(JSON.stringify({ id: number, method, params }));
  });
  await send('Runtime.enable');
  const evaluate = async (expression) => {
    const answer = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (answer.exceptionDetails) throw new Error(answer.result?.description ?? answer.exceptionDetails.text);
    return answer.result.value;
  };
  return {
    evaluate,
    wait: async (expression, label) => {
      try {
        return await eventually(() => evaluate(expression), label);
      } catch (error) {
        const alert = await evaluate('document.querySelector("[role=alert]")?.textContent ?? ""');
        const roleStatus = await evaluate('document.querySelector("[role=status]")?.textContent ?? ""');
        const sectionHtml = await evaluate('document.querySelector("section[aria-label=\'Desktop updates\']")?.innerHTML ?? ""');
        throw new Error(`${error.message}. UI alert: "${alert}". Status: "${roleStatus}". Section HTML: "${sectionHtml}"`);
      }
    },
    close: () => socket.close(),
  };
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function closeWindow(pid) {
  const script = `$process = Get-Process -Id ${pid} -ErrorAction Stop; Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class CloseWindow { [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr wp, IntPtr lp); }'; if ($process.MainWindowHandle -eq [IntPtr]::Zero -or -not [CloseWindow]::PostMessage($process.MainWindowHandle, 16, [IntPtr]::Zero, [IntPtr]::Zero)) { throw 'Could not close window' }`;
  execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8' });
}

// 1. Build frontend and tauri binary
console.log('Building frontend with Vite...');
execFileSync(process.execPath, [join(appDir, 'node_modules/vite/bin/vite.js'), 'build'], { cwd: appDir, stdio: 'pipe' });

console.log('Running installer-check unit checks (checked-in owner key accepted; placeholder, differing and malformed keys rejected)...');
const { runInstallerCheck } = await import('../../../scripts/installer-check.mjs');
const baseTauriConf = JSON.parse(await readFile(join(appDir, 'src-tauri/tauri.conf.json'), 'utf8'));

// The checked-in key is the owner's real public key, and it is accepted as is (no override, no bypass).
const PLACEHOLDER_KEY = 'REPLACE_WITH_BASE64_MINISIGN_PUBLIC_KEY';
const checkedInKey = baseTauriConf.plugins.updater.pubkey;
assert.ok(typeof checkedInKey === 'string' && checkedInKey !== PLACEHOLDER_KEY, 'tauri.conf.json carries the real owner key');
runInstallerCheck({ ignoreEnv: true });

// A placeholder in the checked-in config still fails closed. `configOverride` patches an in-memory copy of
// tauri.conf.json (the "checked-in" config the check reads), never the file itself.
const placeholderOverride = { plugins: { updater: { pubkey: PLACEHOLDER_KEY } } };
assert.throws(
  () => runInstallerCheck({ ignoreEnv: true, configOverride: placeholderOverride }),
  /release installer packaging requires a valid owner minisign public key, not a placeholder or empty string/,
  'installer-check must reject the placeholder public key with no bypass'
);

// Verify that an empty pubkey fails installer-check
assert.throws(
  () => runInstallerCheck({
    ignoreEnv: true,
    configOverride: {
      plugins: {
        updater: {
          pubkey: '',
        },
      },
    },
  }),
  /release installer packaging requires a valid owner minisign public key/,
  'installer-check must reject an empty public key'
);

// Test fixtures for Minisign public key validation
// Valid release public key (key ID = 'OWNERKEY', comment = 'untrusted comment: release public key')
const validReleaseKey = 'dW50cnVzdGVkIGNvbW1lbnQ6IHJlbGVhc2UgcHVibGljIGtleQpSV1JQVjA1RlVrdEZXVnBhV2xwYVdscGFXbHBhV2xwYVdscGFXbHBhV2xwYVdscGFXbHBhV2xwYQo=';
// Accepted valid release key with CRLF line endings
const acceptedCrlfKey = 'dW50cnVzdGVkIGNvbW1lbnQ6IHJlbGVhc2UgcHVibGljIGtleQ0KUldSUFYwNUZVa3RGV1ZwYVdscGFXbHBhV2xwYVdscGFXbHBhV2xwYVdscGFXbHBhV2xwYVdscGENCg==';
// Test key with explicit warning comment and test key ID 'TESTKEY1' (must be rejected in release builds)
const testKey = 'dW50cnVzdGVkIGNvbW1lbnQ6IE5FTyBURVNUIEtFWSAtIERPIE5PVCBTSElQClJXUlVSVk5VUzBWWk1WcGFXbHBhV2xwYVdscGFXbHBhV2xwYVdscGFXbHBhV2xwYVdscGFXbHBhCg==';
// Structurally malformed key: empty second line
const emptyLine2Key = 'dW50cnVzdGVkIGNvbW1lbnQ6IHJlbGVhc2UgcHVibGljIGtleQoK';
// Structurally malformed key: two trailing newlines
const twoTrailingNewlinesKey = 'dW50cnVzdGVkIGNvbW1lbnQ6IHJlbGVhc2UgcHVibGljIGtleQpSV1JQVjA1RlVrdEZXVnBhV2xwYVdscGFXbHBhV2xwYVdscGFXbHBhV2xwYVdscGFXbHBhV2xwYQoK';
// Structurally malformed key: 32-byte key line 2 (instead of 42 bytes)
const badLen32Key = 'dW50cnVzdGVkIGNvbW1lbnQ6IHJlbGVhc2UgcHVibGljIGtleQpXbHBhV2xwYVdscGFXbHBhV2xwYVdscGFXbHBhV2xwYVdscGFXbHBhV2xvPQo=';
// Structurally malformed key: data after '=' in base64 line
const dataAfterEqKey = 'dW50cnVzdGVkIGNvbW1lbnQ6IHJlbGVhc2UgcHVibGljIGtleQpSV1JTVDFkT1JWSkxSVmxhV2xwYVdscGFXbHBhV2xwYVdscGFXbHBhV2xwYVdscGFXbHBhV2w9QQo=';
// Structurally malformed key: UTF-8 BOM at start
const bomKey = '77u/dW50cnVzdGVkIGNvbW1lbnQ6IHJlbGVhc2UgcHVibGljIGtleQpSV1JQVjA1RlVrdEZXVnBhV2xwYVdscGFXbHBhV2xwYVdscGFXbHBhV2xwYQo=';
// Structurally malformed key: surface-valid base64 (>40 chars) but not a minisign file
const malformedSurfaceKey = Buffer.from('this is a surface-valid base64 string that is not a minisign key at all').toString('base64');
// Structurally malformed key: line 2 algorithm is 'XX' instead of 'Ed'
const badAlgKey = 'dW50cnVzdGVkIGNvbW1lbnQ6IHRlc3QKV0ZoVVJWTlVTMFZaTVZwYVdscGFXbHBhV2xwYVdscGFXbHBhV2xwYVdscGFXbHBhV2xwYVdscGEK';
// Wrapped outer base64 (embedded newline in outer base64 string)
const wrappedOuterKey = `${validReleaseKey.slice(0, 32)}\n${validReleaseKey.slice(32)}`;
// Nonzero unused padding bits in outer base64 ('o=' replaced with 'p=')
const unusedBitsOuterKey = `${validReleaseKey.slice(0, -4)}YQp=`;
// Nonzero unused padding bits in inner base64 (line 2 ends with non-canonical padding)
const unusedBitsInnerKey = 'dW50cnVzdGVkIGNvbW1lbnQ6IHJlbGVhc2UgcHVibGljIGtleQpSV1JQVjA1RlVrdEZXVnBhV2xwYVdscGFXbHBhV2xwYVdscGFXbHBhV2xwYVdscGFXbHBhV2xwPQo=';
// Leading vertical tab (Rust is_ascii_whitespace excludes \v, so it is preserved and rejected as base64)
const vtKey = `\x0b${validReleaseKey}`;
// Probe 1: Trailing newline on outer pubkey
const trailingNewlineOuterKey = `${validReleaseKey}\n`;
// Probe 2: Leading space on outer pubkey
const leadingSpaceOuterKey = ` ${validReleaseKey}`;
// Probe 2b: Leading tab on outer pubkey
const leadingTabOuterKey = `\t${validReleaseKey}`;
// Probe 3: Space before decoded key line (line 2)
const spaceBeforeKeyLine = 'dW50cnVzdGVkIGNvbW1lbnQ6IHJlbGVhc2UgcHVibGljIGtleQogUldSUFYwNUZVa3RGV1ZwYVdscGFXbHBhV2xwYVdscGFXbHBhV2xwYVdscGFXbHBhV2xwYVdscGEK';

// Key fixture with high-bit key ID: in ascii toString it would mask to TESTKEY1, but raw byte compare distinguishes it
const highBitKeyBytes = Buffer.concat([
  Buffer.from([0x45, 0x64]), // 'Ed'
  Buffer.from([0xD4, 0xC5, 0xD3, 0xD4, 0xCB, 0xC5, 0xD9, 0xB1]), // 'TESTKEY1' with high bits set
  Buffer.alloc(32, 0x5a), // 32 bytes pubkey
]);
const highBitMinisignFile = `untrusted comment: release public key\n${highBitKeyBytes.toString('base64')}\n`;
const highBitKey = Buffer.from(highBitMinisignFile, 'utf8').toString('base64');

// Verify that an empty pubkey fails installer-check
assert.throws(
  () => runInstallerCheck({
    ignoreEnv: true,
    configOverride: { plugins: { updater: { pubkey: '' } } },
  }),
  /release installer packaging requires a valid owner minisign public key/,
  'installer-check must reject an empty public key'
);

// Verify valid release key fixture is accepted
runInstallerCheck({
  configOverride: { plugins: { updater: { pubkey: validReleaseKey } } },
  ignoreEnv: true,
});

// Verify accepted CRLF key fixture is accepted
runInstallerCheck({
  configOverride: { plugins: { updater: { pubkey: acceptedCrlfKey } } },
  ignoreEnv: true,
});

// Verify test key ID is rejected in installer-check
assert.throws(
  () => runInstallerCheck({
    ignoreEnv: true,
    configOverride: { plugins: { updater: { pubkey: testKey } } },
  }),
  /test public key with ID 'TESTKEY1' must not ship in a release build/,
  'installer-check must reject test key'
);

// Verify structurally malformed keys fail installer-check
assert.throws(
  () => runInstallerCheck({
    ignoreEnv: true,
    configOverride: { plugins: { updater: { pubkey: emptyLine2Key } } },
  }),
  /line 2 is empty/i,
  'installer-check must reject key with empty line 2'
);

assert.throws(
  () => runInstallerCheck({
    ignoreEnv: true,
    configOverride: { plugins: { updater: { pubkey: twoTrailingNewlinesKey } } },
  }),
  /must have exactly 2 lines/i,
  'installer-check must reject key with two trailing newlines'
);

assert.throws(
  () => runInstallerCheck({
    ignoreEnv: true,
    configOverride: { plugins: { updater: { pubkey: badLen32Key } } },
  }),
  /must decode to exactly 42 bytes/i,
  'installer-check must reject key line 2 with 32 bytes'
);

assert.throws(
  () => runInstallerCheck({
    ignoreEnv: true,
    configOverride: { plugins: { updater: { pubkey: dataAfterEqKey } } },
  }),
  /invalid character after '='|not valid base64/i,
  'installer-check must reject key with data after ='
);

assert.throws(
  () => runInstallerCheck({
    ignoreEnv: true,
    configOverride: { plugins: { updater: { pubkey: bomKey } } },
  }),
  /must begin with "untrusted comment:"/i,
  'installer-check must reject key with UTF-8 BOM'
);

assert.throws(
  () => runInstallerCheck({
    ignoreEnv: true,
    configOverride: { plugins: { updater: { pubkey: malformedSurfaceKey } } },
  }),
  /Minisign public key file must/i,
  'installer-check must reject surface-valid base64 key lacking minisign file structure'
);

assert.throws(
  () => runInstallerCheck({
    ignoreEnv: true,
    configOverride: { plugins: { updater: { pubkey: badAlgKey } } },
  }),
  /algorithm ID must be "Ed"/i,
  'installer-check must reject key with wrong algorithm ID'
);

assert.throws(
  () => runInstallerCheck({
    ignoreEnv: true,
    configOverride: { plugins: { updater: { pubkey: wrappedOuterKey } } },
  }),
  /invalid character in base64/i,
  'installer-check must reject wrapped outer base64 key'
);

assert.throws(
  () => runInstallerCheck({
    ignoreEnv: true,
    configOverride: { plugins: { updater: { pubkey: unusedBitsOuterKey } } },
  }),
  /nonzero unused padding bits/i,
  'installer-check must reject outer base64 key with nonzero unused padding bits'
);

assert.throws(
  () => runInstallerCheck({
    ignoreEnv: true,
    configOverride: { plugins: { updater: { pubkey: unusedBitsInnerKey } } },
  }),
  /nonzero unused padding bits/i,
  'installer-check must reject inner base64 key with nonzero unused padding bits'
);

assert.throws(
  () => runInstallerCheck({
    ignoreEnv: true,
    configOverride: { plugins: { updater: { pubkey: vtKey } } },
  }),
  /invalid character in base64/i,
  'installer-check must reject key with leading vertical tab'
);

// Probe 1 test: Trailing newline on outer pubkey must be rejected
assert.throws(
  () => runInstallerCheck({
    ignoreEnv: true,
    configOverride: { plugins: { updater: { pubkey: trailingNewlineOuterKey } } },
  }),
  /invalid character in base64/i,
  'installer-check must reject outer pubkey with trailing newline'
);

// Probe 2 test: Leading space or tab on outer pubkey must be rejected
assert.throws(
  () => runInstallerCheck({
    ignoreEnv: true,
    configOverride: { plugins: { updater: { pubkey: leadingSpaceOuterKey } } },
  }),
  /invalid character in base64/i,
  'installer-check must reject outer pubkey with leading space'
);

assert.throws(
  () => runInstallerCheck({
    ignoreEnv: true,
    configOverride: { plugins: { updater: { pubkey: leadingTabOuterKey } } },
  }),
  /invalid character in base64/i,
  'installer-check must reject outer pubkey with leading tab'
);

// Probe 3 test: Space before decoded key line must be rejected
assert.throws(
  () => runInstallerCheck({
    ignoreEnv: true,
    configOverride: { plugins: { updater: { pubkey: spaceBeforeKeyLine } } },
  }),
  /line 2 is not valid base64|invalid character in base64/i,
  'installer-check must reject key with space before decoded key line'
);

// Verify high-bit key ID does NOT collide with TESTKEY1 when compared by raw bytes
runInstallerCheck({
  ignoreEnv: true,
  configOverride: { plugins: { updater: { pubkey: highBitKey } } },
});

// Verify TAURI_ENV_CONFIG is rejected
process.env.TAURI_ENV_CONFIG = JSON.stringify({ plugins: { updater: { pubkey: validReleaseKey } } });
assert.throws(
  () => runInstallerCheck(),
  /TAURI_ENV_CONFIG is not supported by Tauri/i,
  'installer-check must reject TAURI_ENV_CONFIG'
);
delete process.env.TAURI_ENV_CONFIG;

// Verify release config with createUpdaterArtifacts: true is accepted
runInstallerCheck({
  configOverride: {
    bundle: { createUpdaterArtifacts: true },
    plugins: { updater: { pubkey: validReleaseKey } },
  },
  ignoreEnv: true,
});

// Verify non-boolean createUpdaterArtifacts fails installer-check
assert.throws(
  () => runInstallerCheck({
    configOverride: {
      bundle: { createUpdaterArtifacts: 'invalid' },
      plugins: { updater: { pubkey: validReleaseKey } },
    },
    ignoreEnv: true,
  }),
  /bundle.createUpdaterArtifacts must be boolean/i,
  'installer-check must reject non-boolean createUpdaterArtifacts'
);

// Verify unauthorized updater endpoint fails installer-check
assert.throws(
  () => runInstallerCheck({
    configOverride: {
      plugins: {
        updater: {
          pubkey: validReleaseKey,
          endpoints: ['https://attacker.com/latest.json'],
        },
      },
    },
    ignoreEnv: true,
  }),
  /production updater endpoint must be exact GitHub Releases feed URL/i,
  'installer-check must reject unauthorized updater endpoint'
);

// Verify unauthorized allowedHosts fail installer-check
assert.throws(
  () => runInstallerCheck({
    configOverride: {
      plugins: {
        updater: {
          pubkey: validReleaseKey,
          allowedHosts: ['github.com', 'attacker.com'],
        },
      },
    },
    ignoreEnv: true,
  }),
  /production updater allowedHosts must match fixed GitHub asset hosts/i,
  'installer-check must reject unauthorized allowedHosts'
);

// Verify explicitly empty TAURI_ENV_CONFIG is also rejected
process.env.TAURI_ENV_CONFIG = '';
assert.throws(
  () => runInstallerCheck(),
  /TAURI_ENV_CONFIG is not supported by Tauri/i,
  'installer-check must reject explicitly empty TAURI_ENV_CONFIG'
);
delete process.env.TAURI_ENV_CONFIG;

// Key source fails closed: the release key must equal the key checked in to tauri.conf.json. Release builds run
// with TAURI_CONFIG unset; a TAURI_CONFIG or --config key that differs from the checked-in one is refused,
// whether this runs standalone or as Tauri's beforeBundleCommand (TAURI_ENV_* set).
const differs = /differs from the key checked in to apps\/neo-app\/src-tauri\/tauri\.conf\.json/;
for (const hook of [false, true]) {
  if (hook) process.env.TAURI_ENV_PLATFORM = 'windows'; else delete process.env.TAURI_ENV_PLATFORM;
  // Env-only key over a checked-in placeholder: refused.
  process.env.TAURI_CONFIG = JSON.stringify({ plugins: { updater: { pubkey: validReleaseKey } } });
  assert.throws(() => runInstallerCheck({ configOverride: placeholderOverride }), differs, 'TAURI_CONFIG-only key is refused (hook=' + hook + ')');
  // Env key that differs from the real checked-in owner key: refused.
  assert.throws(() => runInstallerCheck(), differs, 'TAURI_CONFIG key differing from the checked-in owner key is refused (hook=' + hook + ')');
  // Env key that differs from another valid checked-in key: refused.
  assert.throws(
    () => runInstallerCheck({ configOverride: { plugins: { updater: { pubkey: acceptedCrlfKey } } } }),
    differs,
    'TAURI_CONFIG key differing from the checked-in key is refused (hook=' + hook + ')'
  );
  // Env key equal to the checked-in key: accepted (the real owner key, and a fixture key).
  runInstallerCheck({ configOverride: { plugins: { updater: { pubkey: validReleaseKey } } } });
  process.env.TAURI_CONFIG = JSON.stringify({ plugins: { updater: { pubkey: checkedInKey } } });
  runInstallerCheck();
  // Unrelated TAURI_CONFIG settings keep the checked-in key: the owner key passes, a placeholder fails closed.
  process.env.TAURI_CONFIG = JSON.stringify({ plugins: { unrelatedPlugin: { enabled: true } } });
  runInstallerCheck();
  assert.throws(() => runInstallerCheck({ configOverride: placeholderOverride }), /release installer packaging requires a valid owner minisign public key/);
  runInstallerCheck({ configOverride: { plugins: { updater: { pubkey: validReleaseKey } } } });
  // A placeholder in TAURI_CONFIG fails on the key itself.
  process.env.TAURI_CONFIG = JSON.stringify({ plugins: { updater: { pubkey: PLACEHOLDER_KEY } } });
  assert.throws(
    () => runInstallerCheck({ configOverride: { plugins: { updater: { pubkey: validReleaseKey } } } }),
    /release installer packaging requires a valid owner minisign public key/
  );
  delete process.env.TAURI_CONFIG;
}
delete process.env.TAURI_ENV_PLATFORM;

// A --config argument may not swap the key either; one that repeats the checked-in key is fine.
assert.throws(
  () => runInstallerCheck({ ignoreEnv: true, cliArgs: ['--config', JSON.stringify({ plugins: { updater: { pubkey: validReleaseKey } } })] }),
  differs,
  '--config key differing from the checked-in owner key is refused'
);
runInstallerCheck({ ignoreEnv: true, cliArgs: ['--config', JSON.stringify({ plugins: { updater: { pubkey: checkedInKey } } })] });
// Deleting the real checked-in owner key through --config is refused too.
assert.throws(
  () => runInstallerCheck({ ignoreEnv: true, cliArgs: ['--config', JSON.stringify({ plugins: { updater: { pubkey: null } } })] }),
  /plugins\.updater\.pubkey is missing/,
  '--config null patch deleting the checked-in owner key is refused'
);
runInstallerCheck({
  ignoreEnv: true,
  configOverride: { plugins: { updater: { pubkey: validReleaseKey } } },
  cliArgs: ['--config', JSON.stringify({ bundle: { createUpdaterArtifacts: true }, plugins: { updater: { pubkey: validReleaseKey } } })],
});
// Standalone --config patches apply onto the real base config in order with JSON-merge-patch semantics, and
// anything unparsable fails closed (matching build.rs for TAURI_CONFIG).
const checkedInKeyOverride = { plugins: { updater: { pubkey: validReleaseKey } } };
const otherValidKey = acceptedCrlfKey;
assert.notEqual(otherValidKey, validReleaseKey, 'fixture keys differ');
// The checked-in key, with no patches, is accepted.
runInstallerCheck({ ignoreEnv: true, configOverride: checkedInKeyOverride, cliArgs: [] });
// A null patch deletes the checked-in key: refused, not silently discarded.
assert.throws(
  () => runInstallerCheck({
    ignoreEnv: true,
    configOverride: checkedInKeyOverride,
    cliArgs: ['--config', JSON.stringify({ plugins: { updater: { pubkey: null } } })],
  }),
  /plugins\.updater\.pubkey is missing/,
  '--config null patch deleting the pubkey is refused'
);
// Same deletion delivered through TAURI_CONFIG.
assert.throws(
  () => runInstallerCheck({
    configOverride: checkedInKeyOverride,
    envConfig: JSON.stringify({ plugins: { updater: { pubkey: null } } }),
    cliArgs: [],
  }),
  /plugins\.updater\.pubkey is missing/,
  'TAURI_CONFIG null patch deleting the pubkey is refused'
);
// Malformed JSON is a hard failure, even when the checked-in key is valid.
assert.throws(
  () => runInstallerCheck({ ignoreEnv: true, configOverride: checkedInKeyOverride, cliArgs: ['--config', '{not json'] }),
  /invalid JSON in --config argument/,
  '--config with malformed inline JSON is refused'
);
assert.throws(
  () => runInstallerCheck({ ignoreEnv: true, configOverride: checkedInKeyOverride, cliArgs: ['--config', join(tmpdir(), 'neo-no-such-config-file.json')] }),
  /cannot read --config file/,
  '--config pointing at a missing file is refused'
);
assert.throws(
  () => runInstallerCheck({ ignoreEnv: true, configOverride: checkedInKeyOverride, cliArgs: ['--config'] }),
  /requires a value/,
  '--config without a value is refused'
);
assert.throws(
  () => runInstallerCheck({ configOverride: checkedInKeyOverride, envConfig: '{not json', cliArgs: [] }),
  /invalid JSON in TAURI_CONFIG/,
  'malformed TAURI_CONFIG is refused'
);
const malformedConfigDir = await mkdtemp(join(tmpdir(), 'neo-installer-check-'));
try {
  const malformedConfigFile = join(malformedConfigDir, 'bad.json');
  writeFileSync(malformedConfigFile, '{"plugins": ');
  assert.throws(
    () => runInstallerCheck({ ignoreEnv: true, configOverride: checkedInKeyOverride, cliArgs: ['--config', malformedConfigFile] }),
    /invalid JSON in --config file/,
    '--config with a malformed JSON file is refused'
  );
} finally {
  await rm(malformedConfigDir, { recursive: true, force: true });
}
// A valid but different key is refused.
assert.throws(
  () => runInstallerCheck({
    ignoreEnv: true,
    configOverride: checkedInKeyOverride,
    cliArgs: ['--config', JSON.stringify({ plugins: { updater: { pubkey: otherValidKey } } })],
  }),
  differs,
  '--config patch with a valid but different key is refused'
);
// A later patch cannot be hidden by an earlier one: delete, then restore the same key is fine; order matters.
runInstallerCheck({
  ignoreEnv: true,
  configOverride: checkedInKeyOverride,
  cliArgs: [
    '--config', JSON.stringify({ plugins: { updater: { pubkey: null } } }),
    '--config', JSON.stringify({ plugins: { updater: { pubkey: validReleaseKey } } }),
  ],
});
assert.throws(
  () => runInstallerCheck({
    ignoreEnv: true,
    configOverride: checkedInKeyOverride,
    cliArgs: [
      '--config', JSON.stringify({ plugins: { updater: { pubkey: validReleaseKey } } }),
      '--config', JSON.stringify({ plugins: { updater: { pubkey: null } } }),
    ],
  }),
  /plugins\.updater\.pubkey is missing/,
  'a later null patch wins over an earlier restore'
);
console.log('Installer check verification passed (checked-in owner key accepted, placeholder and differing keys rejected, effective config merging, structural validation enforced).');

console.log('Running update-state unit test (frontend renders only update_state; out-of-order replies dropped)...');
execFileSync(process.execPath, ['--experimental-strip-types', join(appDir, 'test/p1-11-update-state.mjs')], { cwd: appDir, stdio: 'pipe' });

console.log('Running cargo unit tests (verifying updater overrides and endpoint HTTPS enforcement)...');
execFileSync(join(process.env.USERPROFILE, '.cargo/bin/cargo.exe'), ['test'], {
  cwd: join(appDir, 'src-tauri'), stdio: 'pipe',
});

console.log('Testing release build fail-closed validation in build.rs...');
const cargoBin = join(process.env.USERPROFILE, '.cargo/bin/cargo.exe');
const srcTauriDir = join(appDir, 'src-tauri');

function assertCargoCheckFailsWith(env, expectedPattern, description, extraOpts = {}) {
  try {
    execFileSync(cargoBin, ['check', '--release'], {
      cwd: srcTauriDir,
      stdio: 'pipe',
      env: { ...process.env, ...env },
      ...extraOpts,
    });
    assert.fail(`Expected cargo check --release to fail for ${description}`);
  } catch (err) {
    const combined = `${err.message || ''}\n${err.stderr ? err.stderr.toString('utf8') : ''}\n${err.stdout ? err.stdout.toString('utf8') : ''}`;
    assert.match(
      combined,
      expectedPattern,
      `Expected cargo check to fail with specific error matching ${expectedPattern} for: ${description}. Got:\n${combined}`
    );
  }
}

// 1. Verify cargo check --release FAILS when TAURI_CONFIG has invalid/unresolvable JSON
assertCargoCheckFailsWith(
  { TAURI_CONFIG: 'invalid-non-json' },
  /unresolvable updater configuration \(invalid JSON in TAURI_CONFIG\)/,
  'invalid TAURI_CONFIG JSON'
);

// 1b. Verify cargo check --release FAILS when TAURI_ENV_CONFIG is set (with value or empty)
assertCargoCheckFailsWith(
  { TAURI_ENV_CONFIG: JSON.stringify({ plugins: { updater: { pubkey: validReleaseKey } } }) },
  /TAURI_ENV_CONFIG is not supported by Tauri; use TAURI_CONFIG instead/,
  'TAURI_ENV_CONFIG with value'
);
assertCargoCheckFailsWith(
  { TAURI_ENV_CONFIG: '' },
  /TAURI_ENV_CONFIG is not supported by Tauri; use TAURI_CONFIG instead/,
  'empty TAURI_ENV_CONFIG'
);

// 2. Verify cargo check --release FAILS when config has missing/empty pubkey
assertCargoCheckFailsWith(
  { TAURI_CONFIG: JSON.stringify({ plugins: { updater: { pubkey: '' } } }) },
  /updater public key cannot be empty in a release build/,
  'empty updater pubkey'
);

// 3. Verify cargo check --release FAILS with the placeholder key. The checked-in file carries the real owner key,
//    so the placeholder is patched in through TAURI_CONFIG (the same merge-then-validate path build.rs uses);
//    the key is validated before the key-source rule, so the placeholder itself is reported.
assertCargoCheckFailsWith(
  { TAURI_CONFIG: JSON.stringify({ plugins: { updater: { pubkey: PLACEHOLDER_KEY } } }), TAURI_ENV_CONFIG: undefined },
  /placeholder updater public key REPLACE_WITH_BASE64_MINISIGN_PUBLIC_KEY must not ship in a release build/,
  'placeholder key'
);

// 3b. Verify cargo check --release FAILS when test key ID is used
assertCargoCheckFailsWith(
  { TAURI_CONFIG: JSON.stringify({ plugins: { updater: { pubkey: testKey } } }) },
  /test public key with ID 'TESTKEY1' must not ship in a release build/,
  'test key ID TESTKEY1'
);

// 4. Verify cargo check --release FAILS when key is surface-valid base64 but structurally malformed
assertCargoCheckFailsWith(
  { TAURI_CONFIG: JSON.stringify({ plugins: { updater: { pubkey: malformedSurfaceKey } } }) },
  /minisign public key file must have exactly 2 lines/,
  'surface-valid base64 lacking minisign structure'
);

// 5. Verify cargo check --release FAILS when key has wrong algorithm ID
assertCargoCheckFailsWith(
  { TAURI_CONFIG: JSON.stringify({ plugins: { updater: { pubkey: badAlgKey } } }) },
  /minisign public key algorithm ID must be 'Ed'/,
  'wrong algorithm ID'
);

// 5b. Verify cargo check --release FAILS when key has empty second line
assertCargoCheckFailsWith(
  { TAURI_CONFIG: JSON.stringify({ plugins: { updater: { pubkey: emptyLine2Key } } }) },
  /minisign public key line 2 is empty/,
  'empty second line'
);

// 5c. Verify cargo check --release FAILS when key has two trailing newlines
assertCargoCheckFailsWith(
  { TAURI_CONFIG: JSON.stringify({ plugins: { updater: { pubkey: twoTrailingNewlinesKey } } }) },
  /minisign public key file must have exactly 2 lines/,
  'two trailing newlines'
);

// 5d. Verify cargo check --release FAILS when key is 32 bytes instead of 42 bytes
assertCargoCheckFailsWith(
  { TAURI_CONFIG: JSON.stringify({ plugins: { updater: { pubkey: badLen32Key } } }) },
  /minisign public key must decode to exactly 42 bytes, got 32/,
  '32-byte key'
);

// 5e. Verify cargo check --release FAILS when key has data after '='
assertCargoCheckFailsWith(
  { TAURI_CONFIG: JSON.stringify({ plugins: { updater: { pubkey: dataAfterEqKey } } }) },
  /invalid character after '='/,
  'data after ='
);

// 5f. Verify cargo check --release FAILS when outer base64 is wrapped
assertCargoCheckFailsWith(
  { TAURI_CONFIG: JSON.stringify({ plugins: { updater: { pubkey: wrappedOuterKey } } }) },
  /invalid character in base64/,
  'wrapped outer base64'
);

// 5g. Verify cargo check --release FAILS when outer base64 has nonzero unused padding bits
assertCargoCheckFailsWith(
  { TAURI_CONFIG: JSON.stringify({ plugins: { updater: { pubkey: unusedBitsOuterKey } } }) },
  /nonzero unused padding bits/,
  'outer base64 nonzero unused padding bits'
);

// 5h. Verify cargo check --release FAILS when inner base64 has nonzero unused padding bits
assertCargoCheckFailsWith(
  { TAURI_CONFIG: JSON.stringify({ plugins: { updater: { pubkey: unusedBitsInnerKey } } }) },
  /nonzero unused padding bits/,
  'inner base64 nonzero unused padding bits'
);

// 5i. Verify cargo check --release FAILS when key has leading vertical tab
assertCargoCheckFailsWith(
  { TAURI_CONFIG: JSON.stringify({ plugins: { updater: { pubkey: vtKey } } }) },
  /invalid character in base64/,
  'leading vertical tab'
);

// Probe 1 in cargo: Verify cargo check --release FAILS when outer pubkey has trailing newline
assertCargoCheckFailsWith(
  { TAURI_CONFIG: JSON.stringify({ plugins: { updater: { pubkey: trailingNewlineOuterKey } } }) },
  /invalid character in base64/,
  'outer pubkey trailing newline'
);

// Probe 2 in cargo: Verify cargo check --release FAILS when outer pubkey has leading space or tab
assertCargoCheckFailsWith(
  { TAURI_CONFIG: JSON.stringify({ plugins: { updater: { pubkey: leadingSpaceOuterKey } } }) },
  /invalid character in base64/,
  'outer pubkey leading space'
);
assertCargoCheckFailsWith(
  { TAURI_CONFIG: JSON.stringify({ plugins: { updater: { pubkey: leadingTabOuterKey } } }) },
  /invalid character in base64/,
  'outer pubkey leading tab'
);

// Probe 3 in cargo: Verify cargo check --release FAILS when key has space before decoded key line
assertCargoCheckFailsWith(
  { TAURI_CONFIG: JSON.stringify({ plugins: { updater: { pubkey: spaceBeforeKeyLine } } }) },
  /minisign public key line 2 is not valid base64.*invalid character in base64/,
  'space before decoded key line'
);

// 5j. Verify cargo check --release FAILS when alternate platform configs exist (covering json, json5, and toml variants)
for (const altFile of ['tauri.windows.conf.json', 'tauri.windows.conf.json5', 'Tauri.windows.toml', 'tauri.linux.conf.json5', 'Tauri.toml']) {
  const altPath = join(srcTauriDir, altFile);
  try {
    writeFileSync(altPath, '{}', 'utf8');
    assertCargoCheckFailsWith(
      { TAURI_CONFIG: JSON.stringify({ plugins: { updater: { pubkey: validReleaseKey } } }) },
      new RegExp(`alternate config file ${altFile.replace(/\./g, '\\\.')} exists but is not supported for release validation`),
      `alternate config ${altFile}`
    );
  } finally {
    if (existsSync(altPath)) rmSync(altPath, { force: true });
  }
}

const cargoCheckSucceeds = (tauriConfig) => {
  const env = { ...process.env };
  delete env.TAURI_ENV_CONFIG;
  if (tauriConfig === undefined) delete env.TAURI_CONFIG; else env.TAURI_CONFIG = tauriConfig;
  execFileSync(cargoBin, ['check', '--release'], { cwd: srcTauriDir, stdio: 'pipe', env });
};
const keySourceDiffers = /differs from the key checked in to (apps\/neo-app\/src-tauri\/)?tauri\.conf\.json/;

// 6. Verify cargo check --release with TAURI_CONFIG setting only an unrelated plugin keeps the checked-in updater
//    config: the owner key passes; with a placeholder patched in alongside, it fails closed.
cargoCheckSucceeds(JSON.stringify({ plugins: { unrelatedPlugin: { enabled: true } } }));
assertCargoCheckFailsWith(
  { TAURI_CONFIG: JSON.stringify({ plugins: { unrelatedPlugin: { enabled: true }, updater: { pubkey: PLACEHOLDER_KEY } } }) },
  /placeholder updater public key REPLACE_WITH_BASE64_MINISIGN_PUBLIC_KEY must not ship in a release build/,
  'unrelated plugin override with placeholder pubkey'
);

// 7. Verify cargo check --release SUCCEEDS when unrelated plugin AND the checked-in owner key are supplied
cargoCheckSucceeds(JSON.stringify({ plugins: { unrelatedPlugin: { enabled: true }, updater: { pubkey: checkedInKey } } }));

// 8. Verify cargo check --release FAILS when TAURI_CONFIG swaps in a different valid key (CRLF fixture, release fixture)
assertCargoCheckFailsWith(
  { TAURI_CONFIG: JSON.stringify({ plugins: { updater: { pubkey: acceptedCrlfKey } } }) },
  keySourceDiffers,
  'TAURI_CONFIG with a valid CRLF key that differs from the checked-in key'
);
assertCargoCheckFailsWith(
  { TAURI_CONFIG: JSON.stringify({ plugins: { updater: { pubkey: validReleaseKey } } }) },
  keySourceDiffers,
  'TAURI_CONFIG with a valid key that differs from the checked-in key'
);

// 9. Verify cargo check --release SUCCEEDS with the checked-in owner key: TAURI_CONFIG unset (how release builds
//    run), or repeating the same key.
cargoCheckSucceeds(undefined);
cargoCheckSucceeds(JSON.stringify({ plugins: { updater: { pubkey: checkedInKey } } }));

// 10. Verify warm build guards: build.rs reruns when TAURI_ENV_CONFIG changes or alternate config is added
assertCargoCheckFailsWith(
  { TAURI_CONFIG: JSON.stringify({ plugins: { updater: { pubkey: validReleaseKey } } }), TAURI_ENV_CONFIG: '' },
  /TAURI_ENV_CONFIG is not supported by Tauri; use TAURI_CONFIG instead/,
  'warm build rerun with TAURI_ENV_CONFIG'
);

const warmAltPath = join(srcTauriDir, 'tauri.macos.conf.json5');
try {
  writeFileSync(warmAltPath, '{}', 'utf8');
  assertCargoCheckFailsWith(
    { TAURI_CONFIG: JSON.stringify({ plugins: { updater: { pubkey: validReleaseKey } } }) },
    /alternate config file tauri.macos.conf.json5 exists but is not supported for release validation/,
    'warm build rerun with new alternate config file'
  );
} finally {
  if (existsSync(warmAltPath)) rmSync(warmAltPath, { force: true });
}

console.log('PASS build.rs release fail-closed verification (unresolvable config, placeholder, malformed and differing keys, alternate configs, and unrelated plugin override verified; checked-in owner key passes)');
console.log('Building desktop binary with Cargo (debug)...');
execFileSync(join(process.env.USERPROFILE, '.cargo/bin/cargo.exe'), ['build'], {
  cwd: join(appDir, 'src-tauri'), stdio: 'pipe',
});

// 2. Setup mock updater server serving latest.json and redirects
let updateRequestCount = 0;
let redirectFollowedCount = 0;
const updateServer = createServer((request, response) => {
  console.log(`Fake update server received request: ${request.method} ${request.url}`);
  if (request.url === '/latest-redirect') {
    redirectFollowedCount++;
    response.writeHead(302, { Location: `http://127.0.0.1:${updateServer.address().port}/latest.json` });
    response.end();
    return;
  }
  if (request.url === '/latest.json') {
    updateRequestCount++;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      version: '0.2.0',
      notes: 'Neo Meta Harness 0.2.0 update notes',
      pub_date: '2026-11-20T12:00:00Z',
      platforms: {
        'windows-x86_64': {
          signature: 'dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZQpmYWtlLXNpZ25hdHVyZQo=',
          url: `http://127.0.0.1:${updateServer.address().port}/download/redirect`
        }
      }
    }));
    return;
  }
  if (request.url === '/download/redirect') {
    redirectFollowedCount++;
    response.writeHead(302, { Location: `http://127.0.0.1:${updateServer.address().port}/download/neo-app-0.2.0.msi.zip` });
    response.end();
    return;
  }
  response.writeHead(404).end();
});

await new Promise((done) => updateServer.listen(0, '127.0.0.1', done));
const updaterPort = updateServer.address().port;
console.log(`Fake update server listening on http://127.0.0.1:${updaterPort}`);

const home = await mkdtemp(join(tmpdir(), 'nmh-p1-11-'));
const statusFile = join(home, 'ready.json');
const cdpPort = await availablePort();

const desktop = spawn(exe, [], {
  cwd: appDir,
  stdio: 'ignore',
  windowsHide: false,
  env: {
    ...process.env,
    NMH_DESKTOP_REPO_ROOT: repoDir,
    NMH_DESKTOP_DATA_DIR: join(home, 'state'),
    NMH_HERMES_HOME: join(home, 'hermes'),
    NMH_DESKTOP_STATUS_FILE: statusFile,
    NMH_UPDATER_ENDPOINT: `http://127.0.0.1:${updaterPort}/latest-redirect`,
    WEBVIEW2_USER_DATA_FOLDER: join(home, 'webview'),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${cdpPort}`,
  },
});

let view;
let status;
try {
  status = await eventually(async () => JSON.parse(await readFile(statusFile, 'utf8')), 'desktop ready file');
  const base = `http://127.0.0.1:${status.port}`;

  view = await openWebview(cdpPort);

  // Skip onboarding when presented
  await view.wait('!!document.querySelector("[data-testid=onboarding-wizard]")', 'first-run setup');
  await view.evaluate('document.querySelector("[data-testid=onboarding-skip]")?.click()');
  await view.wait('!document.querySelector("[data-testid=onboarding-wizard]")', 'onboarding dismissed');

  // Navigate to Settings
  await view.wait('!!document.querySelector("a[href*=\\"/settings\\"]")', 'settings nav link');
  await view.evaluate('document.querySelector("a[href*=\\"/settings\\"]")?.click()');
  await view.wait('!!document.querySelector("[data-testid=settings-update-check]")', 'Settings update check button');

  // Trigger check on demand
  console.log('Clicking check for updates button...');
  await view.evaluate('document.querySelector("[data-testid=settings-update-check]")?.click()');

  // Verify UI displays available version and "Install and restart" button
  await view.wait(
    'document.querySelector("[data-testid=settings-update-available]") !== null || document.body.textContent.includes("0.2.0")',
    'update available status displayed'
  );
  await view.wait(
    'document.querySelector("[data-testid=settings-update-install]") !== null',
    'Install and restart button displayed'
  );

  const text = await view.evaluate('document.body.textContent');
  assert.ok(text.includes('0.2.0'), 'UI text contains version 0.2.0');
  assert.ok(text.includes('Update available'), 'UI text contains "Update available"');
  assert.ok(text.includes('Install and restart'), 'UI text contains "Install and restart"');

  const installButton = await view.evaluate('document.querySelector("[data-testid=settings-update-install]")?.textContent');
  assert.equal(installButton?.trim(), 'Install and restart');

  assert.ok(redirectFollowedCount >= 1, 'Fake update server redirect chain followed');
  assert.ok(updateRequestCount >= 1, 'Fake update server received at least one request');

  // Clean exit without executing install
  closeWindow(desktop.pid);
  await eventually(() => !alive(desktop.pid), 'desktop clean exit', 450);
  await eventually(async () => {
    try { await fetch(`${base}/health`); return false; } catch { return true; }
  }, 'gateway clean exit', 450);

  console.log('P1-11 PASS fake_update_server=true version=0.2.0 ui_shown=true install_not_executed=true clean_exit=true');
} finally {
  view?.close();
  if (alive(desktop.pid)) spawnSync('taskkill.exe', ['/PID', String(desktop.pid), '/T', '/F'], { windowsHide: true });
  if (status?.gatewayPid && alive(status.gatewayPid)) spawnSync('taskkill.exe', ['/PID', String(status.gatewayPid), '/T', '/F'], { windowsHide: true });
  await new Promise((done) => updateServer.close(done));
  await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 });
}
