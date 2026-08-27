---
name: dsh-web3-wallet
description: 管理 DSH 内置的 EVM 钱包（dsh-web3）：创建/导入账户、多链余额查询、转账、签名与安全策略。当用户要求使用 EVM 钱包能力——创建或导入钱包、查看余额、收款/转账、签名消息、管理多链账户、助记词/私钥、安全策略——时加载本技能并按其流程调用 wallet_* 工具。
whenToUse: 用户提到钱包、余额、转账、收款、签名、助记词、导入钱包、EVM 账户、gas、链上交易等场景时
metadata:
  provider: dsh-web3
  source: bundled
---

# dsh-web3 — DSH 内置 EVM 钱包

dsh-web3 是 DSH 的原生钱包插件：一个加密的 HD 钱包保险库（vault）+ 18 个 `wallet_*` 模型工具 + 设置面板（设置 → Web3）。钱包数据默认存放在 `~/.dsh-web3/`。

## 能力与工具对照

| 场景 | 工具 | 说明 |
|---|---|---|
| 状态/解锁 | `wallet_status` / `wallet_unlock` / `wallet_lock` | vault 锁定/解锁状态；passphrase 由环境变量或凭据库自动解析，一般无需用户输入 |
| 账户 | `wallet_list` / `wallet_create` / `wallet_import` / `wallet_remove_account` | 列出（不含密钥）、创建（BIP-39）、导入（助记词/私钥/keystore）、移除 |
| 链与余额 | `wallet_chains` / `wallet_balance` | 内置链列表（Ethereum/Sepolia/Base/Arbitrum/OP/Polygon/BSC/Avalanche/Gnosis/Amoy…）与原生币+代币余额 |
| 转账 | `wallet_prepare_transaction` → `wallet_send_transaction` | 离线填充（nonce/gas/fee）→ 签名广播；默认需人工审批 |
| 签名 | `wallet_sign_message` / `wallet_sign_typed_data` | EIP-191 消息与 EIP-712 结构化数据签名 |
| 策略 | `wallet_policy_get` / `wallet_policy_set` | 签署策略（allow / ask / deny）与硬性限额 |
| 备份/导出 | `wallet_reveal_secret` / `wallet_export_keystore` | 查看助记词（需审批）、导出 keystore（加密） |
| 审计 | `wallet_audit_log` | 最近操作记录（不含密钥） |

## 核心工作流

### 1. 总入口：先看状态
任何钱包操作前先调用 `wallet_status`。若 vault 锁定，调用 `wallet_unlock`（无需用户提供 passphrase——由 env/凭据自动解析；若失败再询问用户配置）。

### 2. 创建 / 导入账户
- 创建：`wallet_create`（可选 `label`、`words` 12/15/18/21/24）。默认**不**返回助记词；只有用户明确要求"显示助记词/备份"时才设 `reveal: true`（会走人工审批）。
- 导入：`wallet_import`，`source` 为 `mnemonic` / `privateKey` / `keystore`，密钥仅作为调用参数传入、绝不落盘。

### 3. 查询余额
`wallet_list` 拿到账户 → `wallet_balance`（参数 `account`、`chainId`）。查询免费公共 RPC，默认自动挑选可用端点。

### 4. 转账（两步，必须成对）
1. `wallet_prepare_transaction`：填 `from`（账户）、`to`、`value`（wei，可用 ethers `parseEther`）、`chainId`。返回已填充的 nonce/gas/limit/fee。
2. 用户确认后 `wallet_send_transaction` 广播。**不要**跳过 prepare 直接构造原始交易。

### 5. 签名
消息签名用 `wallet_sign_message`；结构化数据用 `wallet_sign_typed_data`（`domain`/`types`/`message`）。

### 6. 安全策略
`wallet_policy_get` 查看；`wallet_policy_set` 调整（如把某个策略从 `ask` 改 `allow`）。默认策略会拦截大额/危险操作。

## 安全与授权边界（必须遵守）

1. **助记词/私钥绝不主动输出**。只在用户明确要求且通过人工审批（approval）后，用 `wallet_reveal_secret` 返回；不得复述、写入文件、或存入会话笔记。
2. **转账与签名默认需要审批**（`ask` 策略）。不要替用户"默认同意"；提示用户去 DSH 界面/审批网关确认。
3. **vault 会自动锁定**（默认闲置 15 分钟）；锁定后所有签名/余额操作前需先 `wallet_unlock`。
4. **密钥永不落盘**：导入/导出的密钥只作为工具参数传递；keystore 导出带密码加密。
5. 用户可同时用**设置面板（设置 → Web3）**手动管理钱包；面板与工具共享同一 vault，状态一致。

## 常见问题

- **余额为 0 / 查询失败**：先确认 `wallet_status` 未锁定；RPC 是免费公共节点，偶发不可用时插件会自动切换到备用端点。
- **转账被拒（deny）**：命中硬性限额策略，提示用户提高限额或走人工审批。
- **助记词显示"未获批准"**：reveal 需要人工审批，属正常安全行为，引导用户确认。

## 配置

插件在 profile 的 `cordis.patch.yml` 中通过 `dsh-web3` 行的 `config` 配置：
- `vaultPath`：vault 目录（默认 `~/.dsh-web3`）
- `passphrase.mode`：`auto`（env/凭据自动解析）/ `env` / `manual`
- `chains.rpc` / `chains.tokens`：自定义 RPC 覆盖与代币
- `disableTools` / `disableHttp`：关闭工具或 HTTP 面

## 参考

- 完整工具 schema：`lib/tools.d.ts`
- 核心库（vault/签名/链）：`dsh-web3-core`
- 设置面板入口：DSH 设置 → Web3
