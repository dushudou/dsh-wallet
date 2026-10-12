/**
 * Test isolation: point DSH_HOME at a throwaway directory so nothing a test
 * mounts (skill mirrors, config) can touch the developer's real ~/.dsh, and
 * keep the wallet off the OS keychain.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';

const home = mkdtempSync(join(tmpdir(), 'dsh-web3-test-home-'));
process.env.DSH_HOME = home;
// Never read or write the developer's real macOS Keychain from tests.
process.env.DSH_WEB3_SECRET_STORE = 'none';
// Never download the public denylists from tests.
process.env.DSH_WEB3_DENYLIST_REFRESH = 'off';

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});
