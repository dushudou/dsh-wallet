# dsh-web3

English | [中文](README.zh.md)

[![CI](https://github.com/dushudou/dsh-web3/actions/workflows/ci.yml/badge.svg)](https://github.com/dushudou/dsh-web3/actions/workflows/ci.yml)
[![dsh-web3](https://img.shields.io/npm/v/dsh-web3.svg?label=dsh-web3)](https://www.npmjs.com/package/dsh-web3)
[![dsh-web3-core](https://img.shields.io/npm/v/dsh-web3-core.svg?label=dsh-web3-core)](https://www.npmjs.com/package/dsh-web3-core)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

An agent-safe EVM wallet for [DeepSeek Harness (DSH)](https://www.npmjs.com/package/@deepseek-ai/dsh): an AI agent can check balances, send tokens, sign permits, and pay x402 invoices, while private keys stay encrypted on your machine and never enter the chat.

```bash
dsh plugin --profile web add dsh-web3
```

Then open **Settings → Web3 wallet** in DSH to create or import a wallet.

## Why

Letting a language model move money fails in predictable ways: wrong decimals, a mistyped address, a payment sent twice after a timeout, or a prompt injection that asks for an unlimited approval. dsh-web3 takes that work away from the model and puts guards around what is left:

- **The model states intent; the wallet does the exact work.** Amounts in human units, recipients by address, ENS, or contact name, token symbols from a curated list — conversions and calldata are deterministic and checked on-chain.
- **Prepare → confirm → execute.** What the user reviewed is exactly what gets signed; single-use ids, idempotency keys, and a journal written before broadcast make retries safe.
- **Layered decisions.** A signing policy (`allow` / `ask` / `deny`), hard spending limits and a transfer whitelist, and pre-signing security checks — denylists (OFAC, ScamSniffer, your own), the on-chain sanctions oracle, `eth_simulateV1` reconciled against the decoded intent, address-poisoning and drainer-pattern detection. Critical findings refuse outright; high ones always reach a human.
- **The agent can only tighten.** Loosening a preset or limit, whitelisting, switching a check off, revealing a recovery phrase, or removing an account happens only in the settings panel, confirmed with a PIN.

## Packages

| Package | What it is |
|---|---|
| [`dsh-web3`](packages/dsh-web3) | The DSH bundle: `ctx.wallet` service, 30 `wallet_*` model tools, the `dsh-web3-wallet` skill, and the **Web3 wallet** settings page |
| [`dsh-web3-core`](packages/dsh-web3-core) | The library: encrypted vault, signing policy and limits, intent decoding, simulation reconciliation, denylist, providers |

## Security model

1. **Keys never leave the vault in plaintext.** scrypt + AES-256-GCM at rest; decrypted keys live only in memory and are wiped on lock.
2. **Every signature is authorized first** by policy, hard limits, and security checks — in that order, each able only to tighten the previous one.
3. **Secrets never travel through tool arguments or results.** The passphrase resolves from the environment, the macOS Keychain, or the DSH credentials store; backups happen in the settings panel.
4. **Everything is audited** in an append-only, secret-scanned log.

Known boundary: a program running as your OS user (including an agent with unrestricted shell access) can read the passphrase from the login Keychain and decrypt the key files. Treat dsh-web3 as a hot wallet for small amounts. See [SECURITY.md](SECURITY.md) and the [design notes](docs/wallet-design.md).

## Development

```bash
pnpm install
pnpm run all        # build + typecheck + test
```

Requires Node.js 20+ and pnpm 10 (`corepack enable` picks the version from `packageManager`). See [CONTRIBUTING.md](CONTRIBUTING.md) for the workflow and release steps.

## Documentation

- [Plugin README](packages/dsh-web3/README.md) — install, configuration, settings panel, model experience, limitations
- [Core README](packages/dsh-web3-core/README.md) — library API
- [Wallet design](docs/wallet-design.md) and [payment protocols](docs/payments-protocol-integration.md) — design notes (Chinese)
- [Changelog](CHANGELOG.md)

## License

[MIT](LICENSE)
