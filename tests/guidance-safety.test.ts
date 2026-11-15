import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { initializeKithRepository } from '../src/cli/init.js';

// `kith init` writes agent guidance into a block inside AGENTS.md. People edit that block (an owner directive, a
// repository rule). A refresh must never silently overwrite their words.

let root: string;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kith-guidance-')));
  execFileSync('git', ['init', '-b', 'main'], { cwd: root, stdio: 'ignore' });
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });
const agents = () => fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
const write = (text: string) => fs.writeFileSync(path.join(root, 'AGENTS.md'), text);
const init = (options: { refreshGuidance?: boolean } = {}) => initializeKithRepository(root, 'kith', { integrations: ['agents'], mcpOnly: true, ...options });
const skill = () => fs.readFileSync(path.join(root, '.agent/skills/kith/SKILL.md'), 'utf8');
const digest = (text: string) => crypto.createHash('sha256').update(text).digest('hex').slice(0, 12);

it('stamps generated guidance with a digest and is idempotent', () => {
  init();
  expect(agents()).toMatch(/<!-- KITH:START -->\n<!-- kith-guidance sha=[0-9a-f]{12} -->\n## Parallel Agent Coordination/);
  expect(agents()).toContain('kith_write_handoff');
  const first = agents();
  const again = init();
  expect(again.configuredFiles).toEqual([]);
  expect(agents()).toBe(first);
});

it('upgrades a block Kith wrote and left unedited, keeping everything around it', () => {
  const oldBody = '## Parallel Agent Coordination (kith)\n\nOld guidance from an earlier version.';
  write(`# Project rules\n\nKeep tests fast.\n\n<!-- KITH:START -->\n<!-- kith-guidance sha=${digest(oldBody)} -->\n${oldBody}\n<!-- KITH:END -->\n\nMore rules after.\n`);
  const report = init();
  expect(report.warnings.join()).not.toContain('left unchanged');
  expect(agents()).not.toContain('Old guidance from an earlier version');
  expect(agents()).toContain('kith_write_handoff');
  expect(agents().startsWith('# Project rules\n\nKeep tests fast.\n\n')).toBe(true);
  expect(agents().endsWith('\n\nMore rules after.\n')).toBe(true);
});

it('never overwrites a block that was edited after Kith wrote it', () => {
  init();
  const directive = 'The owner has directed this build to use the main checkout only. Do not create worktrees.';
  write(agents().replace('## Parallel Agent Coordination (kith)', `## Parallel Agent Coordination (kith)\n\n${directive}`));
  const edited = agents();
  const report = init();
  expect(agents()).toBe(edited);
  expect(agents()).toContain(directive);
  expect(report.warnings.join()).toContain('left unchanged');
  expect(report.warnings.join()).toContain('--refresh-guidance');
  expect(report.configuredFiles).not.toContain('AGENTS.md');
});

it('treats a block from before the marker existed as edited, and replaces it only on request', () => {
  const legacy = '<!-- KITH:START -->\n## Parallel Agent Coordination (kith)\n\nInstruction protocol: 1.1.0.\n\nUse Kith. Do not create worktrees for this build.\n<!-- KITH:END -->';
  write(`# Rules\n\n${legacy}\n\nTail.\n`);
  const report = init();
  expect(agents()).toContain('Do not create worktrees for this build.');
  expect(report.warnings.join()).toContain('left unchanged');
  const refreshed = init({ refreshGuidance: true });
  expect(refreshed.warnings.join()).not.toContain('left unchanged');
  expect(agents()).not.toContain('Do not create worktrees for this build.');
  expect(agents()).toContain('kith_write_handoff');
  expect(agents().startsWith('# Rules\n\n')).toBe(true);
  expect(agents().endsWith('\n\nTail.\n')).toBe(true);
});

it('protects an edited skill file the same way', () => {
  init();
  fs.writeFileSync(path.join(root, '.agent/skills/kith/SKILL.md'), skill() + '\nProject note: always ask before integrating.\n');
  const edited = skill();
  const report = init();
  expect(skill()).toBe(edited);
  expect(report.warnings.join()).toContain('.agent/skills/kith/SKILL.md');
  init({ refreshGuidance: true });
  expect(skill()).not.toContain('Project note: always ask');
  expect(skill()).toContain('kith_write_handoff');
});

it('still refuses an unfinished block rather than guessing', () => {
  write('<!-- KITH:START --> unfinished');
  expect(() => init()).toThrow('incomplete Kith block');
});
