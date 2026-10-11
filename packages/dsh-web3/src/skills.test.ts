import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MANAGED_MARKER,
  SKILL_NAME,
  bundledSkillPath,
  createSkillProvider,
  parseSkillFile,
  provideBundledSkill,
  removeLegacySkillMirror,
  syncBundledSkill,
  userSkillPath,
} from '../src/skills.js';

const quiet = { info() {}, warn() {}, debug() {}, error() {} };
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-web3-skills-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function exists(path: string): Promise<boolean> {
  return await stat(path).then(
    () => true,
    () => false,
  );
}

describe('bundled SKILL.md', () => {
  it('has a catalog description that fits DSH\'s 500-character catalog line', async () => {
    const parsed = parseSkillFile(await readFile(bundledSkillPath(), 'utf8'));
    expect(parsed.name).toBe(SKILL_NAME);
    expect(parsed.description.length).toBeLessThanOrEqual(500);
    for (const trigger of ['钱包', '转账', 'x402', 'wallet_', 'USDC']) expect(parsed.description).toContain(trigger);
    expect(parsed.body.startsWith('---')).toBe(false);
  });
});

describe('skill provider (ctx.skills)', () => {
  it('lists one bundled candidate and loads the body without frontmatter', async () => {
    const provider = createSkillProvider();
    const [candidate] = await provider.list();
    expect(candidate).toMatchObject({ name: SKILL_NAME, source: 'bundled', provider: 'dsh-web3', rank: 600 });
    expect(candidate?.invocation).toEqual({ modelInvocable: true, userInvocable: true });
    const definition = await provider.get(candidate);
    expect(String(definition?.content)).toContain('wallet_transfer');
    expect(String(definition?.content)).not.toMatch(/^---/);
  });

  it('registers through ctx.inject when the registry is available, and writes no mirror', async () => {
    const registered: unknown[] = [];
    const skills = { registerProvider: (create: () => unknown) => (registered.push(create()), () => undefined) };
    const ctx = {
      get: (name: string) => (name === 'skills' ? skills : undefined),
      inject(deps: string[], callback: (scoped: unknown) => void) {
        expect(deps).toEqual(['skills']);
        callback({ skills });
      },
    };
    provideBundledSkill(ctx as never, quiet as never);
    expect(registered).toHaveLength(1);
    expect(await exists(userSkillPath())).toBe(false);
  });
});

describe('legacy mirrors in the user skill folder', () => {
  it('removes a mirror written by an earlier release', async () => {
    const target = userSkillPath(root);
    await mkdir(join(root, SKILL_NAME), { recursive: true });
    await writeFile(target, `${MANAGED_MARKER}\nanything`);
    expect(await removeLegacySkillMirror(quiet, root)).toBe('removed');
    expect(await exists(join(root, SKILL_NAME))).toBe(false);
  });

  it('keeps a copy the user edited', async () => {
    const target = userSkillPath(root);
    await mkdir(join(root, SKILL_NAME), { recursive: true });
    await writeFile(target, '---\nname: dsh-web3-wallet\ndescription: my own rules\n---\nbody');
    expect(await removeLegacySkillMirror(quiet, root)).toBe('kept');
    expect(await exists(target)).toBe(true);
  });

  it('falls back to a marked mirror without overwriting user edits', async () => {
    await syncBundledSkill(quiet, root);
    const mirrored = await readFile(userSkillPath(root), 'utf8');
    expect(mirrored.startsWith(MANAGED_MARKER)).toBe(true);
    await writeFile(userSkillPath(root), 'user edit');
    await syncBundledSkill(quiet, root);
    expect(await readFile(userSkillPath(root), 'utf8')).toBe('user edit');
  });
});
