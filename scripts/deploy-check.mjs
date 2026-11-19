import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';
import Ajv2020 from 'ajv/dist/2020.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const schema = JSON.parse(readFileSync(resolve(root, 'deploy/schema/compose-spec.json'), 'utf8'));
const validate = new Ajv2020({ allErrors: true, strict: false, validateFormats: false }).compile(schema);
const sensitive = /(?:password|token|api[_-]?key|secret|connection[_-]?uri)/i;
const literalCredential = /:\/\/[^/@\s:]+:[^/@\s]+@|(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]{12,}|(?:PASSWORD|TOKEN|API[_-]?KEY|SECRET)\s*[=:]\s*\S+/i;
export function parseCompose(text) {
  const doc = parseDocument(text, { uniqueKeys: true });
  if (doc.errors.length) throw new Error('Invalid Compose YAML');
  return doc.toJS({ maxAliasCount: 100 });
}
export function checkCompose(compose) {
  const errors = [];
  if (!validate(compose)) errors.push(...validate.errors.map(e => `schema ${e.instancePath || '/'}: ${e.keyword}`));
  const services = compose?.services ?? {};
  for (const [name, service] of Object.entries(services)) {
    if (!service || typeof service !== 'object') continue;
    if ('environment' in service) errors.push(`${name}: use env_file, not inline environment`);
    if (!service.env_file) errors.push(`${name}: env_file required`);
    if (service.network_mode === 'host' && name !== 'gateway') errors.push(`${name}: host networking forbidden`);
    for (const port of service.ports ?? []) {
      const safe = typeof port === 'string' ? /^(127\.0\.0\.1|\[::1\]):\d+:\d+(?:\/(tcp|udp))?$/.test(port) :
        port && ['127.0.0.1', '::1'].includes(port.host_ip);
      if (!safe) errors.push(`${name}: ports must bind explicitly to loopback`);
    }
  }
  if (!services.gateway || !services.hermes) errors.push('gateway and Hermes services required');
  if (services.gateway?.network_mode !== 'host') errors.push('gateway: existing loopback listener requires Linux host networking');
  if (JSON.stringify(services.gateway?.command) !== JSON.stringify(['pnpm', '--config.verifyDepsBeforeRun=false', '--dir', 'apps/gateway', 'start'])) errors.push('gateway: expected the existing loopback Gateway entrypoint');
  if (services.gateway?.ports) errors.push('gateway: host networking must not publish ports');
  for (const name of ['honcho', 'honcho-deriver', 'postgres']) {
    if (!services[name]?.profiles?.includes('memory')) errors.push(`${name}: optional memory profile required`);
  }
  function walk(value, key = '') {
    if (typeof value === 'string') {
      if (value.includes('0.0.0.0') || value.includes('[::]:')) errors.push('wildcard binding forbidden');
      if (literalCredential.test(value) || /^--(?:password|token|api-key|secret)(?:=|$)/i.test(value)) errors.push('literal credential forbidden');
      if (sensitive.test(key) && key !== 'secrets' && !/(_FILE|file|path)$/i.test(key) && value) errors.push('credentials must come from files');
    } else if (Array.isArray(value)) value.forEach(item => walk(item, key));
    else if (value && typeof value === 'object') for (const [child, item] of Object.entries(value)) walk(item, child);
  }
  walk(compose);
  return [...new Set(errors)];
}
export function checkTemplate(text) {
  const errors = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const equal = line.indexOf('='), key = line.slice(0, equal), value = line.slice(equal + 1).trim();
    if (equal < 1 || literalCredential.test(value) || (sensitive.test(key) && !key.endsWith('_FILE') && value)) errors.push('env template contains invalid assignment or literal credential');
    if (value.includes('0.0.0.0') || value.includes('[::]')) errors.push('env template contains wildcard binding');
  }
  return errors;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const errors = checkCompose(parseCompose(readFileSync(resolve(root, 'deploy/docker-compose.yml'), 'utf8')));
    for (const name of ['gateway', 'hermes', 'honcho', 'postgres', 'compose']) errors.push(...checkTemplate(readFileSync(resolve(root, `deploy/config/${name}.env.example`), 'utf8')));
    if (errors.length) throw new Error([...new Set(errors)].join('; '));
    console.log('DEPLOY_CHECK PASS offline-compose-schema=true env-files=true no-literal-secrets=true loopback-only=true optional-memory=true');
  } catch (error) { console.error(`DEPLOY_CHECK FAIL ${error.message}`); process.exitCode = 1; }
}
