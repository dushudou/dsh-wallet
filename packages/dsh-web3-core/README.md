# dsh-web3-core

The library surface of dsh-web3: encrypted key vault, HD account management, declarative signing policy, EVM chain providers, and EIP-1559 / EIP-191 / EIP-712 signing.

## Install

```bash
pnpm add dsh-web3-core ethers
```

Requires Node >= 20.

## Quick start

```ts
import { WalletVault, policyPreset, JsonRpcChainProvider, populateTransaction, signTransaction } from 'dsh-web3-core';

// 1. Open (or initialize) a vault directory.
const vault = await WalletVault.open({ directory: './vault' });

// 2. Unlock with a passphrase (decrypts keys into memory).
await vault.unlock('correct horse battery staple');

// 3. Create an HD account (mnemonic returned once — back it up).
const { meta, mnemonic } = await vault.createAccount({ label: 'Main' });
console.log('Address:', meta.address, 'Mnemonic:', mnemonic);

// 4. Evaluate the signing policy (no key touched).
const decision = vault.evaluateSignPolicy({
  type: 'signTransaction',
  account: { address: meta.address },
  chainId: 1,
  to: '0x...',
  value: '1000000000000000', // 0.001 ETH
});
console.log('Policy:', decision.effect, decision.reason);

// 5. If allowed, populate + sign + broadcast.
if (decision.effect === 'allow') {
  const provider = JsonRpcChainProvider.forChainId(1);
  const populated = await populateTransaction({ from: meta.address, chainId: 1, to: '0x...', value: '1000000000000000' }, provider);
  const account = vault.getUnlockedAccount(meta.id);
  const signed = await signTransaction(account.wallet, populated);
  const txHash = await provider.broadcastRawTransaction(signed.raw);
  console.log('Broadcast:', txHash);
}

// 6. Lock when done (zeroizes decrypted key material).
vault.lock();
```

## Vault layout

```
vault/
├── vault.json           # account metadata (no secrets)
├── policy.json          # signing policy (no secrets)
├── spend-state.json     # rolling-24h spend tracker (no secrets)
├── limits.json          # hard limits + transfer whitelist switch
├── security.json        # pre-signing security check settings
├── denylist.json        # user denylist
├── denylist-feeds.json  # cached OFAC / ScamSniffer feeds
├── keys/
│   └── <accountId>.json # AES-256-GCM encrypted key material (0600)
└── audit/
    └── audit-YYYY-MM-DD.jsonl  # append-only audit trail
```

Key files bind the account id into the GCM AAD, so renaming a key file over another account fails decryption.

## Signing policy

A policy decides `allow` / `deny` / `ask` for every signing request. Rules match on operation type, chain id, recipient, signer, method selector, per-tx value cap, daily value cap, and payload length.

```ts
import { policyPreset } from 'dsh-web3-core';

// Built-in presets: 'locked' | 'strict' | 'testnet' | 'power'
const policy = policyPreset('strict');
await vault.setPolicy(policy);
```

Or define custom rules:

```ts
const policy = {
  version: 1,
  updatedAt: new Date().toISOString(),
  defaultEffect: 'ask',
  rules: [
    {
      id: 'allow-small-mainnet',
      effect: 'allow',
      priority: 100,
      match: { type: 'signTransaction', chainIds: [1], maxTxValue: '10000000000000000' },
    },
  ],
};
```

## API reference

### `WalletVault`

- `static open(config): Promise<WalletVault>`
- `unlock(passphrase): Promise<void>` / `lock(): void` / `maybeAutoLock(): boolean`
- `status(): VaultStatus`
- `listAccounts(): AccountMeta[]` / `findAccount(selector): AccountMeta | undefined`
- `createAccount(options?): Promise<{ meta, mnemonic }>`
- `importMnemonic(input): Promise<{ meta, mnemonicId }>`
- `importPrivateKey(input): Promise<{ meta }>`
- `importKeystore(input): Promise<{ meta }>`
- `removeAccount(id): Promise<AccountMeta>`
- `exportKeystore(id, passphrase): Promise<{ json, address }>`
- `evaluateSignPolicy(request): PolicyDecision`
- `getPolicy(): SigningPolicy` / `setPolicy(policy): Promise<void>`

### Signing

- `populateTransaction(request, provider): Promise<PopulatedTransaction>`
- `signTransaction(wallet, tx): Promise<SignedTransaction>`
- `signMessage(wallet, message): Promise<{ signature, address }>`
- `signTypedData(wallet, domain, types, value): Promise<{ signature, address }>`
- `verifyEip191(message, signature): string`
- `verifyEip712(domain, types, value, signature): string`

### Chains & providers

- `getChain(chainId): ChainInfo | undefined` / `listChains(): ChainInfo[]`
- `explorerUrl(chainId, kind, value): string | undefined`
- `JsonRpcChainProvider` — production JSON-RPC provider
- `accountBalances(provider, address, tokens?): Promise<{ native, tokens }>`

### Security checks

- `runSecurityChecks(checks, subject, { onUnavailable })` — run `RiskCheck`s in parallel with per-check time budgets
- `escalateDecision(decision, report)` — `critical` → deny, `high` → ask; never loosens
- `Denylist` / `DENYLIST_FEEDS` — user denylist plus cached public feeds (`refreshFeeds` keeps the old list on failure)
- `summarizeSimulation(result, account)` / `reconcileSimulation(...)` — decode `eth_simulateV1` logs and compare them with the intent
- `JsonRpcChainProvider.simulate(call)` — `eth_simulateV1` with `traceTransfers`; throws `SimulationUnsupportedError` when the RPC lacks it

### Crypto & redaction

- `encryptSecret(plaintext, passphrase, options?): Promise<KeystoreEnvelope>`
- `decryptSecret(envelope, passphrase): Promise<string>`
- `assertNoSecrets(value, secrets): void` — throws if any secret appears
- `redactHexLike(value): string` — masks 64-hex-char strings

## License

MIT
