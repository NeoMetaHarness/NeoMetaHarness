import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPerfBudgets } from '../perf-budgets.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = join(__filename, '..');
const repoRoot = resolve(__dirname, '../..');

test('baseline: repository built bundles satisfy all deterministic budgets', () => {
  const outcome = checkPerfBudgets({ root: repoRoot });
  assert.equal(outcome.ok, true, `Baseline budgets should pass:\n${outcome.failures.join('\n')}`);
  assert.equal(outcome.failures.length, 0);
  assert.ok(outcome.results.length >= 5, 'Must check at least 5 deterministic budgets');
  assert.ok(outcome.runtimeBudgets.length >= 7, 'Must track at least 7 runtime budgets');

  for (const r of outcome.results) {
    assert.equal(r.passed, true, `Budget ${r.id} should pass in baseline`);
    assert.ok(r.actualBytes <= r.maxBytes, `${r.id} actual (${r.actualBytes}) <= max (${r.maxBytes})`);
    assert.ok(r.docSource, `${r.id} must cite docSource`);
  }
});

test('failure path: fake oversized startup JS bundle in neo-app triggers clear failure', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'neo-fake-oversized-app-'));
  try {
    mkdirSync(join(tempDir, 'assets'), { recursive: true });
    // Generate an uncompressible 360 KiB file (random bytes resist gzip compression)
    const largePayload = randomBytes(360 * 1024);
    writeFileSync(join(tempDir, 'assets/large-entry.js'), largePayload);

    // Write index.html pointing to the oversized startup entry
    const fakeHtml = `<!doctype html>
<html>
<head>
  <script type="module" src="/assets/large-entry.js"></script>
</head>
<body><div id="root"></div></body>
</html>`;
    writeFileSync(join(tempDir, 'index.html'), fakeHtml, 'utf8');

    const outcome = checkPerfBudgets({
      root: repoRoot,
      targetOverrides: {
        'apps/neo-app/dist': tempDir,
      },
      autoBuild: false,
    });

    assert.equal(outcome.ok, false, 'Check should fail when bundle exceeds budget');
    assert.ok(outcome.failures.length > 0, 'Must record failure messages');

    const startupJsFailure = outcome.failures.find(
      (msg) => msg.includes('neo-app-startup-js') && msg.includes('exceeded limit')
    );
    assert.ok(startupJsFailure, `Failure message must identify startup JS budget: ${outcome.failures.join(' | ')}`);
    assert.ok(
      startupJsFailure.includes('docs/adr/0001-desktop-shell.md'),
      'Failure message must cite doc source'
    );
    assert.ok(startupJsFailure.includes('actual') && startupJsFailure.includes('max'), 'Must cite actual and max bytes');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('failure path: fake oversized docs site total distribution triggers clear failure', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'neo-fake-oversized-docs-'));
  try {
    mkdirSync(join(tempDir, 'assets'), { recursive: true });
    // Write 960 KiB random data across files (budget is 800 KiB)
    writeFileSync(join(tempDir, 'assets/huge-doc-1.js'), randomBytes(480 * 1024));
    writeFileSync(join(tempDir, 'assets/huge-doc-2.js'), randomBytes(480 * 1024));
    writeFileSync(
      join(tempDir, 'index.html'),
      '<!doctype html><html><script type="module" src="/assets/huge-doc-1.js"></script></html>',
      'utf8'
    );

    const outcome = checkPerfBudgets({
      root: repoRoot,
      targetOverrides: {
        'apps/docs/dist': tempDir,
      },
      autoBuild: false,
    });

    assert.equal(outcome.ok, false, 'Check should fail when docs site exceeds budget');
    const docsTotalFailure = outcome.failures.find(
      (msg) => msg.includes('docs-site-total-dist-gzip') && msg.includes('exceeded limit')
    );
    assert.ok(docsTotalFailure, `Failure message must identify docs total dist budget: ${outcome.failures.join(' | ')}`);
    assert.ok(docsTotalFailure.includes('docs/04-roadmap.md:77'), 'Must cite docs roadmap source');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('runtime budgets: verified metadata and excluded from deterministic execution', () => {
  const config = JSON.parse(readFileSync(join(repoRoot, 'machine/perf-budgets.json'), 'utf8'));
  const runtime = config.budgets.runtime;
  assert.ok(Array.isArray(runtime) && runtime.length >= 5, 'Must have runtime budgets defined');

  for (const item of runtime) {
    assert.ok(item.id, 'Runtime budget must have id');
    assert.ok(item.name, 'Runtime budget must have name');
    assert.ok(item.doc_source, `Runtime budget ${item.id} must have doc_source`);
    assert.ok(item.measured_by, `Runtime budget ${item.id} must declare measured_by`);
  }

  // Ensure checkPerfBudgets only measures deterministic items in results
  const outcome = checkPerfBudgets({ root: repoRoot });
  for (const item of runtime) {
    assert.ok(
      !outcome.results.some((r) => r.id === item.id),
      `Runtime budget ${item.id} must not be executed in check results`
    );
  }
});

test('schema validation: rejects budgets citing nonexistent doc files', () => {
  const badConfig = {
    schema_version: 1,
    budgets: {
      deterministic: [],
      runtime: [
        {
          id: 'invalid-budget',
          name: 'Invalid Budget',
          doc_source: 'docs/non-existent-file-xyz.md:10',
          measured_by: 'test:none',
        },
      ],
    },
  };
  const outcome = checkPerfBudgets({ root: repoRoot, config: badConfig });
  assert.equal(outcome.ok, false);
  assert.ok(outcome.failures.some((f) => f.includes('missing doc_source')));
});
