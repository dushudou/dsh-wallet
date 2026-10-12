# Security Policy

dsh-web3 holds private keys and signs transactions, so we treat security reports as the highest priority.

## Reporting a vulnerability

**Do not open a public issue.** Report privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability** (<https://github.com/dushudou/dsh-wallet/security/advisories/new>).

Please include the affected package and version, the steps or a proof of concept, and the impact you expect (key disclosure, unauthorized signing, bypass of a policy, limit, or security check, and so on). We aim to acknowledge reports within 3 days and to ship a fix or mitigation for confirmed critical issues within 14 days, then publish an advisory crediting the reporter unless you prefer otherwise.

## Supported versions

Only the latest published minor version of each package receives security fixes.

| Package | Supported |
|---|---|
| `dsh-web3` | latest `0.x` minor |
| `dsh-web3-core` | latest `0.x` minor |

## Scope

In scope: anything that lets an attacker obtain key material, sign without passing the policy / hard limits / security checks / human approval, loosen protection without the PIN, make the agent receive secrets, or cause a duplicate or altered payment.

### Known boundaries (not vulnerabilities)

These are documented design limits; reports that only restate them are out of scope, but ideas to close them are welcome:

- **Same OS user.** A program running as your OS user — including an agent with unrestricted shell access — can read the vault passphrase from the login Keychain without a prompt and decrypt the key files. Keep balances small and do not give agents unrestricted shell access in wallet sessions.
- **Stolen keys bypass all checks.** Policy, limits, and security checks apply only to signing through the plugin.
- **Threat intelligence coverage.** Denylists and reputation data (OFAC, ScamSniffer, Chainalysis oracle, optional GoPlus) are incomplete by nature; a missed malicious address is not a vulnerability by itself.
- **No external audit yet.** The code has not been audited by a third party.

## Hardening checklist for users

- Use dsh-web3 as a hot wallet with small balances; keep savings in a hardware wallet.
- Back up the recovery phrase offline from **Settings → Web3 → Accounts**, and set a PIN.
- Prefer the `strict` or `micropay` security mode and set spending caps.
- Leave the pre-signing security checks on; relay every HIGH / CRITICAL finding to a human.
