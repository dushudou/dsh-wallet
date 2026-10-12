# dsh-web3

[English](README.md) | 中文

[![CI](https://github.com/dushudou/dsh-web3/actions/workflows/ci.yml/badge.svg)](https://github.com/dushudou/dsh-web3/actions/workflows/ci.yml)
[![dsh-web3](https://img.shields.io/npm/v/dsh-web3.svg?label=dsh-web3)](https://www.npmjs.com/package/dsh-web3)
[![dsh-web3-core](https://img.shields.io/npm/v/dsh-web3-core.svg?label=dsh-web3-core)](https://www.npmjs.com/package/dsh-web3-core)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

面向 [DeepSeek Harness (DSH)](https://www.npmjs.com/package/@deepseek-ai/dsh) 的 Agent 安全 EVM 钱包：AI Agent 可以帮你查余额、转代币、签 Permit、支付 x402 账单，而私钥只加密保存在本机，永远不会进入对话。

```bash
dsh plugin --profile web add dsh-web3
```

然后在 DSH 里打开 **设置 → Web3 钱包**，创建或导入钱包。

## 为什么需要它

让大模型直接动钱，出错的方式是可以预见的：精度算错、地址打错、超时后重复付款，或者被提示词注入骗去做无限授权。dsh-web3 把这些工作从模型手里拿走，并给剩下的部分加上护栏：

- **模型只表达意图，钱包负责精确执行。** 金额用人类单位，收款人可以是地址、ENS 或联系人名称，代币符号只从白名单解析——换算和 calldata 都是确定性的，并在链上核对。
- **先预览、再确认、后执行。** 用户看到的就是最终签名的内容；一次性 id、幂等键和"广播前先写日志"保证重试安全。
- **多层决策。** 签名策略（`allow` / `ask` / `deny`）、硬性限额与转账白名单，以及签名前安全检查——黑名单（OFAC、ScamSniffer、你自己的）、链上制裁预言机、`eth_simulateV1` 模拟结果与解码意图对账、地址投毒和盗币模式识别。严重风险直接拒绝，高风险一定交给人确认。
- **Agent 只能收紧。** 放宽预设或限额、加白名单、关闭安全检查、查看助记词、删除账户，只能在设置面板里完成，并需要输入 PIN。

## 包

| 包 | 说明 |
|---|---|
| [`dsh-web3`](packages/dsh-web3) | DSH bundle：`ctx.wallet` 服务、30 个 `wallet_*` 模型工具、`dsh-web3-wallet` skill，以及 **Web3 钱包**设置页 |
| [`dsh-web3-core`](packages/dsh-web3-core) | 核心库：加密保险库、签名策略与限额、意图解码、模拟对账、黑名单、链上数据接口 |

## 安全模型

1. **密钥从不以明文离开保险库。** 静态存储使用 scrypt + AES-256-GCM；解密后的密钥只在内存中，锁定时清除。
2. **每次签名都要先通过授权**：策略、硬性限额、安全检查依次执行，后一层只能收紧前一层的决定。
3. **密钥不经过工具参数或返回值。** 口令从环境变量、macOS 钥匙串或 DSH 凭据存储解析；备份在设置面板完成。
4. **全部操作写入审计日志**：只追加、经过密钥扫描。

已知边界：以你的系统用户身份运行的程序（包括拥有不受限 shell 权限的 Agent）可以从登录钥匙串读出口令并解密密钥文件。请把 dsh-web3 当作只放小额资产的热钱包。详见 [SECURITY.md](SECURITY.md) 和[设计文档](docs/wallet-design.md)。

## 开发

```bash
pnpm install
pnpm run all        # 构建 + 类型检查 + 测试
```

需要 Node.js 20+ 和 pnpm 10（`corepack enable` 会按 `packageManager` 字段选用版本）。开发流程和发布步骤见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 文档

- [插件 README](packages/dsh-web3/README.zh.md)——安装、配置、设置面板、模型体验、已知限制
- [核心库 README](packages/dsh-web3-core/README.md)——库 API（英文）
- [钱包设计](docs/wallet-design.md) 与 [支付协议](docs/payments-protocol-integration.md)——设计文档
- [更新日志](CHANGELOG.md)

## 许可证

[MIT](LICENSE)
