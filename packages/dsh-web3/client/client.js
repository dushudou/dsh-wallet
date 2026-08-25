window.__ModuleLoader__.load({
	id: "dsh-web3",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const React = require("react");
		const h = React.createElement;

		// ── styles (theme-variable driven, injected once) ─────────────────
		const CSS = `
.dshw-root{display:flex;flex-direction:column;gap:16px;padding:4px 2px;font-size:13px;color:var(--dsw-alias-label-primary,#e8e8e8)}
.dshw-card{border:1px solid var(--dsw-alias-border-l1,#3a3a3a);background:var(--dsw-alias-bg-base,#1f1f1f);border-radius:10px;padding:14px 16px}
.dshw-cardTitle{font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--dsw-alias-label-tertiary,#9a9a9a);margin:0 0 10px}
.dshw-row{display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--dsw-alias-border-l1,#2c2c2c)}
.dshw-row:last-child{border-bottom:none}
.dshw-label{font-weight:500;min-width:110px}
.dshw-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:var(--dsw-alias-label-secondary,#c8c8c8);word-break:break-all}
.dshw-badge{display:inline-block;padding:1px 8px;border-radius:999px;font-size:11px;font-weight:600}
.dshw-badge-allow{background:rgba(46,160,67,.18);color:#3fb950}
.dshw-badge-deny{background:rgba(248,81,73,.16);color:#f85149}
.dshw-badge-ask{background:rgba(210,153,34,.16);color:#d29922}
.dshw-badge-locked{background:rgba(248,81,73,.16);color:#f85149}
.dshw-badge-unlocked{background:rgba(46,160,67,.18);color:#3fb950}
.dshw-btn{border:1px solid var(--dsw-alias-border-l2,#4a4a4a);background:var(--dsw-alias-interactive-bg-hover,#2a2a2a);color:var(--dsw-alias-label-primary,#e8e8e8);border-radius:6px;padding:4px 12px;font-size:12px;cursor:pointer}
.dshw-btn:hover{border-color:var(--dsw-alias-state-business-primary,#4a9eff)}
.dshw-empty{color:var(--dsw-alias-label-caption,#8a8a8a);font-style:italic;padding:6px 0}
.dshw-error{color:var(--dsw-alias-state-error-primary,#f85149);padding:6px 0}
.dshw-auditKind{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:var(--dsw-alias-label-secondary,#c8c8c8)}
.dshw-auditTime{font-size:11px;color:var(--dsw-alias-label-caption,#8a8a8a);min-width:130px}
.dshw-head{display:flex;align-items:center;justify-content:space-between;gap:10px}
`;
		const STYLE_ID = "dsh-web3/wallet-panel.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(STYLE_ID) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-web3";
			tag.dataset.pluginCss = STYLE_ID;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}

		// ── data fetching (read-only same-origin endpoints) ───────────────
		async function fetchJson(path) {
			const res = await fetch(path, { headers: { accept: "application/json" } });
			if (!res.ok) throw new Error(path + " -> HTTP " + String(res.status));
			return await res.json();
		}

		function useWalletData() {
			const [state, setState] = React.useState({ loading: true, error: null, status: null, accounts: [], policy: null, audit: [] });
			const load = React.useCallback(async () => {
				try {
					const [status, accounts, policy, audit] = await Promise.all([
						fetchJson("/api/dsh-web3/status"),
						fetchJson("/api/dsh-web3/accounts"),
						fetchJson("/api/dsh-web3/policy"),
						fetchJson("/api/dsh-web3/audit"),
					]);
					setState({ loading: false, error: null, status, accounts: accounts.accounts || [], policy: policy.policy || null, audit: audit.entries || [] });
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

		function EffectBadge(props) {
			const effect = String(props.effect || "ask");
			return h("span", { className: "dshw-badge dshw-badge-" + effect }, effect);
		}

		function StatusCard(props) {
			const status = props.status;
			if (!status) return null;
			return h("div", { className: "dshw-card" },
				h("div", { className: "dshw-head" },
					h("h3", { className: "dshw-cardTitle" }, "Vault"),
					h("span", { className: "dshw-badge " + (status.unlocked ? "dshw-badge-unlocked" : "dshw-badge-locked") }, status.unlocked ? "unlocked" : "locked"),
				),
				h("div", { className: "dshw-row" }, h("span", { className: "dshw-label" }, "Accounts"), h("span", { className: "dshw-mono" }, String(status.accountCount))),
				h("div", { className: "dshw-row" }, h("span", { className: "dshw-label" }, "Auto-lock"), h("span", { className: "dshw-mono" }, String(Math.round((status.autoLockMs || 0) / 60000)) + " min idle")),
				h("div", { className: "dshw-row" }, h("span", { className: "dshw-label" }, "Directory"), h("span", { className: "dshw-mono" }, String(status.directory || ""))),
			);
		}

		function AccountsCard(props) {
			const accounts = props.accounts;
			return h("div", { className: "dshw-card" },
				h("h3", { className: "dshw-cardTitle" }, "Accounts"),
				accounts.length === 0
					? h("div", { className: "dshw-empty" }, "No accounts yet. Ask the agent to run wallet_create or wallet_import.")
					: accounts.map((account) =>
						h("div", { className: "dshw-row", key: account.id },
							h("span", { className: "dshw-label" }, String(account.label || "")),
							h("span", { className: "dshw-mono", title: account.address }, shortAddress(account.address)),
							h("span", { className: "dshw-badge dshw-badge-ask" }, String(account.source || "")),
						),
					),
			);
		}

		function PolicyCard(props) {
			const policy = props.policy;
			if (!policy) return null;
			const rules = policy.rules || [];
			return h("div", { className: "dshw-card" },
				h("div", { className: "dshw-head" },
					h("h3", { className: "dshw-cardTitle" }, "Signing policy"),
					h(EffectBadge, { effect: policy.defaultEffect }),
				),
				rules.length === 0
					? h("div", { className: "dshw-empty" }, "No rules: every request falls back to the default effect.")
					: rules.map((rule) =>
						h("div", { className: "dshw-row", key: rule.id },
							h("span", { className: "dshw-label" }, String(rule.id)),
							h(EffectBadge, { effect: rule.effect }),
							h("span", { className: "dshw-mono" }, String(rule.description || "")),
						),
					),
				h("div", { className: "dshw-row" },
					h("span", { className: "dshw-label" }, "Updated"),
					h("span", { className: "dshw-mono" }, String(policy.updatedAt || "")),
				),
			);
		}

		function AuditCard(props) {
			const entries = (props.audit || []).slice(0, 12);
			return h("div", { className: "dshw-card" },
				h("h3", { className: "dshw-cardTitle" }, "Recent activity"),
				entries.length === 0
					? h("div", { className: "dshw-empty" }, "No audit entries yet.")
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

		function WalletPanel() {
			const { state, reload } = useWalletData();
			return h("div", { className: "dshw-root" },
				h("div", { className: "dshw-head" },
					h("div", { className: "dshw-mono" }, "dsh-web3 — agent-safe EVM wallet"),
					h("button", { className: "dshw-btn", onClick: () => void reload() }, "Refresh"),
				),
				state.loading ? h("div", { className: "dshw-empty" }, "Loading wallet state…") : null,
				state.error ? h("div", { className: "dshw-error" }, "Wallet endpoints unavailable: " + String(state.error) + " (is the wallet plugin row mounted?)") : null,
				!state.loading && !state.error ? h(React.Fragment, null,
					h(StatusCard, { status: state.status }),
					h(AccountsCard, { accounts: state.accounts }),
					h(PolicyCard, { policy: state.policy }),
					h(AuditCard, { audit: state.audit }),
				) : null,
			);
		}

		// ── plugin wiring ─────────────────────────────────────────────────
		const inject = ["slots"];

		function apply(ctx) {
			const slots = ctx.get ? ctx.get("slots") : ctx.slots;
			if (slots === undefined) return;
			slots.inject("settings.section", () => slots.register({
				name: "settings.section",
				id: "dsh-web3",
				order: 250,
				label: "Wallet",
			}, WalletPanel));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
