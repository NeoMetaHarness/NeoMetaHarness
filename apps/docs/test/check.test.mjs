import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const docsAppDir = resolve(__dirname, '..');
const checkScript = join(docsAppDir, 'scripts', 'check.mjs');

console.log('Running test:docs:check unit tests...');
if (!existsSync(join(docsAppDir, 'src', 'content.ts'))) {
  spawnSync(process.execPath, [join(docsAppDir, 'scripts', 'generate.mjs')], { cwd: docsAppDir });
}

// Test 1: baseline passes
{
  const res = spawnSync(process.execPath, [checkScript], {
    cwd: docsAppDir,
    encoding: 'utf8',
  });
  assert.equal(res.status, 0, 'Baseline docs:check should pass:\n' + res.stderr + '\n' + res.stdout);
  assert.ok(res.stdout.includes('docs:check PASSED'), 'Output should indicate pass');
  console.log('✓ Baseline check passes');
}

// Test 2: fails on archive/ content
{
  const archiveDir = join(docsAppDir, 'src', 'archive');
  mkdirSync(archiveDir, { recursive: true });
  const dummyFile = join(archiveDir, 'deprecated.md');
  writeFileSync(dummyFile, '# Deprecated\nThis is old doc.', 'utf8');

  try {
    const res = spawnSync(process.execPath, [checkScript], {
      cwd: docsAppDir,
      encoding: 'utf8',
    });
    assert.equal(res.status, 1, 'docs:check should fail when archive/ path exists');
    assert.ok(
      res.stderr.includes('Forbidden archive path detected') || res.stdout.includes('Forbidden archive path detected'),
      'Error message should mention forbidden archive path'
    );
    console.log('✓ Rejection of archive/ path verified');
  } finally {
    rmSync(archiveDir, { recursive: true, force: true });
  }
}

// Test 3: fails on document with archive status
{
  const testDoc = join(docsAppDir, 'src', 'archived-doc.md');
  writeFileSync(testDoc, '---\nstatus: archived\n---\n# Old Doc\n', 'utf8');

  try {
    const res = spawnSync(process.execPath, [checkScript], {
      cwd: docsAppDir,
      encoding: 'utf8',
    });
    assert.equal(res.status, 1, 'docs:check should fail when document is marked archived');
    assert.ok(
      res.stderr.includes('Document marked as archived') || res.stdout.includes('Document marked as archived'),
      'Error message should mention document marked as archived'
    );
    console.log('✓ Rejection of archived document verified');
  } finally {
    rmSync(testDoc, { force: true });
  }
}

// Test 4: fails on broken internal link in a doc item
{
  const contentFile = join(docsAppDir, 'src', 'content.ts');
  const contentUrl = pathToFileURL(contentFile).href;
  const originalModule = await import(contentUrl);
  const originalContent = originalModule.DOC_ITEMS;
  
  // Temporarily modify content.ts with a broken link
  const mutated = JSON.parse(JSON.stringify(originalContent));
  mutated[0].content += '\n\n[Broken Target](./non-existent-file-xyz.md)\n';
  
  const tempContentTs = `export const DOC_ITEMS = ${JSON.stringify(mutated, null, 2)};
export const DOC_SECTIONS = ${JSON.stringify(originalModule.DOC_SECTIONS, null, 2)};
export const DOC_BY_SLUG = Object.fromEntries(DOC_ITEMS.map(i => [i.slug, i]));
`;
  writeFileSync(contentFile, tempContentTs, 'utf8');

  try {
    const res = spawnSync(process.execPath, [checkScript], {
      cwd: docsAppDir,
      encoding: 'utf8',
    });
    assert.equal(res.status, 1, 'docs:check should fail when a broken internal link is present');
    assert.ok(
      res.stderr.includes('Broken file link') || res.stdout.includes('Broken file link'),
      'Error message should mention broken file link'
    );
    console.log('✓ Rejection of broken internal link verified');
  } finally {
    // Regenerate content.ts back to clean state
    spawnSync(process.execPath, [join(docsAppDir, 'scripts', 'generate.mjs')], { cwd: docsAppDir });
  }
}

console.log('All docs:check tests passed successfully!');
