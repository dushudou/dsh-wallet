window.__ModuleLoader__.load({
	id: "dsh-web3",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const React = require("react");
		const h = React.createElement;

		// ── styles (DSH theme tokens: light/dark follow the host) ─────────
		const CSS = `
.dshw-root{display:flex;flex-direction:column;gap:16px;padding:4px 2px;font-size:13px;color:var(--dsw-alias-label-primary,#e8e8ea)}
.dshw-card{border:1px solid var(--dsw-alias-border-l1,#2c2d33);background:var(--dsw-alias-bg-base,#17181c);border-radius:12px;padding:14px 16px}
.dshw-cardTitle{font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--dsw-alias-label-tertiary,#82848b);margin:0 0 10px}
.dshw-row{display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--dsw-alias-border-l1,#2c2d33)}
.dshw-row:last-child{border-bottom:none}
.dshw-label{font-weight:500;min-width:110px;color:var(--dsw-alias-label-primary,#e8e8ea)}
.dshw-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:var(--dsw-alias-label-secondary,#b0b2b8);word-break:break-all}
.dshw-caption{font-size:11px;color:var(--dsw-alias-label-dimmed,#6a6c73)}
.dshw-head{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}
.dshw-badge{display:inline-block;padding:1px 8px;border-radius:999px;font-size:11px;font-weight:600}
.dshw-badge-allow,.dshw-badge-unlocked{background:var(--dsw-alias-state-success-secondary,rgba(46,160,67,.18));color:var(--dsw-alias-state-success-primary,#3fb950)}
.dshw-badge-deny,.dshw-badge-locked{background:var(--dsw-alias-state-error-secondary,rgba(248,81,73,.16));color:var(--dsw-alias-state-error-primary,#f85149)}
.dshw-badge-ask{background:var(--dsw-alias-state-warn-secondary,rgba(210,153,34,.16));color:var(--dsw-alias-state-warn-primary,#d29922)}
.dshw-badge-source{background:var(--dsw-alias-state-business-tertiary,rgba(74,158,255,.14));color:var(--dsw-alias-state-business-primary,#4a9eff)}
.dshw-btn{border:1px solid var(--dsw-alias-border-l2,#3a3b42);background:var(--dsw-alias-interactive-bg-hover,#26272c);color:var(--dsw-alias-label-primary,#e8e8ea);border-radius:8px;padding:6px 14px;font-size:12px;font-weight:500;cursor:pointer}
.dshw-btn:hover{border-color:var(--dsw-alias-state-business-primary,#4a9eff)}
.dshw-btn:disabled{opacity:.55;cursor:default}
.dshw-btnPrimary{border:1px solid transparent;background:var(--dsw-alias-button-primary-fill,#2f6fed);color:var(--dsw-alias-label-primary-foreground,#fff);border-radius:10px;padding:10px 16px;font-size:13px;font-weight:600;cursor:pointer}
.dshw-btnPrimary:hover{background:var(--dsw-alias-button-primary-hover,#4a7bff)}
.dshw-btnPrimary:disabled{opacity:.55;cursor:default}
.dshw-btnGhost{background:transparent;border-color:var(--dsw-alias-border-l2,#3a3b42);color:var(--dsw-alias-label-secondary,#b0b2b8)}
.dshw-btnWide{width:100%;justify-content:center}
.dshw-input,.dshw-textarea{box-sizing:border-box;width:100%;border:1px solid var(--dsw-alias-border-l2,#3a3b42);background:var(--dsw-alias-bg-layer-1,#1e1f24);color:var(--dsw-alias-label-primary,#e8e8ea);border-radius:8px;padding:8px 10px;font-size:12px;font-family:inherit}
.dshw-input:focus,.dshw-textarea:focus{outline:none;border-color:var(--dsw-alias-state-business-primary,#4a9eff)}
.dshw-textarea{min-height:72px;resize:vertical;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.dshw-field{margin-bottom:10px}
.dshw-fieldLabel{display:block;font-size:11px;font-weight:600;color:var(--dsw-alias-label-tertiary,#82848b);margin:0 0 4px;text-transform:uppercase;letter-spacing:.05em}
.dshw-empty{color:var(--dsw-alias-label-dimmed,#6a6c73);font-style:italic;padding:6px 0}
.dshw-error{color:var(--dsw-alias-state-error-primary,#f85149);padding:6px 0}
.dshw-note{color:var(--dsw-alias-state-warn-primary,#d29922);font-size:12px;padding:4px 0}
.dshw-auditKind{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:var(--dsw-alias-label-secondary,#b0b2b8)}
.dshw-auditTime{font-size:11px;color:var(--dsw-alias-label-dimmed,#6a6c73);min-width:120px}
.dshw-tabs{display:flex;gap:4px;background:var(--dsw-alias-bg-layer-1,#1e1f24);border:1px solid var(--dsw-alias-border-l1,#2c2d33);border-radius:10px;padding:3px;margin-bottom:12px}
.dshw-tab{flex:1;border:none;background:transparent;color:var(--dsw-alias-label-secondary,#b0b2b8);border-radius:7px;padding:6px 8px;font-size:12px;font-weight:500;cursor:pointer}
.dshw-tab:hover{color:var(--dsw-alias-label-primary,#e8e8ea)}
.dshw-tabActive{background:var(--dsw-alias-bg-base,#17181c);color:var(--dsw-alias-label-primary,#e8e8ea)}
.dshw-hero{display:flex;flex-direction:column;align-items:center;gap:16px;text-align:center;padding:28px 12px}
.dshw-logo{width:56px;height:56px;border-radius:18px;background:var(--dsw-alias-button-primary-fill,#2f6fed);color:var(--dsw-alias-label-primary-foreground,#fff);display:flex;align-items:center;justify-content:center;font-size:26px;font-weight:800}
.dshw-heroTitle{font-size:16px;font-weight:600;margin:0;color:var(--dsw-alias-label-primary,#e8e8ea)}
.dshw-heroSub{font-size:12px;color:var(--dsw-alias-label-secondary,#b0b2b8);margin:0;max-width:300px;line-height:1.5}
.dshw-heroActions{display:flex;flex-direction:column;gap:8px;width:240px;margin-top:4px}
.dshw-wordGrid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:12px 0}
.dshw-wordCell{display:flex;align-items:center;gap:6px;background:var(--dsw-alias-bg-layer-1,#1e1f24);border:1px solid var(--dsw-alias-border-l1,#2c2d33);border-radius:8px;padding:8px 10px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:var(--dsw-alias-label-primary,#e8e8ea)}
.dshw-wordIndex{color:var(--dsw-alias-label-dimmed,#6a6c73);font-size:11px;min-width:18px}
.dshw-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:12px}
.dshw-accountRow{display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--dsw-alias-border-l1,#2c2d33)}
.dshw-accountRow:last-child{border-bottom:none}
.dshw-avatar{width:32px;height:32px;border-radius:50%;background:var(--dshw-avatar-bg,var(--dsw-alias-state-business-tertiary,rgba(74,158,255,.14)));color:var(--dsw-alias-state-business-primary,#4a9eff);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:12px;flex:none}
.dshw-accountBody{flex:1;min-width:0}
.dshw-accountName{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,#e8e8ea);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
`;
		const STYLE_ID = "dsh-web3/wallet-panel.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(STYLE_ID) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-web3";
			tag.dataset.pluginCss = STYLE_ID;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}

		// ── locale dictionaries (DSH host language switch) ─────────────────
		const NS = "dsh-web3";
		const MESSAGES = {
			zh: {
				nav: "Web3",
				subtitle: "Agent 安全的 EVM 钱包",
				refresh: "刷新",
				loading: "正在加载钱包状态…",
				errorPrefix: "钱包端点不可用",
				errorHint: "（请确认钱包插件已挂载）",
				vault: "钱包保险库",
				accounts: "账户",
				autoLock: "自动锁定",
				directory: "数据目录",
				unlocked: "已解锁",
				locked: "已锁定",
				noAccounts: "还没有账户。创建或导入一个 EVM 钱包。",
				signPolicy: "签署策略",
				noRules: "无规则：所有请求回落到默认效果。",
				noAudit: "暂无审计记录。",
				recentActivity: "最近活动",
				createWallet: "创建钱包",
				importWallet: "导入钱包",
				create: "创建",
				import: "导入",
				cancel: "取消",
				addAccount: "添加账户",
				back: "返回",
				copy: "复制",
				copied: "已复制",
				optional: "（可选）",
				accountLabel: "账户标签",
				accountLabelPlaceholder: "例如：日常开销",
				words: "助记词数量",
				createTitle: "创建新钱包",
				createDesc: "生成一个新的 EVM 账户。创建后请立即备份助记词——它只显示一次。",
				createBtn: "创建并生成助记词",
				backupTitle: "保存你的助记词",
				backupDesc: "助记词只会显示一次。请抄写并离线保存，任何人拿到它都能控制你的资产。",
				backupNotice: "没有备份 = 资产丢失。保管好这一份助记词。",
				backupCheckbox: "我已在安全的地方保存好助记词",
				done: "完成",
				createdDone: "钱包已创建，账户已解锁。",
				revealDenied: "助记词显示请求未获批准，已隐藏。",
				createFailed: "创建失败",
				importTitle: "导入账户",
				importDesc: "将已有的 EVM 账户导入此钱包。密钥只保存在本机。",
				tabMnemonic: "助记词",
				tabPrivateKey: "私钥",
				tabKeystore: "Keystore",
				mnemonicPlaceholder: "输入 12/15/18/21/24 个英文单词，用空格分隔",
				privateKeyPlaceholder: "0x + 64 位十六进制私钥",
				keystorePlaceholder: "粘贴 keystore JSON 文本",
				keystorePassphrase: "Keystore 密码",
				keystorePassPlaceholder: "加密该 keystore 时使用的密码",
				labelOptional: "账户标签（可选）",
				importBtn: "导入账户",
				importEmpty: "请输入要导入的密钥内容",
				importPassEmpty: "Keystore 需要密码",
				importFailed: "导入失败",
				importDone: "账户已导入。",
				confirmImport: "确认导入",
			},
			en: {
				nav: "Web3",
				subtitle: "Agent-safe EVM wallet",
				refresh: "Refresh",
				loading: "Loading wallet state…",
				errorPrefix: "Wallet endpoints unavailable",
				errorHint: "(is the wallet plugin row mounted?)",
				vault: "Wallet vault",
				accounts: "Accounts",
				autoLock: "Auto-lock",
				directory: "Directory",
				unlocked: "unlocked",
				locked: "locked",
				noAccounts: "No accounts yet. Create or import an EVM wallet to get started.",
				signPolicy: "Signing policy",
				noRules: "No rules: every request falls back to the default effect.",
				noAudit: "No audit entries yet.",
				recentActivity: "Recent activity",
				createWallet: "Create wallet",
				importWallet: "Import wallet",
				create: "Create",
				import: "Import",
				cancel: "Cancel",
				addAccount: "Add account",
				back: "Back",
				copy: "Copy",
				copied: "Copied",
				optional: "(optional)",
				accountLabel: "Account label",
				accountLabelPlaceholder: "e.g. Daily spend",
				words: "Secret phrase",
				createTitle: "Create a new wallet",
				createDesc: "Generate a new EVM account. Back up the recovery phrase right away — it is shown only once.",
				createBtn: "Create & show recovery phrase",
				backupTitle: "Save your recovery phrase",
				backupDesc: "Your recovery phrase is shown only once. Write it down and store it offline; anyone with it can control your assets.",
				backupNotice: "No backup = lost assets. Keep this phrase safe.",
				backupCheckbox: "I saved my recovery phrase in a safe place",
				done: "Done",
				createdDone: "Wallet created and unlocked.",
				revealDenied: "The approval to reveal the recovery phrase was denied; it stays hidden.",
				createFailed: "Create failed",
				importTitle: "Import account",
				importDesc: "Import an existing EVM account into this wallet. Keys stay on this machine.",
				tabMnemonic: "Phrase",
				tabPrivateKey: "Private key",
				tabKeystore: "Keystore",
				mnemonicPlaceholder: "Enter 12/15/18/21/24 English words separated by spaces",
				privateKeyPlaceholder: "0x + 64 hex characters",
				keystorePlaceholder: "Paste the keystore JSON text",
				keystorePassphrase: "Keystore password",
				keystorePassPlaceholder: "Password used to encrypt this keystore",
				labelOptional: "Account label (optional)",
				importBtn: "Import account",
				importEmpty: "Enter the secret to import",
				importPassEmpty: "A keystore requires a password",
				importFailed: "Import failed",
				importDone: "Account imported.",
				confirmImport: "Confirm import",
			},
		};

		// `t` bound to the active locale; rebound on apply, read lazily so
		// label()/rebinds always see the current language.
		let t = (key) => key;

		// ── data fetching (host `web3` Remote namespace over Connection RPC) ──
		let connectionSvc = null;

		async function callHost(method, request) {
			if (connectionSvc === null) throw new Error("connection service not ready");
			const envelope = await connectionSvc.rpc.call("/api", "web3/" + method, {
				args: { request: request === undefined ? null : request },
			});
			if (envelope !== null && typeof envelope === "object" && envelope.ok === false) {
				throw new Error((envelope.error && envelope.error.message) || "rpc call failed");
			}
			if (envelope !== null && typeof envelope === "object" && envelope.ok === true) {
				return envelope.value;
			}
			return envelope;
		}

		function useWalletData() {
			const [state, setState] = React.useState({ loading: true, error: null, status: null, accounts: [], policy: null, audit: [] });
			const load = React.useCallback(async () => {
				try {
					const [status, accounts, policy, audit] = await Promise.all([
						callHost("status"),
						callHost("accounts"),
						callHost("policy"),
						callHost("audit"),
					]);
					setState({
						loading: false,
						error: null,
						status: status || null,
						accounts: (accounts && accounts.accounts) || [],
						policy: (policy && policy.policy) || null,
						audit: (audit && audit.entries) || [],
					});
				} catch (error) {
					setState({ loading: false, error: error instanceof Error ? error.message : String(error), status: null, accounts: [], policy: null, audit: [] });
				}
			}, []);
			React.useEffect(() => { void load(); }, [load]);
			return { state, reload: load };
		}

		function shortAddress(address) {
			return typeof address === "string" && address.length > 14 ? address.slice(0, 8) + "…" + address.slice(-6) : String(address);
		}

		function firstLetter(value) {
			const text = String(value || "");
			if (text.length === 0) return "?";
			const letter = text.trim().charAt(0);
			return /[a-zA-Z0-9]/.test(letter) ? letter.toUpperCase() : "#";
		}

		function copyText(text) {
			if (navigator.clipboard && navigator.clipboard.writeText) {
				return navigator.clipboard.writeText(text);
			}
			return new Promise((resolve, reject) => {
				const area = document.createElement("textarea");
				area.value = text;
				area.style.position = "fixed";
				area.style.opacity = "0";
				document.body.appendChild(area);
				area.select();
				try {
					document.execCommand("copy");
					resolve();
				} catch (error) {
					reject(error);
				} finally {
					document.body.removeChild(area);
				}
			});
		}

		function EffectBadge(props) {
			const effect = String(props.effect || "ask");
			return h("span", { className: "dshw-badge dshw-badge-" + effect }, effect);
		}

		function StatusCard(props) {
			const T = props.t;
			const status = props.status;
			if (!status) return null;
			return h("div", { className: "dshw-card" },
				h("div", { className: "dshw-head" },
					h("h3", { className: "dshw-cardTitle" }, T("vault")),
					h("span", { className: "dshw-badge " + (status.unlocked ? "dshw-badge-unlocked" : "dshw-badge-locked") }, status.unlocked ? T("unlocked") : T("locked")),
				),
				h("div", { className: "dshw-row" }, h("span", { className: "dshw-label" }, T("accounts")), h("span", { className: "dshw-mono" }, String(status.accountCount))),
				h("div", { className: "dshw-row" }, h("span", { className: "dshw-label" }, T("autoLock")), h("span", { className: "dshw-mono" }, String(Math.round((status.autoLockMs || 0) / 60000)) + " min idle")),
				h("div", { className: "dshw-row" }, h("span", { className: "dshw-label" }, T("directory")), h("span", { className: "dshw-mono" }, String(status.directory || ""))),
			);
		}

		function AccountRow(props) {
			const T = props.t;
			const account = props.account;
			const avatarStyle = {};
			const palette = ["#2f6fed", "#7c3aed", "#0ea5e9", "#059669", "#d97706", "#db2777"];
			let hash = 0;
			const seed = String(account.id || account.address || "");
			for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
			avatarStyle["--dshw-avatar-bg"] = "color-mix(in srgb, " + palette[hash % palette.length] + " 18%, var(--dsw-alias-bg-base,#17181c))";
			return h("div", { className: "dshw-accountRow", key: account.id },
				h("div", { className: "dshw-avatar", style: avatarStyle }, firstLetter(account.label || account.address || account.id)),
				h("div", { className: "dshw-accountBody" },
					h("div", { className: "dshw-accountName" }, String(account.label || shortAddress(account.address))),
					h("div", { className: "dshw-mono", title: account.address }, shortAddress(account.address)),
				),
				h("span", { className: "dshw-badge dshw-badge-source" }, String(account.source || "")),
			);
		}

		function AccountsCard(props) {
			const T = props.t;
			const accounts = props.accounts;
			return h("div", { className: "dshw-card" },
				h("div", { className: "dshw-head" },
					h("h3", { className: "dshw-cardTitle" }, T("accounts")),
					h("div", { style: { display: "flex", gap: "6px" } },
						h("button", { className: "dshw-btn dshw-btnGhost", onClick: props.onCreate }, "+ " + T("create")),
						h("button", { className: "dshw-btn dshw-btnGhost", onClick: props.onImport }, "+ " + T("import")),
					),
				),
				accounts.length === 0
					? h("div", { className: "dshw-empty" }, T("noAccounts"))
					: accounts.map((account) => h(AccountRow, { key: account.id, account: account, t: T })),
			);
		}

		function PolicyCard(props) {
			const T = props.t;
			const policy = props.policy;
			if (!policy) return null;
			const rules = policy.rules || [];
			return h("div", { className: "dshw-card" },
				h("div", { className: "dshw-head" },
					h("h3", { className: "dshw-cardTitle" }, T("signPolicy")),
					h(EffectBadge, { effect: policy.defaultEffect }),
				),
				rules.length === 0
					? h("div", { className: "dshw-empty" }, T("noRules"))
					: rules.map((rule) =>
						h("div", { className: "dshw-row", key: rule.id },
							h("span", { className: "dshw-label" }, String(rule.id)),
							h(EffectBadge, { effect: rule.effect }),
							h("span", { className: "dshw-mono" }, String(rule.description || "")),
						),
					),
			);
		}

		function AuditCard(props) {
			const T = props.t;
			const entries = (props.audit || []).slice(0, 12);
			return h("div", { className: "dshw-card" },
				h("h3", { className: "dshw-cardTitle" }, T("recentActivity")),
				entries.length === 0
					? h("div", { className: "dshw-empty" }, T("noAudit"))
					: entries.map((entry, index) =>
						h("div", { className: "dshw-row", key: String(entry.ts) + "-" + String(index) },
							h("span", { className: "dshw-auditTime" }, new Date(entry.ts).toLocaleString()),
							h("span", { className: "dshw-auditKind" }, String(entry.kind)),
							h("span", { className: "dshw-mono" }, summarizeDetail(entry.detail)),
						),
					),
			);
		}

		function summarizeDetail(detail) {
			if (!detail || typeof detail !== "object") return "";
			const parts = [];
			if (detail.effect !== undefined) parts.push("effect=" + String(detail.effect));
			if (detail.address !== undefined) parts.push(shortAddress(detail.address));
			if (detail.chainId !== undefined) parts.push("chain=" + String(detail.chainId));
			if (detail.to !== undefined) parts.push("to=" + shortAddress(detail.to));
			if (detail.valueWei !== undefined && detail.valueWei !== "0") parts.push("value=" + String(detail.valueWei) + "wei");
			if (detail.txHash !== undefined) parts.push("tx=" + shortAddress(detail.txHash));
			if (detail.outcome !== undefined) parts.push("outcome=" + String(detail.outcome));
			if (detail.source !== undefined) parts.push("source=" + String(detail.source));
			return parts.join(" ");
		}

		// ── Metamask-style flows ─────────────────────────────────────────
		function FlowShell(props) {
			const T = props.t;
			return h("div", { className: "dshw-root" },
				h("div", { className: "dshw-head" },
					h("div", { className: "dshw-mono" }, "dsh-web3"),
					h("button", { className: "dshw-btn dshw-btnGhost", onClick: props.onBack }, "← " + T("back")),
				),
				props.children,
			);
		}

		function CopyButton(props) {
			const T = props.t;
			const [copied, setCopied] = React.useState(false);
			const onClick = () => {
				copyText(props.text).then(() => {
					setCopied(true);
					setTimeout(() => setCopied(false), 1400);
				}).catch(() => {});
			};
			return h("button", { className: "dshw-btn dshw-btnGhost", onClick: onClick }, copied ? T("copied") : T("copy"));
		}

		function CreateWalletFlow(props) {
			const T = props.t;
			const [step, setStep] = React.useState("form");
			const [label, setLabel] = React.useState("");
			const [words, setWords] = React.useState("12");
			const [busy, setBusy] = React.useState(false);
			const [error, setError] = React.useState(null);
			const [phrase, setPhrase] = React.useState([]);
			const [saved, setSaved] = React.useState(false);

			const run = async () => {
				setBusy(true);
				setError(null);
				try {
					const result = await callHost("create", {
						label: label.trim() || undefined,
						words: Number(words),
						reveal: true,
					});
					if (result && typeof result === "object" && result.ok === false) {
						throw new Error(result.error || T("createFailed"));
					}
					if (result && result.mnemonicRevealed === true && typeof result.mnemonic === "string") {
						setPhrase(result.mnemonic.split(" "));
						setStep("phrase");
					} else {
						setError(T("revealDenied"));
					}
				} catch (e) {
					setError((e && e.message) || T("createFailed"));
				} finally {
					setBusy(false);
				}
			};

			const finish = () => {
				props.onDone();
			};

			if (step === "phrase") {
				return h(FlowShell, { t: T, onBack: props.onBack },
					h("div", { className: "dshw-card" },
						h("h3", { className: "dshw-cardTitle" }, T("backupTitle")),
						h("p", { style: { margin: "0 0 4px" } }, T("backupDesc")),
						h("div", { className: "dshw-note" }, T("backupNotice")),
						h("div", { className: "dshw-actions", style: { justifyContent: "flex-start", marginTop: 0 } },
							h(CopyButton, { t: T, text: phrase.join(" ") }),
						),
						h("div", { className: "dshw-wordGrid" },
							phrase.map((word, index) =>
								h("div", { className: "dshw-wordCell", key: index },
									h("span", { className: "dshw-wordIndex" }, String(index + 1)),
									h("span", null, word),
								),
							),
						),
						h("label", { style: { display: "flex", alignItems: "center", gap: "8px", cursor: "pointer", fontSize: "13px" } },
							h("input", { type: "checkbox", checked: saved, onChange: (e) => setSaved(e.target.checked) }),
							T("backupCheckbox"),
						),
						h("div", { className: "dshw-actions" },
							h("button", { className: "dshw-btnPrimary dshw-btnWide", disabled: !saved, onClick: finish }, T("done")),
						),
					),
				);
			}

			return h(FlowShell, { t: T, onBack: props.onBack },
				h("div", { className: "dshw-card" },
					h("h3", { className: "dshw-cardTitle" }, T("createTitle")),
					h("p", { style: { margin: "0 0 14px", color: "var(--dsw-alias-label-secondary,#b0b2b8)" } }, T("createDesc")),
					h("div", { className: "dshw-field" },
						h("label", { className: "dshw-fieldLabel" }, T("accountLabel") + " " + T("optional")),
						h("input", { className: "dshw-input", value: label, placeholder: T("accountLabelPlaceholder"), onChange: (e) => setLabel(e.target.value) }),
					),
					h("div", { className: "dshw-field" },
						h("label", { className: "dshw-fieldLabel" }, T("words")),
						h("select", { className: "dshw-input", value: words, onChange: (e) => setWords(e.target.value) },
							["12", "15", "18", "21", "24"].map((n) => h("option", { key: n, value: n }, n + " words")),
						),
					),
					error ? h("div", { className: "dshw-error" }, error) : null,
					h("div", { className: "dshw-actions" },
						h("button", { className: "dshw-btnPrimary dshw-btnWide", disabled: busy, onClick: () => void run() }, busy ? "…" : T("createBtn")),
					),
					h("div", { className: "dshw-caption", style: { marginTop: "10px", textAlign: "center" } }, T("subtitle")),
				),
			);
		}

		function ImportWalletFlow(props) {
			const T = props.t;
			const [tab, setTab] = React.useState("mnemonic");
			const [secret, setSecret] = React.useState("");
			const [pass, setPass] = React.useState("");
			const [label, setLabel] = React.useState("");
			const [busy, setBusy] = React.useState(false);
			const [error, setError] = React.useState(null);

			const run = async () => {
				if (!secret.trim()) {
					setError(T("importEmpty"));
					return;
				}
				if (tab === "keystore" && !pass) {
					setError(T("importPassEmpty"));
					return;
				}
				setBusy(true);
				setError(null);
				try {
					const payload = { source: tab, secret: secret.trim(), label: label.trim() || undefined };
					if (tab === "keystore") payload.keystorePassphrase = pass;
					const result = await callHost("import", payload);
					if (result && typeof result === "object" && result.ok === false) {
						throw new Error(result.error || T("importFailed"));
					}
					props.onDone(result);
				} catch (e) {
					setError((e && e.message) || T("importFailed"));
				} finally {
					setBusy(false);
				}
			};

			return h(FlowShell, { t: T, onBack: props.onBack },
				h("div", { className: "dshw-card" },
					h("h3", { className: "dshw-cardTitle" }, T("importTitle")),
					h("p", { style: { margin: "0 0 12px", color: "var(--dsw-alias-label-secondary,#b0b2b8)" } }, T("importDesc")),
					h("div", { className: "dshw-tabs" },
						["mnemonic", "privateKey", "keystore"].map((name) =>
							h("button", {
								key: name,
								className: "dshw-tab" + (tab === name ? " dshw-tabActive" : ""),
								onClick: () => { setTab(name); setError(null); },
							}, T("tab" + name.charAt(0).toUpperCase() + name.slice(1))),
						),
					),
					tab === "mnemonic"
						? h("div", { className: "dshw-field" },
							h("label", { className: "dshw-fieldLabel" }, T("tabMnemonic")),
							h("textarea", { className: "dshw-textarea", value: secret, placeholder: T("mnemonicPlaceholder"), onChange: (e) => setSecret(e.target.value) }),
						)
						: null,
					tab === "privateKey"
						? h("div", { className: "dshw-field" },
							h("label", { className: "dshw-fieldLabel" }, T("tabPrivateKey")),
							h("input", { className: "dshw-input", value: secret, placeholder: T("privateKeyPlaceholder"), onChange: (e) => setSecret(e.target.value) }),
						)
						: null,
					tab === "keystore"
						? h("div", null,
							h("div", { className: "dshw-field" },
								h("label", { className: "dshw-fieldLabel" }, T("tabKeystore")),
								h("textarea", { className: "dshw-textarea", value: secret, placeholder: T("keystorePlaceholder"), onChange: (e) => setSecret(e.target.value) }),
							),
							h("div", { className: "dshw-field" },
								h("label", { className: "dshw-fieldLabel" }, T("keystorePassphrase")),
								h("input", { className: "dshw-input", type: "password", value: pass, placeholder: T("keystorePassPlaceholder"), onChange: (e) => setPass(e.target.value) }),
							),
						)
						: null,
					h("div", { className: "dshw-field" },
						h("label", { className: "dshw-fieldLabel" }, T("accountLabel") + " " + T("optional")),
						h("input", { className: "dshw-input", value: label, placeholder: T("accountLabelPlaceholder"), onChange: (e) => setLabel(e.target.value) }),
					),
					error ? h("div", { className: "dshw-error" }, error) : null,
					h("div", { className: "dshw-actions" },
						h("button", { className: "dshw-btnPrimary dshw-btnWide", disabled: busy, onClick: () => void run() }, busy ? "…" : T("importBtn")),
					),
				),
			);
		}

		function OnboardingScreen(props) {
			const T = props.t;
			return h("div", { className: "dshw-root" },
				h("div", { className: "dshw-card" },
					h("div", { className: "dshw-hero" },
						h("div", { className: "dshw-logo" }, "3"),
						h("h2", { className: "dshw-heroTitle" }, "dsh-web3"),
						h("p", { className: "dshw-heroSub" }, T("subtitle")),
						h("div", { className: "dshw-heroActions" },
							h("button", { className: "dshw-btnPrimary dshw-btnWide", onClick: props.onCreate }, T("createWallet")),
							h("button", { className: "dshw-btn dshw-btnWide", onClick: props.onImport }, T("importWallet")),
						),
					),
				),
			);
		}

		function Dashboard(props) {
			const T = props.t;
			const state = props.state;
			return h(React.Fragment, null,
				h(AccountsCard, { accounts: state.accounts, onCreate: props.onCreate, onImport: props.onImport, t: T }),
				h("div", { className: "dshw-caption", style: { margin: "-8px 2px 0" } }, T("subtitle")),
				h(PolicyCard, { policy: state.policy, t: T }),
				h(StatusCard, { status: state.status, t: T }),
				h(AuditCard, { audit: state.audit, t: T }),
			);
		}

		function WalletPanel(props) {
			const T = (props && typeof props.t === "function") ? props.t : t;
			const { state, reload } = useWalletData();
			const [view, setView] = React.useState(null);
			const empty = !state.loading && !state.error && state.accounts.length === 0;
			const showCreate = () => setView("create");
			const showImport = () => setView("import");
			const back = () => setView(null);
			const done = () => { setView(null); void reload(); };

			if (view === "create") return h(CreateWalletFlow, { t: T, onBack: back, onDone: done });
			if (view === "import") return h(ImportWalletFlow, { t: T, onBack: back, onDone: done });

			if (empty) return h(OnboardingScreen, { t: T, onCreate: showCreate, onImport: showImport });
			if (state.loading) return h("div", { className: "dshw-root" }, h("div", { className: "dshw-empty" }, T("loading")));
			if (state.error) return h("div", { className: "dshw-root" },
				h("div", { className: "dshw-error" }, T("errorPrefix") + ": " + String(state.error) + " " + T("errorHint")),
				h("button", { className: "dshw-btn", onClick: () => void reload() }, T("refresh")),
			);

			return h("div", { className: "dshw-root" },
				h("div", { className: "dshw-head" },
					h("div", { className: "dshw-mono" }, "dsh-web3"),
					h("button", { className: "dshw-btn", onClick: () => void reload() }, T("refresh")),
				),
				h(Dashboard, { state: state, onCreate: showCreate, onImport: showImport, t: T }),
			);
		}

		// ── plugin wiring ─────────────────────────────────────────────────
		const inject = ["connection", "slots", "locale"];

		function apply(c) {
			connectionSvc = c.get ? c.get("connection") : undefined;
			const slots = c.get ? c.get("slots") : c.slots;
			if (slots === undefined) return;
			if (c.locale && typeof c.locale.register === "function") {
				c.effect(() => c.locale.register(NS, MESSAGES), "dsh-web3: dictionaries");
				if (typeof c.locale.bind === "function") t = c.locale.bind(NS);
			} else {
				// Locale service unavailable: keep key fallbacks.
				t = (key) => (MESSAGES.en[key] !== undefined ? MESSAGES.en[key] : key);
			}
			slots.inject("settings.section", () => slots.register({
				name: "settings.section",
				id: "web3",
				order: 250,
				label: () => t("nav"),
				locale: NS,
			}, WalletPanel));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
