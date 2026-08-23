# @dsh-wallet/plugin

DeepSeek Harness (DSH) plugin that mounts an agent-safe EVM wallet. Exposes a programmatic service (`ctx.wallet`), model tools (`wallet_*`), and read-only HTTP endpoints for the web UI.

## Install

```bash
pnpm add @dsh-wallet/plugin
```

## Configuration

```yaml
# dsh composition config
- id: wallet
  name: '@dsh-wallet/plugin'
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
| `wallet_status` | Vault status, account count, policy summary |
| `wallet_unlock` | Unlock the vault (passphrase from resolution chain or file) |
| `wallet_lock` | Lock the vault |
| `wallet_list_accounts` | List account metadata |
| `wallet_create_account` | Generate a new HD account |
| `wallet_import_account` | Import from mnemonic / private key / keystore file |
| `wallet_balances` | Native + token balances on a chain |
| `wallet_prepare_transaction` | Dry-run: populate + policy evaluation, no signing |
| `wallet_send_transaction` | Full flow: policy → approval → sign → broadcast |
| `wallet_sign_message` | Sign an EIP-191 message under policy |
| `wallet_sign_typed_data` | Sign EIP-712 typed data under policy |
| `wallet_get_policy` | Current signing policy |
| `wallet_set_policy` | Replace the signing policy |
| `wallet_audit_log` | Recent audit entries |

## HTTP endpoints

When `disableHttp` is false, read-only endpoints are mounted for the web UI:

- `GET /wallet/status` — vault status
- `GET /wallet/accounts` — account list
- `GET /wallet/balances?chainId=1&address=0x...` — balances
- `GET /wallet/policy` — current policy
- `GET /wallet/audit?limit=50` — recent audit entries

All endpoints return secret-free JSON.

## License

MIT
