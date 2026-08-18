Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
let react = require("react");
let react_jsx_runtime = require("react/jsx-runtime");
//#region src/client/PiLoginSettings.tsx
/** Plugin-owned Pi login page inside the dsh Settings shell. */
const STATUS_PATH = "/plugins/dsh-oauth-login/auth/status";
const LOGIN_PATH = "/plugins/dsh-oauth-login/auth/login";
const LOGOUT_PATH = "/plugins/dsh-oauth-login/auth/logout";
const POLL_INTERVAL_MS = 1e3;
const STYLE_ID = "dsh-pi-login-settings-theme";
/**
* Theme tokens that track light/dark. Hardcoded white/layer fills break dark mode.
* Mirrors ModelsSection button vocabulary so OAuth cards match the rest of Settings.
*/
const SETTINGS_CSS = `
.dsh-pi-login-page { display:flex; flex-direction:column; gap:16px; max-width:640px; color:var(--dsw-alias-label-primary); }
.dsh-pi-login-title { margin:0; font-size:20px; line-height:28px; font-weight:600; color:var(--dsw-alias-label-primary); }
.dsh-pi-login-body { margin:0; font-size:13px; line-height:20px; color:var(--dsw-alias-label-secondary); }
.dsh-pi-login-error { margin:0; font-size:13px; line-height:20px; color:var(--dsw-alias-state-error-primary); }
.dsh-pi-login-stack { display:flex; flex-direction:column; gap:10px; }
.dsh-pi-login-card {
  display:flex; flex-direction:column; gap:8px; padding:14px 16px;
  border:1px solid var(--dsw-alias-border-l2); border-radius:12px;
  background:var(--dsw-alias-bg-module-platform);
}
.dsh-pi-login-row { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:10px; }
.dsh-pi-login-name { margin:0; font-size:15px; font-weight:600; color:var(--dsw-alias-label-primary); }
.dsh-pi-login-status { display:flex; align-items:center; flex-wrap:wrap; gap:6px; font-size:13px; color:var(--dsw-alias-label-secondary); }
.dsh-pi-login-dot { width:8px; height:8px; border-radius:50%; flex:0 0 auto; background:var(--dsw-alias-label-dimmed, #9aa0a6); }
.dsh-pi-login-dot.is-signed-in { background:var(--dsw-alias-state-success-primary, #22a06b); }
.dsh-pi-login-dot.is-error { background:var(--dsw-alias-state-error-primary, #d92d20); }
.dsh-pi-login-dot.is-signing-in { background:var(--dsw-alias-brand-primary, #1677ff); }
.dsh-pi-login-sep { color:var(--dsw-alias-label-dimmed, #9aa0a6); }
.dsh-pi-login-btn {
  box-sizing:border-box; display:inline-flex; align-items:center; justify-content:center;
  min-height:32px; padding:4px 14px; border-radius:16px; font:inherit; font-size:13px; line-height:20px; cursor:pointer;
}
.dsh-pi-login-btn:disabled { opacity:0.55; cursor:not-allowed; }
.dsh-pi-login-btn-secondary {
  border:1px solid var(--dsw-alias-border-l2);
  background:transparent;
  color:var(--dsw-alias-label-primary);
}
.dsh-pi-login-btn-secondary:hover:not(:disabled) {
  background:var(--dsw-alias-interactive-bg-hover);
}
.dsh-pi-login-btn-primary {
  border:none;
  background:var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary));
  color:var(--dsw-alias-label-primary-foreground, #fff);
}
.dsh-pi-login-btn-primary:hover:not(:disabled) {
  background:var(--dsw-alias-button-primary-hover, var(--dsw-alias-brand-primary));
}
.dsh-pi-login-code {
  font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size:18px; letter-spacing:0.08em; font-weight:600; color:var(--dsw-alias-label-primary);
}
.dsh-pi-login-link { color:var(--dsw-alias-brand-primary); word-break:break-all; }
`;
function ensureThemeStyles() {
	if (typeof document === "undefined") return;
	if (document.getElementById(STYLE_ID) !== null) return;
	const style = document.createElement("style");
	style.id = STYLE_ID;
	style.textContent = SETTINGS_CSS;
	document.head.appendChild(style);
}
async function jsonRequest(path, method = "GET", body) {
	const response = await fetch(path, {
		method,
		headers: {
			accept: "application/json",
			...body === void 0 ? {} : { "content-type": "application/json" }
		},
		credentials: "same-origin",
		...body === void 0 ? {} : { body: JSON.stringify(body) }
	});
	const value = await response.json().catch(() => void 0);
	if (!response.ok) {
		const message = typeof value === "object" && value !== null && "error" in value && typeof value.error === "string" ? value.error : `HTTP ${response.status}`;
		throw new Error(message);
	}
	return value;
}
function PiLoginSettings({ t }) {
	if (t === void 0) throw new Error("Pi login settings requires its translation function");
	const [providers, setProviders] = (0, react.useState)(void 0);
	const [error, setError] = (0, react.useState)(void 0);
	const [busy, setBusy] = (0, react.useState)(void 0);
	(0, react.useEffect)(() => {
		ensureThemeStyles();
	}, []);
	const refresh = (0, react.useCallback)(async () => {
		try {
			setProviders(await jsonRequest(STATUS_PATH));
			setError(void 0);
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : t("requestFailed"));
		}
	}, [t]);
	(0, react.useEffect)(() => {
		refresh();
	}, [refresh]);
	const signing = providers?.some((provider) => provider.account.status === "signing-in") ?? false;
	(0, react.useEffect)(() => {
		if (!signing) return;
		const timer = window.setInterval(() => {
			refresh();
		}, POLL_INTERVAL_MS);
		return () => {
			window.clearInterval(timer);
		};
	}, [refresh, signing]);
	const signIn = async (id) => {
		const popup = window.open("about:blank", "_blank");
		if (popup !== null) popup.opener = null;
		setBusy(id);
		try {
			const challenge = await jsonRequest(LOGIN_PATH, "POST", { provider: id });
			if (popup === null) {
				await refresh();
				return;
			}
			popup.location.replace(challenge.url);
			await refresh();
		} catch (caught) {
			popup?.close();
			setError(caught instanceof Error ? caught.message : t("requestFailed"));
		} finally {
			setBusy(void 0);
		}
	};
	const signOut = async (id) => {
		setBusy(id);
		try {
			await jsonRequest(LOGOUT_PATH, "POST", { provider: id });
			await refresh();
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : t("requestFailed"));
		} finally {
			setBusy(void 0);
		}
	};
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
		className: "dsh-pi-login-page",
		"aria-labelledby": "pi-login-settings-title",
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
				id: "pi-login-settings-title",
				className: "dsh-pi-login-title",
				children: t("title")
			}),
			error !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				className: "dsh-pi-login-error",
				children: error
			}) : null,
			providers === void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				className: "dsh-pi-login-body",
				children: t("loadingAccount")
			}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "dsh-pi-login-stack",
				children: providers.map((provider) => {
					const account = provider.account;
					const label = account.status === "signed-in" ? t("signedIn") : account.status === "signing-in" ? t("signingIn") : account.status === "error" ? t("requestFailed") : t("signedOut");
					const dotClass = account.status === "signed-in" ? "dsh-pi-login-dot is-signed-in" : account.status === "error" ? "dsh-pi-login-dot is-error" : account.status === "signing-in" ? "dsh-pi-login-dot is-signing-in" : "dsh-pi-login-dot";
					const expires = account.status === "signed-in" && account.expiresAt !== void 0 ? new Date(account.expiresAt).toLocaleString() : void 0;
					return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("article", {
						className: "dsh-pi-login-card",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dsh-pi-login-row",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: "dsh-pi-login-name",
									children: provider.displayName
								}), account.status === "signed-in" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "dsh-pi-login-btn dsh-pi-login-btn-secondary",
									disabled: busy !== void 0,
									onClick: () => {
										signOut(provider.id);
									},
									children: busy === provider.id ? t("working") : t("logout")
								}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "dsh-pi-login-btn dsh-pi-login-btn-primary",
									disabled: busy !== void 0,
									onClick: () => {
										signIn(provider.id);
									},
									children: busy === provider.id ? t("working") : account.status === "error" ? t("loginAgain") : t("login")
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dsh-pi-login-status",
								role: "status",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										"aria-hidden": "true",
										className: dotClass
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: label }),
									expires !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "dsh-pi-login-sep",
										"aria-hidden": "true",
										children: "·"
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
										t("expires"),
										" ",
										expires
									] })] }) : null
								]
							}),
							account.status === "error" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "dsh-pi-login-error",
								children: account.message
							}) : null,
							account.status === "signing-in" && account.userCode !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
								className: "dsh-pi-login-body",
								children: [
									t("userCode"),
									" ",
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "dsh-pi-login-code",
										children: account.userCode
									})
								]
							}) : null,
							account.status === "signing-in" && account.url !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
								className: "dsh-pi-login-body",
								children: [
									t("openUrl"),
									" ",
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("a", {
										href: account.url,
										target: "_blank",
										rel: "noreferrer",
										className: "dsh-pi-login-link",
										children: account.url
									})
								]
							}) : null
						]
					}, provider.id);
				})
			})
		]
	});
}
//#endregion
//#region src/client/locales.ts
const en = {
	nav: "OAuth Login",
	title: "OAuth Login",
	loadingAccount: "Loading accounts…",
	signedOut: "Not signed in",
	signingIn: "Waiting for authorization…",
	signedIn: "Signed in",
	login: "Sign in",
	loginAgain: "Sign in again",
	logout: "Sign out",
	working: "Working…",
	userCode: "Code",
	openUrl: "Authorize",
	requestFailed: "The login request failed.",
	expires: "Expires"
};
const zh = {
	nav: "OAuth 登录",
	title: "OAuth 登录",
	loadingAccount: "正在加载账户…",
	signedOut: "尚未登录",
	signingIn: "正在等待授权…",
	signedIn: "已登录",
	login: "登录",
	loginAgain: "重新登录",
	logout: "退出",
	working: "处理中…",
	userCode: "授权码",
	openUrl: "授权",
	requestFailed: "登录请求失败。",
	expires: "到期"
};
//#endregion
//#region src/client/index.tsx
const name = "dsh-oauth-login-client";
const inject = ["slots", "locale"];
function apply(ctx) {
	const namespace = "settings.pi-login";
	ctx.effect(() => ctx.locale.register(namespace, {
		zh,
		en
	}), "dsh-oauth-login: settings copy");
	const t = ctx.locale.bind(namespace);
	ctx.slots.inject("settings.section", () => ctx.slots.register({
		name: "settings.section",
		id: "pi-login",
		order: 17,
		label: () => t("nav"),
		inject: () => ({ t })
	}, PiLoginSettings));
}
//#endregion
exports.apply = apply;
exports.inject = inject;
exports.name = name;
