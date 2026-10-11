# dsh-web3

DeepSeek Harness (DSH) plugin that mounts an agent-safe EVM wallet. Exposes a programmatic service (`ctx.wallet`), model tools (`wallet_*`), and read-only HTTP endpoints for the web UI.

## Install

```bash
pnpm add dsh-web3
```

## Configuration

```yaml
# dsh composition config
- id: wallet
  name: 'dsh-web3'
  config:
    # Vault directory. Defaults to $DSH_HOME/wallet or ~/.dsh/wallet.
    vaultPath: ~/.dsh/wallet
    # Auto-lock after this many ms without use (default 900000 = 15 min).
    autoLockMs: 900000
    passphrase:
      # auto: use credentials store, generate on first use
      # env:  read DSH_WALLET_PASSPHRASE from environment
      # manual: never generate; user must supply env or credentials
      mode: auto
    # Where the passphrase and PIN pepper live: auto (macOS Keychain on
    # macOS, else none), keychain, or none.
    secretStore: auto
    chains:
      # Per-chain RPC overrides (chain id -> URL)
      rpc:
        1: https://eth.llamarpc.com
        137: https://polygon-rpc.com
      # Watch-only tokens for balance display (chain id -> token list)
      tokens:
        1:
          - address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
            symbol: USDC
    # Disable built-in model tools (service-only mode)
    disableTools: false
    # UNSAFE: let tools return mnemonics/private keys into the chat transcript
    # after approval (the transcript goes to the model provider). Default false.
    unsafeAllowModelSecretReveal: false
    # Disable read-only HTTP endpoints
    disableHttp: false
```

## Passphrase resolution

Passphrases **never** travel through tool arguments (which are session-logged). The resolution chain:

1. `DSH_WALLET_PASSPHRASE` environment variable
2. macOS Keychain (service `dsh-web3`), when `secretStore` resolves to the keychain
3. Harness credentials service (`$DSH_HOME/.credentials.yaml`, `.env` layers) — a value found in the plaintext `.credentials.yaml` is moved into the Keychain on first use (written, read back, then removed from the file)
4. In `auto` mode only, while the vault has no accounts: generate a strong random passphrase and store it in the Keychain (or credentials where no Keychain applies)

The daily PIN is stored only as an scrypt hash; with the Keychain it is also keyed by a random pepper kept there, so a copied `pin.json` cannot be brute-forced offline.

For manual workflows, the unlock tool accepts a `passphraseFile` path — the file is read once (must be 0600) and deleted immediately.

## Service API (`ctx.wallet`)

```ts
const { wallet } = ctx;

// Vault
wallet.status();                    // vault status snapshot
wallet.listAccounts();              // account metadata (no secrets)
await wallet.unlock();              // unlock via passphrase resolution
wallet.lock();                      // lock + zeroize

// Accounts
await wallet.createAccount({ label: 'Trading' });
await wallet.importAccount({ source: 'mnemonic', secretFile: '/tmp/seed.txt' });
await wallet.removeAccount(accountId);

// Balances
await wallet.balances(accountMeta, 1);  // native + configured tokens

// Transactions (full policy + approval pipeline)
await wallet.prepareTransaction({ from, chainId: 1, to, value });  // dry-run
await wallet.sendTransaction({ from, chainId: 1, to, value }, approvalGateway);

// Signing
await wallet.signMessage({ account, message }, approvalGateway);
await wallet.signTypedData({ account, domain, types, value }, approvalGateway);

// Policy
wallet.getPolicy();
await wallet.setPolicy(policyPreset('testnet'));

// Audit
await wallet.recentAudit(50);
```

## Model tools

When `disableTools` is false, the plugin registers these tools:

| Tool | Description |
|---|---|
| `wallet_status` | Vault status, account count, policy summary, daily-PIN state |
| `wallet_unlock` / `wallet_lock` | Unlock (passphrase from resolution chain or `passphraseFile`) / lock |
| `wallet_list` | List account metadata (no secrets) |
| `wallet_create` | New HD wallet, or derive the next address from an existing seed (`fromAccount`) |
| `wallet_import` | Import from a 0600 mnemonic / private key / keystore file |
| `wallet_remove_account` | Remove an account (human approval + PIN; warns when not backed up) |
| `wallet_chains` | Chain registry with the well-known token symbols per chain |
| `wallet_balance` | Native + token balances (configured + well-known tokens, or an explicit list) |
| `wallet_address_book` | List / add / remove contacts (writes need approval; whitelisted contacts are panel-only) |
| `wallet_transfer` | Native or ERC-20 transfer in **human units** (`amount: "25"`, `token: "USDC"`); `dryRun` returns a `preparedId` |
| `wallet_prepare_transaction` | Dry-run a raw call: populate, decode intent, preflight, policy — returns a `preparedId` |
| `wallet_send_transaction` | Execute a `preparedId` (or raw fields): policy → PIN → approval → sign → journal → broadcast |
| `wallet_approve_token` / `wallet_allowance` | Set / revoke / read ERC-20 allowances (unlimited always asks) |
| `wallet_tx_status` / `wallet_history` | Receipt-backed status; locally journaled history |
| `wallet_replace_transaction` | Speed up or cancel a pending transaction (same nonce) |
| `wallet_sign_message` / `wallet_sign_typed_data` | EIP-191 / EIP-712 signing; permits and orders are decoded and gated |
| `wallet_x402_authorize` | x402 `exact` payments (v1/v2) with the token's real EIP-712 domain |
| `wallet_policy_get` | Policy, detected preset, hard limits (whitelist, USD / native caps) and today's usage |
| `wallet_policy_set` | **Tighten only** (`locked` / `strict`); loosening returns `status: "use-panel"` |
| `wallet_reveal_secret` | Points the user to the settings panel (key material never enters the transcript) |
| `wallet_export_keystore` | Encrypted keystore to a 0600 file (approval + PIN); returns only the path |
| `wallet_pin_status` / `wallet_pin_verify` | Human-gate status (no PIN argument) |
| `wallet_audit_log` | Recent secret-free audit entries |

