#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const docsAppDir = resolve(__dirname, '..');
const distDir = join(docsAppDir, 'dist');

console.log('[docs:build] Step 1: Generating content from docs/*.md...');
execFileSync(process.execPath, [join(__dirname, 'generate.mjs')], {
  cwd: docsAppDir,
  stdio: 'inherit',
});

console.log('[docs:build] Step 2: Running vite build for static bundle...');
const viteBin = join(docsAppDir, 'node_modules', 'vite', 'bin', 'vite.js');
execFileSync(process.execPath, [viteBin, 'build'], {
  cwd: docsAppDir,
  stdio: 'inherit',
});

console.log('[docs:build] Step 3: Pre-rendering static HTML route entries...');
if (!existsSync(distDir)) {
  throw new Error('Build output directory not found: ' + distDir);
}

const baseHtml = readFileSync(join(distDir, 'index.html'), 'utf8');

// Import generated route list
const contentUrl = pathToFileURL(join(docsAppDir, 'src', 'content.ts')).href;
const contentModule = await import(contentUrl);
const items = contentModule.DOC_ITEMS || [];

let preRendered = 0;
for (const item of items) {
  const routeSlug = item.slug.replace(/^\//, '');
  if (!routeSlug) continue;
  const targetDir = join(distDir, routeSlug);
  mkdirSync(targetDir, { recursive: true });

  const pageHtml = baseHtml
    .replace(
      '<title>Neo Meta Harness Documentation</title>',
      `<title>${item.title} | Neo Meta Harness Docs</title>\n    <meta name="description" content="${item.description}" />`
    );

  writeFileSync(join(targetDir, 'index.html'), pageHtml, 'utf8');
  preRendered++;
}

console.log(`[docs:build] Generated static site successfully (${preRendered} static route entries pre-rendered).`);
