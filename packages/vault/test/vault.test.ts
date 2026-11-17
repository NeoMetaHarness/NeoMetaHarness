import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { appendFile, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SqliteDatabaseProvider } from '@neometaharness/db';
import { DshProjector, HermesProjector, KeyFileProvider, VaultService } from '../src/index.js';

test('encrypted round-trip, scoped metadata, tamper detection, rotate and Hermes file reconciliation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nmh-vault-'));
  const filename = join(root, 'state.db');
  const keyfile = join(root, 'private-keys', 'master.key');
  const hermesHome = join(root, 'mock-hermes-profile');
  const db = new SqliteDatabaseProvider(filename);
  try {
    await db.migrate();
    const keys = new KeyFileProvider(keyfile);
    const vault = new VaultService(db, keys);
    const scope = { kind: 'engine' as const, workspaceId: 'org-alpha', subjectId: 'hermes-profile-a' };
    const otherScope = { kind: 'bot' as const, workspaceId: 'org-alpha', subjectId: 'bot-two' };
    const hermes = new HermesProjector(hermesHome);
    await writeFile(join(root, 'keep.txt'), 'not a vault file\n');
    await (await import('node:fs/promises')).mkdir(hermesHome);
    await writeFile(join(hermesHome, '.env'), 'USER_WRITTEN=yes\n');
    vault.bind(scope, hermes);

    const original = 'first-' + randomBytes(24).toString('hex');
    const created = await vault.put(scope, 'API_SERVER_KEY', original);
    assert.equal(created.version, 1);
    assert.equal(await vault.get(scope, 'API_SERVER_KEY'), original);
    assert.equal(await vault.get(otherScope, 'API_SERVER_KEY'), undefined);
    const list = await vault.list(scope);
    assert.equal(list.length, 1);
    assert.equal(list[0]?.name, 'API_SERVER_KEY');
    assert.equal(JSON.stringify(list).includes(original), false);
    assert.equal('value' in list[0]!, false);

    const physicalDB = new DatabaseSync(filename);
    try {
      const first = physicalDB.prepare('SELECT ciphertext, iv, tag FROM vault_secret WHERE name = ?').get('API_SERVER_KEY') as {
        ciphertext: string; iv: string; tag: string;
      };
      assert.ok(first.ciphertext.length > 0);
      assert.equal(first.ciphertext.includes(original), false);
      assert.equal(Buffer.from(first.ciphertext, 'base64').includes(Buffer.from(original)), false);
      const firstEnv = await readFile(hermes.filename, 'utf8');
      assert.match(firstEnv, /USER_WRITTEN=yes/);
      assert.match(firstEnv, /# BEGIN NEO VAULT/);
      assert.ok(firstEnv.includes('API_SERVER_KEY=' + original));
      assert.ok(!(await readFile(keyfile, 'utf8')).includes(original));
      await appendFile(hermes.filename, 'USER_TRAILING=keep-me\n');

      // Idempotent projection retains the existing file untouched.
      const before = (await stat(hermes.filename)).mtimeMs;
      await vault.sync(scope);
      assert.equal((await stat(hermes.filename)).mtimeMs, before);

      const updatedValue = 'second-' + randomBytes(24).toString('hex');
      const rotated = await vault.rotate(scope, 'API_SERVER_KEY', updatedValue);
      assert.equal(rotated.version, 2);
      assert.equal(await vault.get(scope, 'API_SERVER_KEY'), updatedValue);
      const second = physicalDB.prepare('SELECT ciphertext FROM vault_secret WHERE name = ?').get('API_SERVER_KEY') as { ciphertext: string };
      assert.notEqual(second.ciphertext, first.ciphertext);
      const updatedEnv = await readFile(hermes.filename, 'utf8');
      assert.ok(updatedEnv.includes('API_SERVER_KEY=' + updatedValue));
      assert.ok(!updatedEnv.includes(original));

      await vault.put(scope, 'HERMES_DASHBOARD_SESSION_TOKEN', 'dashboard-token-' + randomBytes(16).toString('hex'));
      assert.match(await readFile(hermes.filename, 'utf8'), /HERMES_DASHBOARD_SESSION_TOKEN=/);

      assert.equal(await vault.delete(scope, 'API_SERVER_KEY'), true);
      const afterOneDelete = await readFile(hermes.filename, 'utf8');
      assert.ok(!afterOneDelete.includes('API_SERVER_KEY='));
      assert.ok(afterOneDelete.includes('HERMES_DASHBOARD_SESSION_TOKEN='));
      assert.equal(await vault.delete(scope, 'HERMES_DASHBOARD_SESSION_TOKEN'), true);
      assert.equal(await readFile(hermes.filename, 'utf8'), 'USER_WRITTEN=yes\nUSER_TRAILING=keep-me\n');
      assert.equal(await vault.delete(scope, 'API_SERVER_KEY'), false);

      const tamperedValue = 'sensitive-tamper-test';
      await vault.put(otherScope, 'DEEPSEEK_API_KEY', tamperedValue);
      const row = physicalDB.prepare('SELECT ciphertext FROM vault_secret WHERE name = ?').get('DEEPSEEK_API_KEY') as { ciphertext: string };
      const bytes = Buffer.from(row.ciphertext, 'base64');
      bytes[0] = bytes[0]! ^ 0x01;
      physicalDB.prepare('UPDATE vault_secret SET ciphertext = ? WHERE name = ?')
        .run(bytes.toString('base64'), 'DEEPSEEK_API_KEY');
      await assert.rejects(vault.get(otherScope, 'DEEPSEEK_API_KEY'), /integrity check failed/);
    } finally {
      physicalDB.close();
    }

    // A fresh service can decrypt records using the same persisted install key.
    await vault.put(scope, 'OPENAI_API_KEY', 'persistent-secret');
    const restarted = new VaultService(db, new KeyFileProvider(keyfile));
    assert.equal(await restarted.get(scope, 'OPENAI_API_KEY'), 'persistent-secret');
    assert.equal((await readFile(join(root, 'keep.txt'), 'utf8')), 'not a vault file\n');
  } finally {
    await db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('DSH spawn env has no unrelated parent secrets', async () => {
  const prior = process.env.NEO_TEST_SECRET;
  process.env.NEO_TEST_SECRET = 'must-never-leak';
  try {
    const projector = new DshProjector();
    const env = await projector.project(new Map([
      ['DEEPSEEK_API_KEY', 'only-this-credential'],
      ['UNRELATED_SERVICE_TOKEN', 'never'],
    ]));
    assert.equal(env.DEEPSEEK_API_KEY, 'only-this-credential');
    assert.ok(!Object.hasOwn(env, 'NEO_TEST_SECRET'));
    assert.ok(!Object.hasOwn(env, 'UNRELATED_SERVICE_TOKEN'));
    for (const key of Object.keys(env)) {
      assert.ok([
        'PATH', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'DEEPSEEK_API_KEY',
      ].includes(key.toUpperCase()), 'Unexpected process environment variable: ' + key);
    }
  } finally {
    if (prior === undefined) delete process.env.NEO_TEST_SECRET;
    else process.env.NEO_TEST_SECRET = prior;
  }
});

test('Hermes rejects non-absolute homes, malformed markers and multiline env injection', async () => {
  assert.throws(() => new HermesProjector('./relative-home'), /must be absolute/);
  const root = await mkdtemp(join(tmpdir(), 'nmh-vault-profile-'));
  try {
    const project = new HermesProjector(root);
    await writeFile(project.filename, 'CUSTOM=yes\n# BEGIN NEO VAULT\nBROKEN=yes\n');
    await assert.rejects(project.project(new Map([['API_SERVER_KEY', '1234567890abcdef']])), /Malformed/);
    await writeFile(project.filename, 'CUSTOM=yes\n');
    await assert.rejects(project.project(new Map([['API_SERVER_KEY', 'line1\nline2']])), /cannot contain newlines/);
    assert.equal(await readFile(project.filename, 'utf8'), 'CUSTOM=yes\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});