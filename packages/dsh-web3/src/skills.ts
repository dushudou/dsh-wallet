/**
 * Bundled-skill sync for dsh-web3.
 *
 * DSH discovers skills from several filesystem roots (project, custom, user)
 * through `@deepseek-ai/dsh-skill-filesystem`, which watches those roots and
 * hot-refreshes the model-facing skill catalog. The plugin ships a
 * `skills/dsh-web3-wallet/SKILL.md` and, on mount, mirrors it into the DSH
 * user skill root (`$DSH_HOME/skills` or `~/.dsh/skills`) so the wallet skill
 * is available to every session with zero user configuration.
 *
 * The sync is idempotent: it only writes when the bundled content differs, so
 * an existing copy (possibly user-edited) is left untouched.
 *
 * @module dsh-web3/skills
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Logger } from '@deepseek-ai/cordis';

/** Skill name (kebab-case), matching the bundle directory name. */
export const SKILL_NAME = 'dsh-web3-wallet';

/** Resolve the DSH user skill root, matching dsh-home-paths. */
export function dshUserSkillsRoot(): string {
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh');
  return join(dshHome, 'skills');
}

/** Absolute path of the bundled SKILL.md inside this package. */
export function bundledSkillPath(): string {
  const selfDir = dirname(fileURLToPath(import.meta.url)); // <pkg>/lib
  return join(selfDir, '..', 'skills', SKILL_NAME, 'SKILL.md');
}

/** Target path under the DSH user skill root. */
export function userSkillPath(root = dshUserSkillsRoot()): string {
  return join(root, SKILL_NAME, 'SKILL.md');
}

/**
 * Mirror the bundled skill into the DSH user skill root if missing or stale.
 * Never throws: skill provisioning is best-effort and must not block startup.
 */
export async function syncBundledSkill(logger: Logger): Promise<void> {
  try {
    const source = bundledSkillPath();
    const sourceText = await readFile(source, 'utf8');
    const target = userSkillPath();
    try {
      const existing = await readFile(target, 'utf8');
      if (existing === sourceText) {
        logger.debug(`skill ${SKILL_NAME} already up to date at ${target}`);
        return;
      }
    } catch {
      // Target missing — write it.
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, sourceText, 'utf8');
    logger.info(`synced bundled skill ${SKILL_NAME} to ${target} (DSH hot-reloads skill roots)`);
  } catch (error) {
    logger.warn(`skill sync failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
