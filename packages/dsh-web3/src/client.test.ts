/**
 * Static checks for the settings-panel bundle: it loads through the DSH
 * module loader contract, and every UI string exists in both languages.
 */
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

interface ClientModule {
  apply: (ctx: unknown) => void;
  inject: string[];
  __testing: { messages: { zh: Record<string, string>; en: Record<string, string> } };
}

async function loadClient(): Promise<{ source: string; module: ClientModule }> {
  const source = await readFile(new URL('../client/client.js', import.meta.url), 'utf8');
  let loaded: ClientModule | undefined;
  const reactStub = { createElement: () => null, createContext: () => ({ Provider: () => null }), forwardRef: (fn: unknown) => fn };
  runInNewContext(source, {
    window: {
      __ModuleLoader__: {
        load: (definition: { id: string; factory: (require: (name: string) => unknown) => ClientModule }) => {
          expect(definition.id).toBe('dsh-web3');
          loaded = definition.factory((name) => {
            if (name === 'react') return reactStub;
            throw new Error(`not available: ${name}`);
          });
        },
      },
    },
  });
  if (loaded === undefined) throw new Error('client did not register with the module loader');
  return { source, module: loaded };
}

describe('settings panel bundle', () => {
  it('registers through the DSH module loader and injects the services it uses', async () => {
    const { module } = await loadClient();
    expect(typeof module.apply).toBe('function');
    expect(module.inject).toEqual(expect.arrayContaining(['connection', 'slots', 'locale']));
  });

  it('has every string in both Chinese and English', async () => {
    const { source, module } = await loadClient();
    const { zh, en } = module.__testing.messages;
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
    const used = new Set([...source.matchAll(/\bt\("([A-Za-z_][\w-]*)"\)/g)].map((match) => match[1]));
    for (const key of used) {
      expect(zh, `missing zh "${key}"`).toHaveProperty([key]);
      expect(en, `missing en "${key}"`).toHaveProperty([key]);
    }
    for (const preset of ['strict', 'micropay', 'testnet', 'power', 'locked', 'custom']) {
      expect(zh).toHaveProperty([`preset_${preset}`]);
      expect(zh).toHaveProperty([`preset_${preset}Desc`]);
    }
  });
});
