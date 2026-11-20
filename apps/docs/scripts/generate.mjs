#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const root = resolve(__dirname, '../../..');
const docsDir = join(root, 'docs');
const outPath = resolve(__dirname, '../src/content.ts');

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

function extractHeadings(markdown) {
  const headings = [];
  const lines = markdown.split('\n');
  let inCode = false;
  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      inCode = !inCode;
      continue;
    }
    if (inCode) continue;
    const match = line.match(/^(#{1,6})\s+(.+)$/);
    if (match) {
      const level = match[1].length;
      const rawText = match[2].trim();
      const id = slugify(rawText);
      headings.push({ level, text: rawText, id });
    }
  }
  return headings;
}

const docDefinitions = [
  // 1. User Guide
  {
    id: 'user-guide-overview',
    section: 'user-guide',
    sectionTitle: 'User Guide',
    title: 'Getting Started & Overview',
    slug: '/user-guide',
    sourceFile: 'docs/01-project-map.md',
    description: 'Overview of Neo Meta Harness architecture, workspaces, engines, and CLI workflows.',
  },
  {
    id: 'user-guide-onboarding',
    section: 'user-guide',
    sectionTitle: 'User Guide',
    title: 'First-Time Onboarding',
    slug: '/user-guide/onboarding',
    sourceFile: 'docs/onboarding.md',
    description: '15-minute onboarding wizard, workspace setup, model selection, and first bot interaction.',
  },
  {
    id: 'user-guide-computers',
    section: 'user-guide',
    sectionTitle: 'User Guide',
    title: 'Computers & Safety Policy',
    slug: '/user-guide/computers',
    sourceFile: 'docs/computers-and-safety.md',
    description: 'Local desktop provider (computer-local), Hermes screen viewer, P3-7 safety policy, and kill switch.',
  },
  {
    id: 'user-guide-autonomy',
    section: 'user-guide',
    sectionTitle: 'User Guide',
    title: 'Autonomous Operations & Inbox',
    slug: '/user-guide/autonomy',
    sourceFile: 'docs/autonomous-operations.md',
    description: 'Accept modes (observe, act-with-approval, act), Suggestions lane, neo upstream self-maintenance routine, and WhatsApp notifications.',
  },
  {
    id: 'user-guide-prd',
    section: 'user-guide',
    sectionTitle: 'User Guide',
    title: 'Product Vision & Workflows',
    slug: '/user-guide/workflows',
    sourceFile: 'docs/03-PRD.md',
    description: 'Autonomous multi-agent meta-harness workflows, Astryx desktop experience, and goals.',
  },
  {
    id: 'user-guide-roadmap',
    section: 'user-guide',
    sectionTitle: 'User Guide',
    title: 'Roadmap & Capability Phases',
    slug: '/user-guide/roadmap',
    sourceFile: 'docs/04-roadmap.md',
    description: 'Detailed phases from Foundation (P1) to Autonomy (P7).',
  },
  {
    id: 'user-guide-backup',
    section: 'user-guide',
    sectionTitle: 'User Guide',
    title: 'Backup & Restore Guide',
    slug: '/user-guide/backup-restore',
    sourceFile: 'docs/17-backup-restore.md',
    description: 'Operator guide for encrypted backups, emergency recovery, and integrity validation.',
  },

  // 2. Extension SDK (docs/05)
  {
    id: 'extension-sdk',
    section: 'extension-sdk',
    sectionTitle: 'Extension SDK',
    title: 'Extension System Specification (docs/05)',
    slug: '/extension-sdk',
    sourceFile: 'docs/05-extension-system.md',
    description: 'Everything is an extension: manifest specification, runtimes, services, settings, and lifecycle.',
  },

  // 3. Architecture
  {
    id: 'architecture-system',
    section: 'architecture',
    sectionTitle: 'Architecture',
    title: 'System Architecture (docs/02)',
    slug: '/architecture',
    sourceFile: 'docs/02-architecture.md',
    description: 'Detailed system architecture: Astryx UI, oRPC Gateway, NeoKernel, and engine seams.',
  },
  {
    id: 'adr-0001',
    section: 'architecture',
    sectionTitle: 'Architecture',
    title: 'ADR 0001: Desktop Shell',
    slug: '/architecture/adr-0001',
    sourceFile: 'docs/adr/0001-desktop-shell.md',
    description: 'Astryx webview shell and local gateway integration.',
  },
  {
    id: 'adr-0002',
    section: 'architecture',
    sectionTitle: 'Architecture',
    title: 'ADR 0002: API Style',
    slug: '/architecture/adr-0002',
    sourceFile: 'docs/adr/0002-api-style.md',
    description: 'End-to-end typed contract-first oRPC over HTTP and WebSockets.',
  },
  {
    id: 'adr-0003',
    section: 'architecture',
    sectionTitle: 'Architecture',
    title: 'ADR 0003: DB Layer',
    slug: '/architecture/adr-0003',
    sourceFile: 'docs/adr/0003-db-layer.md',
    description: 'Local SQLite persistence with unified database provider.',
  },
  {
    id: 'adr-0004',
    section: 'architecture',
    sectionTitle: 'Architecture',
    title: 'ADR 0004: Kernel',
    slug: '/architecture/adr-0004',
    sourceFile: 'docs/adr/0004-kernel.md',
    description: 'NeoKernel dynamic plugin resolution, dependency ordering, and isolation.',
  },
  {
    id: 'adr-0005',
    section: 'architecture',
    sectionTitle: 'Architecture',
    title: 'ADR 0005: Authentication',
    slug: '/architecture/adr-0005',
    sourceFile: 'docs/adr/0005-auth.md',
    description: 'Authentication architecture, session management, scoped API keys, and RBAC.',
  },

  // 4. Security
  {
    id: 'security-review',
    section: 'security',
    sectionTitle: 'Security',
    title: 'Security Review & Hardening',
    slug: '/security',
    sourceFile: 'docs/security/review-2026-11.md',
    description: 'Full security review: Host/Origin enforcement, token auth, vault encryption, and RBAC.',
  },
  {
    id: 'security-threat-model',
    section: 'security',
    sectionTitle: 'Security',
    title: 'Threat Model & Security Boundaries',
    slug: '/security/threat-model',
    sourceFile: 'docs/security/threat-model.md',
    description: 'Threat actors, trust boundaries, network boundaries, and defense in depth.',
  },
  {
    id: 'security-guardrails',
    section: 'security',
    sectionTitle: 'Security',
    title: 'GitHub Safety Guardrails',
    slug: '/security/guardrails',
    sourceFile: 'docs/policies/GITHUB-SAFETY-GUARDRAILS.md',
    description: 'Zero external CI/CD workflows, zero unreviewed GitHub writes, local-only test execution.',
  },

  // 5. Deploy
  {
    id: 'deploy-installers',
    section: 'deploy',
    sectionTitle: 'Deploy',
    title: 'Installers & Packaging',
    slug: '/deploy/installers',
    sourceFile: 'docs/install.md',
    description: 'Tauri 2 desktop installers, Node gateway sidecar, desktop PWA, and Docker Compose.',
  },
  {
    id: 'deploy-desktop-shell',
    section: 'deploy',
    sectionTitle: 'Deploy',
    title: 'Desktop Shell Configuration',
    slug: '/deploy/desktop-shell',
    sourceFile: 'docs/desktop-shell.md',
    description: 'Tauri 2 launcher shortcuts, tray controls, neo:// deep links, and updater configuration.',
  },
  {
    id: 'deploy-compose',
    section: 'deploy',
    sectionTitle: 'Deploy',
    title: 'Docker Compose Deployment',
    slug: '/deploy',
    sourceFile: 'docs/deploy/docker-compose.md',
    description: 'Self-hosted production container orchestration, volume mounts, and environment configuration.',
  },
];

