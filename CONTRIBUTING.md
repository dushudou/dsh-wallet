# Contributing

Thanks for helping make dsh-web3 safer and more useful. Security-sensitive reports go through [SECURITY.md](SECURITY.md), not public issues.

## Setup

```bash
corepack enable          # uses the pnpm version pinned in package.json
pnpm install
pnpm run all             # build + typecheck + test
```

Node.js 20 or newer. Tests never touch the network, your real `~/.dsh`, or the macOS Keychain (`vitest.setup.ts` isolates them).

## Repository layout

```text
packages/
├── dsh-web3-core/   library: vault, crypto, policy, limits, intent, simulation, denylist, providers
└── dsh-web3/        DSH bundle: service, model tools, settings panel (client/), skill (skills/)
docs/                design notes
```

## Guidelines

- **Safety first.** A change must never let a request skip the policy, hard limits, security checks, PIN, or human approval, and must never put key material into a tool result, log, or error message. Checks may only tighten a decision.
- **Agent accuracy.** Keep tool inputs in human units, results structured (`status`, `next`, `security.findings`), and errors as `{ ok: false, code, message, hint }`.
- **Tests.** Every behavior change comes with a test. Agent-facing behavior belongs in `packages/dsh-web3/src/agent.test.ts` or `security.test.ts`.
- **Docs stay in sync.** A tool added or removed must also change `skills/dsh-web3-wallet/SKILL.md` (a test enforces that the skill names exactly the registered tools). Panel strings exist in both Chinese and English (also tested). Update the package READMEs (`README.md` and `README.zh.md`) and `CHANGELOG.md`.
- **Commits.** Small, focused commits with an imperative subject (`fix: …`, `feat: …`, `docs: …`).

## Pull requests

1. Fork and branch from `main`.
2. `pnpm run all` must pass.
3. Describe the user-visible change and its security impact in the PR template.

## Releasing (maintainers)

1. Bump `version` in the changed packages; `dsh-web3` depends on `dsh-web3-core` through `workspace:^`, so bump core first when both change.
2. Add a `CHANGELOG.md` section.
3. `pnpm run all`, then check the tarballs: `pnpm --filter <package> pack` — `dsh-web3` must contain `cordis.patch.yml`, `locale/`, `icon.svg`, `skills/`, `client/`, and a concrete `dsh-web3-core` range.
4. Publish core before the plugin, with `pnpm publish --filter dsh-web3-core` then `pnpm publish --filter dsh-web3` (pnpm rewrites `workspace:^`).
5. Tag `dsh-web3-core@<version>` / `dsh-web3@<version>` and push the tags.
6. Smoke-test: `dsh plugin --profile <test-profile> add dsh-web3@<version>` must pass DSH's peer-range check.
