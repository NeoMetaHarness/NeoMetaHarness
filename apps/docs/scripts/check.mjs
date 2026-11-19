#!/usr/bin/env node
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const root = resolve(__dirname, '../../..');
const docsDir = join(root, 'docs');
const docsAppDir = resolve(__dirname, '..');

const failures = [];
const fail = (category, msg) => failures.push(`[${category}] ${msg}`);

function walk(dir, pred, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git' || name === 'dist') continue;
    const p = join(dir, name);
    try {
      if (statSync(p).isDirectory()) walk(p, pred, out);
      else if (pred(p)) out.push(p);
    } catch {}
  }
  return out;
}

console.log('Running docs:check (broken link checker and archive guard)...');

// 1. Guard against any archive/ content or directory
const allFiles = [
  ...walk(docsDir, () => true),
  ...walk(join(docsAppDir, 'src'), () => true),
];

for (const file of allFiles) {
  const relPath = relative(root, file).replace(/\\/g, '/');
  // Check if file path contains an archive folder
  if (/(^|\/)archive(\b|\/)/i.test(relPath)) {
    fail('archive-content', `Forbidden archive path detected: ${relPath}`);
  }
  // Check if markdown content is marked as archived
  if (file.endsWith('.md')) {
    const content = readFileSync(file, 'utf8');
    if (/^\s*status:\s*archived/im.test(content) || /^#+\s+Archive\b/im.test(content)) {
      fail('archive-content', `Document marked as archived: ${relPath}`);
    }
  }
}

// 2. Verify required sections in content.ts
if (!existsSync(join(docsAppDir, 'src', 'content.ts'))) {
  const { execFileSync } = await import('node:child_process');
  execFileSync(process.execPath, [join(docsAppDir, 'scripts', 'generate.mjs')], {
    cwd: docsAppDir,
    stdio: 'inherit',
  });
}
const contentUrl = pathToFileURL(join(docsAppDir, 'src', 'content.ts')).href;
const contentModule = await import(contentUrl);
const items = contentModule.DOC_ITEMS || [];
const sections = contentModule.DOC_SECTIONS || [];

const requiredSections = [
  'user-guide',
  'extension-sdk',
  'architecture',
  'security',
  'deploy',
];

for (const reqSec of requiredSections) {
  const found = sections.find((s) => s.id === reqSec);
  if (!found || found.items.length === 0) {
    fail('required-sections', `Missing or empty required section: ${reqSec}`);
  }
}

// Specifically verify docs/05 is present in extension-sdk
const sdkDoc = items.find((item) => item.section === 'extension-sdk' && item.sourceFile.includes('05-extension-system.md'));
if (!sdkDoc) {
  fail('extension-sdk', 'Missing docs/05-extension-system.md in extension-sdk section');
}

// Specifically verify docs/02 is present in architecture
const archDoc = items.find((item) => item.section === 'architecture' && item.sourceFile.includes('02-architecture.md'));
if (!archDoc) {
  fail('architecture', 'Missing docs/02-architecture.md in architecture section');
}

// 3. Link resolution checker across all docs
const registeredSlugs = new Set(items.map((i) => i.slug));
const registeredAnchorsByFile = new Map();
const registeredAnchorsBySlug = new Map();

for (const item of items) {
  const fileKey = relative(root, join(root, item.sourceFile)).replace(/\\/g, '/');
  const anchors = new Set(item.headings.map((h) => h.id));
  registeredAnchorsByFile.set(fileKey, anchors);
  registeredAnchorsBySlug.set(item.slug, anchors);
}

let checkedLinks = 0;
for (const item of items) {
  const absPath = join(root, item.sourceFile);
  const fileDir = dirname(absPath);
  const textWithoutCode = item.content.replace(/```[\s\S]*?```/g, '');
  const matches = [...textWithoutCode.matchAll(/\[([^\]]+)\]\(([^)\s]+)\)/g)];

  for (const match of matches) {
    const label = match[1];
    const target = match[2];

    // External links are allowed
    if (/^(https?:|mailto:)/i.test(target)) continue;

    checkedLinks++;

    // Check for archive link
    if (/(^|\/)archive(\b|\/)/i.test(target)) {
      fail('archive-link', `Forbidden link to archive: ${item.sourceFile} -> ${target}`);
      continue;
    }

    const [pathPart, hashPart] = target.split('#');

    // Case A: purely hash anchor on the same page
    if (!pathPart && hashPart) {
      const anchors = registeredAnchorsBySlug.get(item.slug);
      if (anchors && !anchors.has(hashPart)) {
        fail('broken-link', `Broken anchor in ${item.sourceFile}: #${hashPart}`);
      }
      continue;
    }

    // Case B: site route link (e.g. /user-guide, /extension-sdk)
    if (pathPart.startsWith('/')) {
      if (!registeredSlugs.has(pathPart)) {
        fail('broken-link', `Broken route link in ${item.sourceFile}: ${target} (route not found)`);
      } else if (hashPart) {
        const anchors = registeredAnchorsBySlug.get(pathPart);
        if (anchors && !anchors.has(hashPart)) {
          fail('broken-link', `Broken anchor in route link ${item.sourceFile}: ${target}`);
        }
      }
      continue;
    }

    // Case C: relative file path (e.g. 05-extension-system.md or ../02-architecture.md)
    const resolvedTarget = resolve(fileDir, decodeURIComponent(pathPart));
    if (!existsSync(resolvedTarget)) {
      fail('broken-link', `Broken file link in ${item.sourceFile}: ${target} -> ${relative(root, resolvedTarget)}`);
    } else if (hashPart && resolvedTarget.endsWith('.md')) {
      const relKey = relative(root, resolvedTarget).replace(/\\/g, '/');
      const anchors = registeredAnchorsByFile.get(relKey);
      if (anchors && !anchors.has(hashPart)) {
        const headingMatch = [...anchors].some((a) => a === hashPart || a.includes(hashPart) || hashPart.includes(a));
        if (!headingMatch) {
          fail('broken-link', `Broken anchor in file link ${item.sourceFile}: ${target}`);
        }
      }
    }
  }
}

if (failures.length > 0) {
  console.error(`\ndocs:check FAILED with ${failures.length} issue(s):\n` + failures.map((f) => '  ✗ ' + f).join('\n'));
  process.exit(1);
}

console.log(`docs:check PASSED: 0 archive violations, ${checkedLinks} internal links verified, all ${requiredSections.length} required sections present.`);
