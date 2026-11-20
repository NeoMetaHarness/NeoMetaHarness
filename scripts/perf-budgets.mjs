import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const defaultRoot = resolve(__dirname, '..');

function walkFiles(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    try {
      const stat = statSync(p);
      if (stat.isDirectory()) walkFiles(p, out);
      else if (stat.isFile()) out.push(p);
    } catch {}
  }
  return out;
}

function parseHtmlAssets(html) {
  const startupJs = new Set();
  const startupCss = new Set();
  for (const [tag] of html.matchAll(/<(?:script|link)\b[^>]*>/gi)) {
    const attrs = Object.fromEntries(
      [...tag.matchAll(/(\w+)=["']([^"']+)["']/g)].map(([, k, v]) => [k.toLowerCase(), v])
    );
    const isModuleScript = tag.startsWith('<script') && attrs.type === 'module' && attrs.src;
    const isModulePreload = tag.startsWith('<link') && attrs.rel === 'modulepreload' && attrs.href;
    const isStylesheet = tag.startsWith('<link') && attrs.rel === 'stylesheet' && attrs.href;

    if (isModuleScript) startupJs.add(attrs.src);
    if (isModulePreload) startupJs.add(attrs.href);
    if (isStylesheet) startupCss.add(attrs.href);
  }
  return {
    startupJs: [...startupJs].map((p) => decodeURIComponent(p.replace(/^\//, ''))),
    startupCss: [...startupCss].map((p) => decodeURIComponent(p.replace(/^\//, ''))),
  };
}

function ensureTargetBuilt(targetRel, targetDir, rootDir) {
  const indexHtml = join(targetDir, 'index.html');
  if (existsSync(indexHtml)) return;

  if (targetRel.includes('neo-app')) {
    const appDir = join(rootDir, 'apps/neo-app');
    const viteBin = join(appDir, 'node_modules', 'vite', 'bin', 'vite.js');
    if (existsSync(viteBin)) {
      execFileSync(process.execPath, [viteBin, 'build'], {
        cwd: appDir,
        stdio: 'ignore',
        windowsHide: true,
      });
    }
  } else if (targetRel.includes('docs')) {
    const docsDir = join(rootDir, 'apps/docs');
    const buildScript = join(docsDir, 'scripts', 'build.mjs');
    if (existsSync(buildScript)) {
      execFileSync(process.execPath, [buildScript], {
        cwd: docsDir,
        stdio: 'ignore',
        windowsHide: true,
      });
    }
  }
}

export function checkPerfBudgets(options = {}) {
  const root = resolve(options.root ?? defaultRoot);
  const configPath = options.budgetsPath ?? join(root, 'machine/perf-budgets.json');
  const autoBuild = options.autoBuild !== false;
  const targetOverrides = options.targetOverrides ?? {};

  let config = options.config;
  if (!config) {
    if (!existsSync(configPath)) {
      throw new Error(`Performance budgets configuration not found: ${configPath}`);
    }
    config = JSON.parse(readFileSync(configPath, 'utf8'));
  }

  const deterministic = config.budgets?.deterministic ?? [];
  const runtime = config.budgets?.runtime ?? [];
  const failures = [];
  const results = [];

  // 1. Validate runtime budgets schema
  for (const item of runtime) {
    if (!item.id || !item.name) {
      failures.push(`Runtime budget missing id or name: ${JSON.stringify(item)}`);
      continue;
    }
    if (!item.doc_source) {
      failures.push(`Runtime budget ${item.id} must cite its doc_source`);
    } else {
      const docPath = item.doc_source.split(':')[0];
      if (!existsSync(resolve(root, docPath))) {
        failures.push(`Runtime budget ${item.id} cites missing doc_source: ${item.doc_source}`);
      }
    }
    if (!item.measured_by) {
      failures.push(`Runtime budget ${item.id} must specify "measured_by"`);
    }
  }

  // 2. Measure and enforce deterministic budgets
  for (const budget of deterministic) {
    if (!budget.id || !budget.name || !budget.target || !budget.type || typeof budget.max_bytes !== 'number') {
      failures.push(`Deterministic budget specification invalid: ${JSON.stringify(budget)}`);
      continue;
    }
    if (!budget.doc_source) {
      failures.push(`Deterministic budget ${budget.id} must cite its doc_source`);
      continue;
    } else {
      const docPath = budget.doc_source.split(':')[0];
      if (!existsSync(resolve(root, docPath))) {
        failures.push(`Deterministic budget ${budget.id} cites missing doc_source: ${budget.doc_source}`);
      }
    }

    const targetDir = targetOverrides[budget.target] ?? resolve(root, budget.target);
    if (autoBuild && !existsSync(join(targetDir, 'index.html')) && !targetOverrides[budget.target]) {
      try {
        ensureTargetBuilt(budget.target, targetDir, root);
      } catch (err) {
        failures.push(`Failed to build target ${budget.target}: ${err.message}`);
        continue;
      }
    }

    if (!existsSync(targetDir)) {
      failures.push(`Target directory not found for budget ${budget.id}: ${targetDir}`);
      continue;
    }

    let actualBytes = 0;
    let details = {};

    if (budget.type === 'startup-js-gzip' || budget.type === 'startup-css-gzip') {
      const indexHtmlPath = join(targetDir, 'index.html');
      if (!existsSync(indexHtmlPath)) {
        failures.push(`Target index.html not found for budget ${budget.id}: ${indexHtmlPath}`);
        continue;
      }
      const htmlContent = readFileSync(indexHtmlPath, 'utf8');
      const parsed = parseHtmlAssets(htmlContent);
      const assetList = budget.type === 'startup-js-gzip' ? parsed.startupJs : parsed.startupCss;

      if (assetList.length === 0 && budget.type === 'startup-js-gzip') {
        failures.push(`No startup JS assets found in ${indexHtmlPath} for budget ${budget.id}`);
        continue;
      }

      const assetMeasurements = [];
      let totalGzip = 0;
      for (const asset of assetList) {
        const assetPath = join(targetDir, asset);
        if (!existsSync(assetPath)) {
          failures.push(`Startup asset referenced in index.html not found on disk: ${assetPath}`);
          continue;
        }
        const buf = readFileSync(assetPath);
        const gzLen = gzipSync(buf).length;
        totalGzip += gzLen;
        assetMeasurements.push({ asset, bytes: buf.length, gzip: gzLen });
      }
      actualBytes = totalGzip;
      details = { assets: assetMeasurements };
    } else if (budget.type === 'total-dist-gzip') {
      const files = walkFiles(targetDir).filter((p) => !p.endsWith('.map'));
      if (files.length === 0) {
        failures.push(`No distribution files found in ${targetDir} for budget ${budget.id}`);
        continue;
      }
      let totalGzip = 0;
      for (const file of files) {
        const buf = readFileSync(file);
        totalGzip += gzipSync(buf).length;
      }
      actualBytes = totalGzip;
      details = { fileCount: files.length };
    } else {
      failures.push(`Unknown budget type "${budget.type}" for budget ${budget.id}`);
      continue;
    }

    const passed = actualBytes <= budget.max_bytes;
    const resultItem = {
      id: budget.id,
      name: budget.name,
      type: budget.type,
      target: budget.target,
      actualBytes,
      maxBytes: budget.max_bytes,
      maxDisplay: budget.max_display,
      docSource: budget.doc_source,
      passed,
      details,
    };
    results.push(resultItem);

    if (!passed) {
      const overBy = actualBytes - budget.max_bytes;
      const actualKiB = (actualBytes / 1024).toFixed(1);
      const maxKiB = (budget.max_bytes / 1024).toFixed(1);
      failures.push(
        `${budget.name} (${budget.id}) exceeded limit: actual ${actualBytes} B (${actualKiB} KiB) > max ${budget.max_bytes} B (${budget.max_display || maxKiB + ' KiB'}) by ${overBy} B. Cites ${budget.doc_source}`
      );
    }
  }

  return {
    ok: failures.length === 0,
    passed: failures.length === 0,
    results,
    failures,
    runtimeBudgets: runtime,
  };
}

// Standalone execution
if (process.argv[1] && resolve(process.argv[1]) === resolve(__filename)) {
  console.log('Checking performance and bundle size budgets...');
  const outcome = checkPerfBudgets();
  for (const r of outcome.results) {
    const status = r.passed ? '✓ PASS' : '✗ FAIL';
    const actualStr = `${r.actualBytes} B (${(r.actualBytes / 1024).toFixed(1)} KiB)`;
    console.log(`  ${status} [${r.id}] ${r.name}: ${actualStr} <= ${r.maxDisplay} (doc: ${r.docSource})`);
  }
  if (!outcome.ok) {
    console.error(`\nPerformance budget check FAILED with ${outcome.failures.length} violation(s):`);
    for (const f of outcome.failures) {
      console.error(`  • ${f}`);
    }
    process.exit(1);
  }
  console.log(`\nAll ${outcome.results.length} deterministic performance budgets passed!`);
  console.log(`(${outcome.runtimeBudgets.length} runtime budgets tracked via exit tests)`);
}