Every failure is returned as `{ ok: false, code, message, hint }` (e.g. `VAULT_LOCKED`, `INVALID_ADDRESS`, `INSUFFICIENT_FUNDS`, `WOULD_REVERT`) so agents can recover deterministically. See `docs/wallet-design.md` for the full design.

## HTTP endpoints

When `disableHttp` is false, read-only endpoints are mounted for the web UI:

- `GET /api/dsh-web3/status` — vault status
- `GET /api/dsh-web3/accounts` — account list
- `GET /api/dsh-web3/balances?chainId=1&address=0x...` — balances
- `GET /api/dsh-web3/policy` — current policy
- `GET /api/dsh-web3/audit?limit=50` — recent audit entries
- `GET /api/dsh-web3/chains` — built-in chain registry

All endpoints return secret-free JSON.

## DSH web profile

Add `dsh-web3` to the profile `package.json` and bundle list, then reinstall:

```jsonc
// ~/.dsh/profiles/web/package.json
{
  "dependencies": { "dsh-web3": "^0.7.0" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-freeroute", "dsh-web3"] } }
}
```

The package's `cordis.patch.yml` (declared via `dsh.bundle.patch` in
package.json) mounts the plugin as `web3` in the composed profile. On the
DSH web host the plugin also registers a Typert Remote namespace (`web3/*`)
that the settings panel uses over the client Connection RPC carrier.

## Bundled skill

The `dsh-web3-wallet` skill (`skills/dsh-web3-wallet/SKILL.md`) is served
through the DSH skill registry (`ctx.skills.registerProvider`, DSH ≥ 0.2), so
it is in every session's skill catalog while the plugin is loaded — nothing
is written to `~/.dsh/skills`. Its catalog line routes any wallet, transfer,
token, signing, x402 or wallet-policy request to the `wallet_*` tools ahead
of shell scripts or other wallet skills.

Older releases mirrored the file into `~/.dsh/skills/dsh-web3-wallet/`, where
it would shadow the bundled copy. Mirrors whose content matches a shipped
version are removed on startup; a copy you edited is kept (with a warning).
Hosts without a skill registry still get a marked mirror.

## Hard limits and the transfer whitelist

On top of the signing policy, `limits.json` holds rules that refuse a request
outright — even after a human clicks approve:

- **Transfer whitelist** — direct transfers, token transfers, NFT transfers and
  payment authorizations (x402) only to trusted contacts or your own accounts.
- **Stablecoin caps** — per transfer / rolling 24h, in USD (USDC / USDT / DAI
  at $1), summed across chains.
- **Native caps** — per transfer / rolling 24h per native coin (`ETH` covers
  every ETH-native chain); also applied to value sent with contract calls.

A new wallet starts with the small-amount profile: the `micropay` policy,
stablecoins capped at 100 USD per transfer / 1000 USD per day, and every native
coin at 1 per transfer / 100 per day. Testnets are exempt unless
`includeTestnets` is on. Model tools can read the limits but never change them.

## Settings panel

The client half (`dsh-web3/client`, DSH web module-loader format) adds a
**Web3 wallet** page to DSH Settings, built from DSH primitives (segmented
tabs, switches, modals, risk confirmations, menus) and DSH theme tokens:

| Tab | What it does |
|---|---|
| Assets | Account / network picker, receiving address, balances, recent transactions, setup reminders |
| Accounts | Create, import (phrase / key / keystore), back up, rename, export keystore (browser download), remove |
| Security | Lock / unlock, PIN (set, verify, change, revoke today), agent-permission summary |
| Limits | Security mode (presets), spending caps with today's usage, transfer whitelist and contacts, policy rules |
| Activity | Transaction history with explorer links, audit log |

Anything that weakens protection or exposes keys — loosening a preset or a
limit, whitelisting an address, re-pointing a contact, revealing a recovery
phrase, exporting, removing an account — asks for the PIN in a step-up
dialog, and requires a PIN to be set up first. Tightening never asks.

## License

MIT
