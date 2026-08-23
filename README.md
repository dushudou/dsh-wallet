# dsh-wallet

Agent-safe EVM wallet for the DeepSeek Harness (DSH). Encrypted local key vault, declarative signing policy, model tools, and a web UI — designed so an AI agent can manage on-chain assets without ever holding raw private keys in plaintext or signing unauthorised transactions.

## Architecture

```
packages/
├── core/        # @dsh-wallet/core — library: vault, signing, policy, providers
└── dsh-plugin/  # @dsh-wallet/plugin — DSH plugin: service, model tools, HTTP
```

### Security model

1. **Keys never leave the vault in plaintext.** All key material is encrypted at rest with scrypt + AES-256-GCM; decrypted copies live only in memory and are zeroized on lock.
2. **Every signing request is policy-authorized first.** A declarative policy evaluates `allow` / `deny` / `ask` before any key is touched. `ask` routes to a human approval gateway.
3. **Secrets never travel through tool arguments.** Passphrases resolve from env / credentials store / generated-on-first-use; imported secrets come from 0600 files that are deleted after read.
4. **Audit trail is append-only and secret-scanned.** Every security-relevant event is written to a daily-rotating JSONL log; a final `assertNoSecrets` guard prevents key material from being persisted or returned.

## Packages

### `@dsh-wallet/core`

The library surface. Use it directly when embedding the wallet into another application.

```ts
import { WalletVault, policyPreset } from '@dsh-wallet/core';

const vault = await WalletVault.open({ directory: './vault' });
await vault.unlock('your-passphrase');
const { meta, mnemonic } = await vault.createAccount({ label: 'Main' });
console.log(meta.address);
```

Key exports: `WalletVault`, `populateTransaction`, `signTransaction`, `signMessage`, `signTypedData`, `evaluatePolicy`, `policyPreset`, `JsonRpcChainProvider`, `SpendTracker`, `AuditLog`.

### `@dsh-wallet/plugin`

The DSH plugin. Mounts `ctx.wallet` (the programmatic service) and registers model tools (`wallet_*`) plus read-only HTTP endpoints for the web UI.

```yaml
# dsh config
- id: wallet
  name: '@dsh-wallet/plugin'
  config:
    vaultPath: ~/.dsh/wallet
    autoLockMs: 900000
    passphrase:
      mode: auto
    chains:
      rpc:
        1: https://eth.llamarpc.com
```

## Development

```bash
pnpm install
pnpm run build      # tsc across all packages
pnpm run typecheck  # tsc --noEmit
pnpm run test       # vitest run
pnpm run all        # build + typecheck + test
```

Requires Node >= 20.

## Status

- [x] Core: vault, crypto, accounts, signing (EIP-1559 / 191 / 712), policy engine, spend tracking, audit, redaction, chain registry, providers
- [x] Core: 68 unit tests
- [x] Plugin: wallet service, config schema, passphrase resolution, secret-file intake
- [ ] Plugin: model tools registration (`wallet_*`)
- [ ] Plugin: read-only HTTP endpoints
- [ ] Plugin: web UI client
- [ ] Integration / e2e tests

## License

MIT