console.log('Generating documentation site content from docs/*.md...');

const items = [];
const sectionsMap = new Map();

for (const def of docDefinitions) {
  const fullPath = join(root, def.sourceFile);
  if (!existsSync(fullPath)) {
    throw new Error(`Source document not found: ${def.sourceFile}`);
  }
  const rawContent = readFileSync(fullPath, 'utf8');
  const headings = extractHeadings(rawContent);

  const item = {
    id: def.id,
    section: def.section,
    sectionTitle: def.sectionTitle,
    title: def.title,
    slug: def.slug,
    sourceFile: def.sourceFile,
    description: def.description,
    headings,
    content: rawContent,
  };
  items.push(item);

  if (!sectionsMap.has(def.section)) {
    sectionsMap.set(def.section, {
      id: def.section,
      title: def.sectionTitle,
      items: [],
    });
  }
  sectionsMap.get(def.section).items.push({
    id: def.id,
    title: def.title,
    slug: def.slug,
    description: def.description,
  });
}

const sections = Array.from(sectionsMap.values());

const tsOutput = `// Auto-generated by apps/docs/scripts/generate.mjs - do not edit directly
export interface HeadingItem {
  level: number;
  text: string;
  id: string;
}

export interface DocItem {
  id: string;
  section: string;
  sectionTitle: string;
  title: string;
  slug: string;
  sourceFile: string;
  description: string;
  headings: HeadingItem[];
  content: string;
}

export interface SectionItemRef {
  id: string;
  title: string;
  slug: string;
  description: string;
}

export interface DocSection {
  id: string;
  title: string;
  items: SectionItemRef[];
}

export const DOC_ITEMS: DocItem[] = ${JSON.stringify(items, null, 2)};

export const DOC_SECTIONS: DocSection[] = ${JSON.stringify(sections, null, 2)};

export const DOC_BY_SLUG: Record<string, DocItem> = Object.fromEntries(
  DOC_ITEMS.map((item) => [item.slug, item])
);
`;

writeFileSync(outPath, tsOutput, 'utf8');
console.log(`Successfully generated ${items.length} doc items into ${outPath}`);
