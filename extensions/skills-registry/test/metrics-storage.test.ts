import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SkillRegistry } from '../src/registry.js';

test('skill listing ignores stray files among owner directories', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nmh-registry-metrics-'));
  try {
    const skills = join(root, 'repo', 'skills');
    const skill = join(skills, 'owner', 'skill');
    await mkdir(skill, { recursive: true });
    await writeFile(join(skills, 'README'), 'Readme');
    await writeFile(join(skills, 'readme'), 'File name that matches owner validation');
    await writeFile(join(skill, 'metadata.json'), JSON.stringify({ name: 'owner/skill', version: 2 }));
    const registry = new SkillRegistry(root);
    await registry.start();
    const records = await registry.list();
    assert.deepEqual(records.map((item) => item.name), ['owner/skill']);
    console.log('P7-12_SKILL_LIST PASS ignores stray owner files');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
