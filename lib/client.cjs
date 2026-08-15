Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
let react = require("react");
let react_jsx_runtime = require("react/jsx-runtime");
//#region src/client/PiLoginSettings.tsx
/** Plugin-owned Pi login page inside the dsh Settings shell. */
const STATUS_PATH = "/plugins/dsh-pi-login/auth/status";
const LOGIN_PATH = "/plugins/dsh-pi-login/auth/login";
const LOGOUT_PATH = "/plugins/dsh-pi-login/auth/logout";
const POLL_INTERVAL_MS = 1e3;
const pageStyle = {
	display: "flex",
	flexDirection: "column",
	gap: 18,
	maxWidth: 760
};
const titleStyle = {
	margin: 0,
	fontSize: 20,
	lineHeight: "28px",
	fontWeight: 600,
	color: "var(--dsw-alias-label-primary)"
};
const bodyStyle = {
	margin: 0,
	fontSize: 14,
	lineHeight: "22px",
	color: "var(--dsw-alias-label-secondary)"
};
const cardStyle = {
	display: "flex",
	flexDirection: "column",
	gap: 12,
	padding: "16px 18px",
	border: "1px solid var(--dsw-alias-border-l2)",
	borderRadius: 12,
	background: "var(--dsw-alias-bg-module-platform)"
};
const rowStyle = {
	display: "flex",
	alignItems: "center",
	justifyContent: "space-between",
	flexWrap: "wrap",
	gap: 12
};
const statusStyle = {
	display: "flex",
	alignItems: "center",
	gap: 9,
	fontSize: 15,
	fontWeight: 500,
	color: "var(--dsw-alias-label-primary)"
};
const buttonStyle = {
	boxSizing: "border-box",
	minHeight: 34,
	padding: "6px 14px",
	border: "1px solid var(--dsw-alias-border-l2)",
	borderRadius: 18,
	background: "var(--dsw-alias-bg-layer-1)",
	color: "var(--dsw-alias-label-primary)",
	font: "inherit",
	fontSize: 14,
	cursor: "pointer"
};
const primaryButtonStyle = {
	...buttonStyle,
	borderColor: "var(--dsw-alias-brand-primary)",
	background: "var(--dsw-alias-brand-primary)",
	color: "white"
};
const errorStyle = {
	...bodyStyle,
	color: "var(--dsw-alias-state-error-primary)"
};
const codeStyle = {
	fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
	fontSize: 20,
	letterSpacing: "0.08em",
	fontWeight: 600,
	color: "var(--dsw-alias-label-primary)"
};
const linkStyle = {
	color: "var(--dsw-alias-brand-primary)",
	wordBreak: "break-all"
};
const listStyle = {
	display: "flex",
	flexWrap: "wrap",
	gap: 8,
	margin: 0,
	padding: 0,
	listStyle: "none"
};
const chipStyle = {
	fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
	fontSize: 12,
	padding: "4px 8px",
	borderRadius: 8,
	background: "var(--dsw-alias-bg-layer-3)",
	color: "var(--dsw-alias-label-primary)"
};
const nameStyle = {
	margin: 0,
	fontSize: 16,
	fontWeight: 600,
	color: "var(--dsw-alias-label-primary)"
};
const stackStyle = {
	display: "flex",
	flexDirection: "column",
	gap: 12
};
function dotStyle(status) {
	return {
		width: 9,
		height: 9,
		borderRadius: "50%",
		flex: "0 0 auto",
		background: status === "signed-in" ? "var(--dsw-alias-state-success-primary, #22a06b)" : status === "error" ? "var(--dsw-alias-state-error-primary, #d92d20)" : status === "signing-in" ? "var(--dsw-alias-brand-primary, #1677ff)" : "var(--dsw-alias-label-dimmed, #9aa0a6)"
	};
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
		style: pageStyle,
		"aria-labelledby": "pi-login-settings-title",
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
				id: "pi-login-settings-title",
				style: titleStyle,
				children: t("title")
			}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				style: {
					...bodyStyle,
					marginTop: 6
				},
				children: t("intro")
			})] }),
			error !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				style: errorStyle,
				children: error
			}) : null,
			providers === void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				style: bodyStyle,
				children: t("loadingAccount")
			}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				style: stackStyle,
				children: providers.map((provider) => {
					const account = provider.account;
					const label = account.status === "signed-in" ? t("signedIn") : account.status === "signing-in" ? t("signingIn") : account.status === "error" ? t("requestFailed") : t("signedOut");
					return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("article", {
						style: cardStyle,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: rowStyle,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									style: nameStyle,
									children: provider.displayName
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
									style: bodyStyle,
									children: [
										t("route"),
										" ",
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: provider.route })
									]
								})] }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									style: statusStyle,
									role: "status",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										"aria-hidden": "true",
										style: dotStyle(account.status)
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: label })]
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { children: account.status === "signed-in" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								style: buttonStyle,
								disabled: busy !== void 0,
								onClick: () => {
									signOut(provider.id);
								},
								children: busy === provider.id ? t("working") : t("logout")
							}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								style: primaryButtonStyle,
								disabled: busy !== void 0,
								onClick: () => {
									signIn(provider.id);
								},
								children: busy === provider.id ? t("working") : account.status === "error" ? t("loginAgain") : t("login")
							}) }),
							account.status === "error" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								style: errorStyle,
								children: account.message
							}) : null,
							account.status === "signed-in" && account.expiresAt !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
								style: bodyStyle,
								children: [
									t("expires"),
									" ",
									new Date(account.expiresAt).toLocaleString()
								]
							}) : null,
							account.status === "signed-in" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
								style: listStyle,
								children: (account.models ?? []).slice(0, 12).map((id) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", {
									style: chipStyle,
									children: id
								}, id))
							}) : null,
							account.status === "signing-in" && account.userCode !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
								style: bodyStyle,
								children: [
									t("userCode"),
									" ",
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										style: codeStyle,
										children: account.userCode
									})
								]
							}) : null,
							account.status === "signing-in" && account.url !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
								style: bodyStyle,
								children: [
									t("openUrl"),
									" ",
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("a", {
										href: account.url,
										target: "_blank",
										rel: "noreferrer",
										style: linkStyle,
										children: account.url
									})
								]
							}) : null
						]
					}, provider.id);
				})
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				style: bodyStyle,
				children: t("isolation")
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				style: bodyStyle,
				children: t("modelHint")
			})
		]
	});
}
//#endregion
//#region src/client/locales.ts
const en = {
	nav: "OAuth Login",
	title: "OAuth Login",
	intro: "Independent DSH OAuth grants. Credentials stay in ~/.dsh/.dsh-oauth-auth.json and never touch Pi Agent or official CLI files.",
	loadingAccount: "Loading accounts…",
	signedOut: "Not signed in",
	signingIn: "Waiting for authorization…",
	signedIn: "Signed in",
	login: "Sign in",
	loginAgain: "Sign in again",
	logout: "Sign out",
	working: "Working…",
	userCode: "If asked for a code, enter:",
	openUrl: "If the window did not open, open this URL:",
	popupBlocked: "The browser blocked the sign-in window. Open the URL below, or allow pop-ups and retry.",
	requestFailed: "The login request failed.",
	isolation: "Each provider is a separate OAuth grant. Pi Agent and official CLIs keep their own files; this plugin will not steal their refresh tokens.",
	expires: "Access token expires",
	models: "Catalog models",
	modelHint: "Pick the `pi-…` route in the composer. Lists come from the installed pi-ai catalog.",
	route: "Route"
};
const zh = {
	nav: "OAuth 登录",
	title: "OAuth 登录",
	intro: "DSH 独立的 OAuth 授权。凭据只写在 ~/.dsh/.dsh-oauth-auth.json，不会碰 Pi Agent 或官方 CLI 的文件。",
	loadingAccount: "正在加载账户…",
	signedOut: "尚未登录",
	signingIn: "正在等待授权…",
	signedIn: "已登录",
	login: "登录",
	loginAgain: "重新登录",
	logout: "退出",
	working: "处理中…",
	userCode: "如果要求输入代码，请输入：",
	openUrl: "如果窗口没有打开，请打开这个链接：",
	popupBlocked: "浏览器阻止了登录窗口。请打开下方链接，或允许弹出窗口后重试。",
	requestFailed: "登录请求失败。",
	isolation: "每个厂商都是独立授权。Pi Agent 和官方 CLI 继续用自己的文件，这个插件不会去抢它们的 refresh token。",
	expires: "Access token 到期",
	models: "目录模型",
	modelHint: "对话里选 `pi-…` 路由。列表来自已安装的 pi-ai 目录。",
	route: "路由"
};
//#endregion
//#region src/client/index.tsx
const name = "dsh-pi-login-client";
const inject = ["slots", "locale"];
function apply(ctx) {
	const namespace = "settings.pi-login";
	ctx.effect(() => ctx.locale.register(namespace, {
		zh,
		en
	}), "dsh-pi-login: settings copy");
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
