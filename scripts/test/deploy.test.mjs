import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parseCompose, checkCompose, checkTemplate } from '../deploy-check.mjs';
import { hermesPlan, prepare } from '../../deploy/prepare-hermes.mjs';

const fixture = () => parseCompose(readFileSync(new URL('../../deploy/docker-compose.yml', import.meta.url), 'utf8'));
test('offline schema catches unknown fields and invalid Compose types', () => {
  assert.equal(createHash('sha256').update(readFileSync(new URL('../../deploy/schema/compose-spec.json', import.meta.url))).digest('hex'), '49eb9a1e1de41315949f302f8e6221bb42acd6038977f7c0974e38596ec4cdf6');
  assert.deepEqual(checkCompose(fixture()), []);
  for (const mutate of [c => { c.services.gateway.typo = true; }, c => { c.services.hermes.volumes = 4; }, c => { c.services.postgres.healthcheck.interval = false; }]) {
    const compose = fixture(); mutate(compose); assert.ok(checkCompose(compose).some(error => error.startsWith('schema')));
  }
  assert.throws(() => parseCompose('services: {}\nservices: {}'), /Invalid Compose YAML/);
});
test('public or implicit bindings and inline secrets cannot pass', () => {
  for (const port of ['8000:8000', '0.0.0.0:8000:8000', '[::]:8000:8000', '${BIND:-0.0.0.0}:8000:8000', { target: 8000, published: '8000' }]) {
    const compose = fixture(); compose.services.honcho.ports = [port]; assert.ok(checkCompose(compose).length);
  }
  for (const environment of [{ PASSWORD: 'fake-only-not-a-real-secret' }, ['API_KEY=fake-only-not-a-real-secret']]) {
    const compose = fixture(); compose.services.gateway.environment = environment; assert.ok(checkCompose(compose).length);
  }
  const compose = fixture(); compose.services.honcho.command = ['serve', 'postgresql://neo:fake@postgres/db'];
  assert.ok(checkCompose(compose).includes('literal credential forbidden'));
  assert.ok(checkTemplate('AUTH_JWT_SECRET=fake-only\n').length);
  assert.deepEqual(checkTemplate('AUTH_JWT_SECRET=\nPOSTGRES_PASSWORD_FILE=/run/secrets/postgres-password\n'), []);
});
test('Hermes preparation uses pinned untouched sources and frozen dependencies, with fake commands only', () => {
  const ref = JSON.parse(readFileSync(new URL('../../upstream.lock.json', import.meta.url), 'utf8')).pins['hermes-agent'].ref;
  const plan = hermesPlan(ref), calls = [], writes = [];
  prepare(plan, ref, { mkdir() {}, exists: () => false, write: (...args) => writes.push(args), run: (command, args) => { calls.push([command, args]); return command === 'git' && args.includes('describe') ? ref : ''; } });
  assert.equal(calls[0][0], 'git'); assert.ok(calls[0][1].includes(ref));
  assert.ok(calls.some(([command, args]) => command === 'uv' && args.includes('--frozen')));
  assert.equal(writes[0][1], `${plan.source}|web,sms,telegram\n`);
  assert.throws(() => prepare(plan, ref, { mkdir() {}, exists: () => true, write() {}, run: () => 'wrong-ref' }), /pinned ref/);
});
