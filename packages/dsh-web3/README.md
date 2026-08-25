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
    # Disable read-only HTTP endpoints
    disableHttp: false
```

## Passphrase resolution

Passphrases **never** travel through tool arguments (which are session-logged). The resolution chain:

1. `DSH_WALLET_PASSPHRASE` environment variable
2. Harness credentials service (`$DSH_HOME/.credentials.yaml`, `.env` layers)
3. In `auto` mode only: generate a strong random passphrase and store it in credentials on first use

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
| `wallet_status` | Vault status, account count, policy summary, auto-lock |
| `wallet_unlock` | Unlock the vault (passphrase from resolution chain or `passphraseFile`) |
| `wallet_lock` | Lock the vault, zeroizing decrypted keys |
| `wallet_list` | List account metadata (no secrets) |
| `wallet_create` | Generate a new HD account; reveal mnemonic requires approval |
| `wallet_import` | Import from a 0600 mnemonic / private key / keystore file |
| `wallet_remove_account` | Remove an account from the vault |
| `wallet_chains` | List the built-in EVM chain registry |
| `wallet_balance` | Native + configured token balances on a chain |
| `wallet_prepare_transaction` | Dry-run: populate + policy evaluation, no signing |
| `wallet_send_transaction` | Full flow: policy → approval → sign → broadcast |
| `wallet_sign_message` | Sign an EIP-191 message under policy |
| `wallet_sign_typed_data` | Sign EIP-712 typed data under policy |
| `wallet_policy_get` | Current signing policy |
| `wallet_policy_set` | Replace the signing policy (preset or full document; requires approval) |
| `wallet_reveal_secret` | Reveal mnemonic / private key (ALWAYS requires approval) |
| `wallet_export_keystore` | Export an account as Web3 Secret Storage JSON |
| `wallet_audit_log` | Recent secret-free audit entries |

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
  "dependencies": { "dsh-web3": "^0.1.3" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-freeroute", "dsh-web3"] } }
}
```

The package's `cordis.patch.yml` (declared via `dsh.bundle.patch` in
package.json) mounts the plugin as `web3` in the composed profile. On the
DSH web host the plugin also registers a Typert Remote namespace
(`web3/status`, `web3/accounts`, `web3/balances`, `web3/policy`,
`web3/audit`, `web3/chains`) so the built-in settings page can read data
over the client Connection RPC carrier.

## Web UI client

The package ships a client half (`dsh-web3/client` in DSH web
module-loader format) that renders a read-only **Web3** settings panel —
vault status, accounts, signing policy and recent audit — fed by the
`web3` Typert Remote namespace over the Connection RPC carrier.

## License

MIT
