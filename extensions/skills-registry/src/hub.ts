import { createHash } from 'node:crypto';

export type HubPreview = { name: string; identifier: string; skill_md: string; files: string[] };
export type UpstreamScan = { policy: string; findings?: { file?: string; line?: number; category?: string; description?: string }[] };
export type HubFinding = { file: string; line: number; category: string; description: string };
export type HubReport = {
  id: string; profile: string; identifier: string; name: string; blocked: boolean;
  scannedAt: number;
  approved?: boolean; approvedBy?: string; approvedReason?: string;
  files: string[]; findings: HubFinding[];
};

const patterns: { category: string; pattern: RegExp; description: string }[] = [
  { category: 'network', pattern: /\b(?:curl|wget|Invoke-WebRequest|Invoke-RestMethod|fetch\s*\(|axios\.|requests\.|urllib\.|https?:\/\/)/i,
    description: 'Network access or remote download pattern' },
  { category: 'shell-exec', pattern: /(?:\b(?:bash|sh|powershell|pwsh|cmd\.exe)\s+-[ce]|\b(?:os\.system|subprocess\.|child_process|exec\s*\(|spawn\s*\(|Popen\s*\(|eval\s*\()|\|\s*(?:ba)?sh\b)/i,
    description: 'Shell or code execution pattern' },
  { category: 'credential-read', pattern: /(?:~[\\/]\.ssh|\.ssh[\\/]|\.aws[\\/]credentials|\.env\b|\b(?:process\.env|os\.environ|API_KEY|SECRET_KEY|credentials\.json|\/etc\/shadow)\b)/i,
    description: 'Credential or private configuration access pattern' },
];

/** Read-only scan of the exact preview and upstream's quarantined full-bundle scan. */
export function inspectHub(profile: string, identifier: string, preview: HubPreview, upstream: UpstreamScan): HubReport {
  const findings: HubFinding[] = [];
  const files = Array.isArray(preview.files) ? preview.files : [];
  const name = String(preview.name ?? '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 79);
  if (!/^[a-z][a-z0-9_-]{0,79}$/.test(name)) throw new Error('Invalid Hub skill name');
  if (preview.identifier !== identifier) findings.push({ file: 'manifest', line: 0, category: 'identity', description: 'Hub identifier changed' });
  if (!files.includes('SKILL.md') || files.length > 100) {
    findings.push({ file: 'manifest', line: 0, category: 'manifest', description: 'Missing SKILL.md or oversized file manifest' });
  }
  for (const file of files) {
    if (typeof file !== 'string' || !file || file.startsWith('/') || file.includes('\\')
      || file.split('/').some((part) => part === '..' || part === '.' || !part)
      || /^[a-zA-Z]:/.test(file) || file.includes('\0')) {
      findings.push({ file: String(file), line: 0, category: 'path-escape', description: 'File outside skill directory or invalid path' });
    } else if (file !== 'SKILL.md') {
      findings.push({ file, line: 0, category: 'unavailable-file',
        description: 'Hub preview omits this file content; registry cannot safely import its assets' });
    }
  }
  if (typeof preview.skill_md !== 'string' || !preview.skill_md || preview.skill_md.length > 200_000) {
    findings.push({ file: 'SKILL.md', line: 0, category: 'manifest', description: 'Missing or oversized skill contents' });
  } else {
    for (const [index, line] of preview.skill_md.split(/\r?\n/).entries()) {
      for (const rule of patterns) {
        if (rule.pattern.test(line)) findings.push({ file: 'SKILL.md', line: index + 1,
          category: rule.category, description: rule.description });
      }
    }
  }
  if (upstream?.policy !== 'allow') findings.push({ file: 'bundle', line: 0, category: 'upstream',
    description: `Hermes quarantine scan policy ${String(upstream?.policy ?? 'unavailable')}` });
  for (const finding of upstream?.findings ?? []) {
    findings.push({ file: String(finding.file ?? 'bundle'), line: Number(finding.line) || 0,
      category: String(finding.category ?? 'upstream'), description: String(finding.description ?? 'Hermes scan finding') });
  }
  const id = createHash('sha256').update(JSON.stringify({ profile, identifier, preview, upstream })).digest('hex');
  return { id, profile, identifier, name, blocked: findings.length > 0,
    scannedAt: Date.now(), files, findings };
}
