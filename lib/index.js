import z from "@deepseek-ai/schemastery";
import { LlmError, resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { createModels } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { withFileLock, writeFileAtomic } from "@deepseek-ai/dsh-atomic-write";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
//#region src/catalog.ts
const PI_LOGIN_PROVIDERS = [
	{
		id: "openai-codex",
		route: "pi-openai-codex",
		displayName: "ChatGPT Codex",
		shortName: "Codex",
		blurb: "ChatGPT Plus/Pro Codex. Independent of official `codex login`.",
		blurbZh: "ChatGPT Plus/Pro 的 Codex。和官方 `codex login` 互不影响。",
		allowedHosts: [
			"auth.openai.com",
			"chatgpt.com",
			"www.chatgpt.com"
		],
		allowedSuffixes: [".openai.com", ".chatgpt.com"],
		preferredModels: [
			"gpt-5.4",
			"gpt-5.3-codex",
			"gpt-5.3-codex-spark"
		]
	},
	{
		id: "anthropic",
		route: "pi-anthropic",
		displayName: "Claude Pro/Max",
		shortName: "Claude",
		blurb: "Claude subscription. Independent of official Claude Code login.",
		blurbZh: "Claude 订阅。和官方 Claude Code 登录互不影响。",
		allowedHosts: [
			"claude.ai",
			"www.claude.ai",
			"platform.claude.com"
		],
		allowedSuffixes: [".anthropic.com", ".claude.ai"],
		preferredModels: [
			"claude-opus-4-6",
			"claude-sonnet-4-6",
			"claude-opus-4-5"
		]
	},
	{
		id: "xai",
		route: "pi-xai",
		displayName: "xAI Grok",
		shortName: "Grok",
		blurb: "SuperGrok / X Premium. Independent of official `grok` CLI.",
		blurbZh: "SuperGrok / X Premium。和官方 `grok` CLI 互不影响。",
		allowedHosts: [
			"auth.x.ai",
			"accounts.x.ai",
			"x.ai",
			"www.x.ai"
		],
		allowedSuffixes: [".x.ai"],
		preferredModels: [
			"grok-4.6",
			"grok-4.5",
			"grok-4.3"
		]
	},
	{
		id: "github-copilot",
		route: "pi-github-copilot",
		displayName: "GitHub Copilot",
		shortName: "Copilot",
		blurb: "GitHub Copilot subscription via device code.",
		blurbZh: "GitHub Copilot 订阅，走 device code。",
		allowedHosts: [
			"github.com",
			"www.github.com",
			"api.github.com"
		],
		allowedSuffixes: [".github.com", ".githubcopilot.com"],
		preferredModels: [
			"gpt-5.4",
			"claude-sonnet-4.6",
			"claude-opus-4.6"
		]
	},
	{
		id: "openrouter",
		route: "pi-openrouter",
		displayName: "OpenRouter",
		shortName: "OpenRouter",
		blurb: "OpenRouter OAuth mints a key billed from your OpenRouter credits.",
		blurbZh: "OpenRouter OAuth 会签发一把钥匙，从你的 OpenRouter 余额扣费。",
		allowedHosts: ["openrouter.ai", "www.openrouter.ai"],
		allowedSuffixes: [".openrouter.ai"],
		preferredModels: []
	},
	{
		id: "kimi-coding",
		route: "pi-kimi-coding",
		displayName: "Kimi For Coding",
		shortName: "Kimi",
		blurb: "Kimi Code subscription.",
		blurbZh: "Kimi Code 订阅。",
		allowedHosts: [
			"auth.kimi.com",
			"kimi.com",
			"www.kimi.com",
			"api.kimi.com"
		],
		allowedSuffixes: [".kimi.com"],
		preferredModels: ["kimi-for-coding", "k3"]
	}
];
function piLoginProvider(id) {
	return PI_LOGIN_PROVIDERS.find((provider) => provider.id === id);
}
function piLoginProviderByRoute(route) {
	return PI_LOGIN_PROVIDERS.find((provider) => provider.route === route);
}
function requirePiLoginProvider(id) {
	const provider = piLoginProvider(id);
	if (provider === void 0) throw new Error(`dsh-pi-login: unknown provider "${id}"`);
	return provider;
}
function piLoginRoutes() {
	return PI_LOGIN_PROVIDERS.map((provider) => provider.route);
}
//#endregion
//#region src/ids.ts
/** Basename of the multi-provider OAuth document inside the Harness home. */
const PI_LOGIN_AUTH_FILENAME = ".pi-login-auth.json";
/** Prefix for harness routes so they never collide with catalog / other plugins. */
const PI_LOGIN_ROUTE_PREFIX = "pi-";
/** Provider idle ceiling used by every composite route. */
const PI_LOGIN_STREAM_IDLE_TIMEOUT_MS = 3e5;
//#endregion
//#region src/adapter.ts
/** One PiAiAdapter covering every Pi-login harness route. */
function createPiLoginAdapter(session, resolveAttachments) {
	return new PiAiAdapter({
		profiles: () => {
			const profiles = /* @__PURE__ */ new Map();
			for (const spec of PI_LOGIN_PROVIDERS) profiles.set(spec.route, {
				provider: spec.route,
				displayName: spec.displayName,
				streamIdleTimeoutMs: PI_LOGIN_STREAM_IDLE_TIMEOUT_MS,
				retryPolicy: resolveRetryPolicy(void 0, "dsh-pi-login retryPolicy"),
				configuredMaxTokens: /* @__PURE__ */ new Map(),
				piProvider: session.provider(spec.id)
			});
			return profiles;
		},
		resolveApiKey: async (route) => {
			const spec = piLoginProviderByRoute(route);
			if (spec === void 0) throw new LlmError(`dsh-pi-login: unknown route "${route}"`, "MISSING_CREDENTIAL");
			const apiKey = (await session.models.getAuth(spec.id))?.auth.apiKey;
			if (apiKey === void 0 || apiKey.length === 0) throw new LlmError(`${spec.displayName} is not signed in. Open Settings → Pi Login and sign in.`, "MISSING_CREDENTIAL");
			return apiKey;
		},
		resolveAttachments
	});
}
//#endregion
//#region src/provider.ts
/** Installed pi-ai providers remapped onto independent harness routes. */
function harnessApiKeyAuth(name) {
	return {
		name,
		resolve: ({ credential }) => Promise.resolve({
			auth: credential?.key === void 0 ? {} : { apiKey: credential.key },
			source: name
		})
	};
}
function catalogProvider(id) {
	const base = builtinProviders().find((candidate) => candidate.id === id);
	if (base === void 0) throw new Error(`dsh-pi-login: the installed pi-ai catalog ships no "${id}" provider`);
	return base;
}
function preferredModel(spec, models = catalogProvider(spec.id).getModels()) {
	const ids = new Set(models.map((model) => model.id));
	for (const candidate of spec.preferredModels) if (ids.has(candidate)) return candidate;
	return models[0]?.id ?? spec.id;
}
function harnessProvider(spec) {
	const base = catalogProvider(spec.id);
	const models = () => base.getModels().map((model) => model.provider === spec.route ? model : {
		...model,
		provider: spec.route
	});
	return {
		id: spec.route,
		name: spec.displayName,
		...base.baseUrl === void 0 ? {} : { baseUrl: base.baseUrl },
		auth: {
			...base.auth,
			apiKey: harnessApiKeyAuth(spec.displayName)
		},
		getModels: models,
		stream: (model, context, options) => base.stream(model, context, options),
		streamSimple: (model, context, options) => base.streamSimple(model, context, options)
	};
}
function allCatalogProviders() {
	return PI_LOGIN_PROVIDERS.map((spec) => catalogProvider(spec.id));
}
//#endregion
//#region src/store.ts
/**
* Multi-provider OAuth store. File is $DSH_HOME/.pi-login-auth.json.
* Never ~/.codex, ~/.grok, ~/.claude, or ~/.pi/agent/auth.json.
*/
const AUTH_FORMAT_VERSION = 1;
const ALLOWED_FIELDS = /* @__PURE__ */ new Set([
	"type",
	"access",
	"refresh",
	"expires",
	"accountId",
	"enterpriseUrl",
	"availableModelIds"
]);
function isENOENT(error) {
	return error?.code === "ENOENT";
}
async function assertOwnerOnly(filename) {
	let mode;
	try {
		mode = (await stat(filename)).mode;
	} catch (error) {
		if (isENOENT(error)) return;
		throw error;
	}
	if (process.platform === "win32") return;
	if ((mode & 63) !== 0) throw new Error(`pi-login: ${filename} is readable beyond its owner (mode ${(mode & 511).toString(8)}); run "chmod 600 ${filename}" before starting again`);
}
function parseCredential(raw, filename, providerId) {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error(`pi-login: ${filename} credential for ${providerId} must be an object`);
	const credential = raw;
	if (Object.keys(credential).some((key) => !ALLOWED_FIELDS.has(key))) throw new Error(`pi-login: ${filename} credential for ${providerId} contains an unknown field`);
	if (credential["type"] !== "oauth") throw new Error(`pi-login: ${filename} credential for ${providerId} type must be oauth`);
	if (typeof credential["access"] !== "string" || credential["access"].length === 0) throw new Error(`pi-login: ${filename} credential for ${providerId} access must be a non-empty string`);
	if (typeof credential["refresh"] !== "string") throw new Error(`pi-login: ${filename} credential for ${providerId} refresh must be a string`);
	if (typeof credential["expires"] !== "number" || !Number.isFinite(credential["expires"]) || credential["expires"] <= 0) throw new Error(`pi-login: ${filename} credential for ${providerId} expires must be a positive finite number`);
	return credential;
}
function parseDocument(text, filename) {
	let value;
	try {
		value = JSON.parse(text);
	} catch {
		throw new Error(`pi-login: ${filename} is not valid JSON`);
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`pi-login: ${filename} must contain an object`);
	const document = value;
	if (document["version"] !== AUTH_FORMAT_VERSION) throw new Error(`pi-login: ${filename} has unsupported auth format version ${String(document["version"])}`);
	if (Object.keys(document).some((key) => key !== "version" && key !== "credentials")) throw new Error(`pi-login: ${filename} contains an unknown top-level field`);
	const raw = document["credentials"];
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error(`pi-login: ${filename} credentials must be an object`);
	const owned = new Set(PI_LOGIN_PROVIDERS.map((provider) => provider.id));
	const credentials = {};
	for (const [providerId, entry] of Object.entries(raw)) {
		if (!owned.has(providerId)) throw new Error(`pi-login: ${filename} contains an unknown provider "${providerId}"`);
		credentials[providerId] = parseCredential(entry, filename, providerId);
	}
	return {
		version: AUTH_FORMAT_VERSION,
		credentials
	};
}
function cloneCredential(credential) {
	return structuredClone(credential);
}
function piLoginAuthPath(dshHome) {
	return resolve(join(resolveDshHome(dshHome), PI_LOGIN_AUTH_FILENAME));
}
var PiLoginCredentialStore = class {
	filename;
	constructor(filename = piLoginAuthPath()) {
		this.filename = resolve(filename);
	}
	async readDocument() {
		await assertOwnerOnly(this.filename);
		let text;
		try {
			text = await readFile(this.filename, "utf8");
		} catch (error) {
			if (isENOENT(error)) return {
				version: AUTH_FORMAT_VERSION,
				credentials: {}
			};
			throw error;
		}
		return parseDocument(text, this.filename);
	}
	async read(providerId) {
		const credential = (await this.readDocument()).credentials[providerId];
		return credential === void 0 ? void 0 : cloneCredential(credential);
	}
	async list() {
		return Object.keys((await this.readDocument()).credentials).map((providerId) => ({
			providerId,
			type: "oauth"
		}));
	}
	async modify(providerId, fn) {
		if (!PI_LOGIN_PROVIDERS.some((provider) => provider.id === providerId)) throw new Error(`pi-login: credential store does not own provider "${providerId}"`);
		await mkdir(dirname(this.filename), {
			recursive: true,
			mode: 448
		});
		return withFileLock(this.filename, async () => {
			const document = await this.readDocument();
			const current = document.credentials[providerId];
			const candidate = await fn(current === void 0 ? void 0 : cloneCredential(current));
			if (candidate === void 0) return current === void 0 ? void 0 : cloneCredential(current);
			const next = parseCredential(candidate, this.filename, providerId);
			const credentials = {
				...document.credentials,
				[providerId]: next
			};
			await writeFileAtomic(this.filename, `${JSON.stringify({
				version: AUTH_FORMAT_VERSION,
				credentials
			}, null, 2)}\n`, {
				mode: 384,
				dirMode: 448
			});
			return cloneCredential(next);
		});
	}
	async delete(providerId) {
		if (!PI_LOGIN_PROVIDERS.some((provider) => provider.id === providerId)) return;
		await mkdir(dirname(this.filename), {
			recursive: true,
			mode: 448
		});
		await withFileLock(this.filename, async () => {
			const document = await this.readDocument();
			if (document.credentials[providerId] === void 0) return;
			const { [providerId]: _removed, ...credentials } = document.credentials;
			if (Object.keys(credentials).length === 0) {
				await rm(this.filename, { force: true });
				return;
			}
			await writeFileAtomic(this.filename, `${JSON.stringify({
				version: AUTH_FORMAT_VERSION,
				credentials
			}, null, 2)}\n`, {
				mode: 384,
				dirMode: 448
			});
		});
	}
};
//#endregion
//#region src/auth.ts
/** Pi-native models.login() for every subscribed provider in the catalog. */
async function loginPiProvider(providerId, interaction, store = new PiLoginCredentialStore()) {
	requirePiLoginProvider(providerId);
	const models = createModels({ credentials: store });
	models.setProvider(catalogProvider(providerId));
	await models.login(providerId, "oauth", interaction);
}
async function logoutPiProvider(providerId, store = new PiLoginCredentialStore()) {
	requirePiLoginProvider(providerId);
	await store.delete(providerId);
}
async function piLoginStatus(store = new PiLoginCredentialStore(), providerId) {
	const ids = providerId === void 0 ? (await store.list()).map((item) => item.providerId) : [providerId];
	const out = [];
	for (const id of ids) {
		const credential = await store.read(id);
		out.push(credential?.type === "oauth" ? {
			providerId: id,
			authenticated: true,
			expiresAt: new Date(credential.expires)
		} : {
			providerId: id,
			authenticated: false
		});
	}
	return out;
}
async function loginPiProviderSession(providerId, interaction, session) {
	await loginPiProvider(providerId, interaction, session.store);
}
//#endregion
//#region src/redact.ts
/** Remove token-like strings from an external OAuth diagnostic. */
function safeMessage(error) {
	return (error instanceof Error ? error.message : String(error)).replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, "[redacted token]").replace(/(\b(?:code|token|refresh_token|access_token|key)=)[^&\s]+/giu, "$1[redacted]").slice(0, 1e3);
}
/** Only this provider's official HTTPS hosts may be opened for login. */
function isSafeAuthUrl(raw, provider) {
	try {
		const url = new URL(raw);
		if (url.protocol !== "https:") return false;
		const host = url.hostname.toLowerCase();
		if (provider.allowedHosts.includes(host)) return true;
		return provider.allowedSuffixes.some((suffix) => host.endsWith(suffix));
	} catch {
		return false;
	}
}
//#endregion
//#region src/auth-routes.ts
const PI_LOGIN_AUTH_STATUS_PATH = "/plugins/dsh-pi-login/auth/status";
const PI_LOGIN_AUTH_LOGIN_PATH = "/plugins/dsh-pi-login/auth/login";
const PI_LOGIN_AUTH_LOGOUT_PATH = "/plugins/dsh-pi-login/auth/logout";
function waitForPromptAbort(prompt) {
	const signal = prompt.signal;
	if (signal === void 0) return new Promise(() => {});
	if (signal.aborted) return Promise.reject(signal.reason);
	return new Promise((_resolve, reject) => {
		signal.addEventListener("abort", () => {
			reject(signal.reason);
		}, { once: true });
	});
}
function answerWebPrompt(prompt) {
	if (prompt.type === "select") {
		const oauth = prompt.options.find((option) => option.id === "oauth" || option.id.includes("oauth"));
		const browser = prompt.options.find((option) => option.id.includes("browser"));
		return Promise.resolve(oauth?.id ?? browser?.id ?? prompt.options[0]?.id ?? "oauth");
	}
	if (prompt.type === "text") return Promise.resolve("");
	return waitForPromptAbort(prompt);
}
var ProviderAuth = class {
	spec;
	session;
	state = { status: "signed-out" };
	operation;
	cancellation;
	challenge;
	challengeWaiters = [];
	constructor(spec, session) {
		this.spec = spec;
		this.session = session;
	}
	async snapshot() {
		if (this.operation !== void 0) return this.state;
		if (this.state.status === "error") return this.state;
		return this.readStored();
	}
	async signIn() {
		if (this.operation === void 0) this.start();
		if (this.challenge !== void 0) return this.challenge;
		return new Promise((resolve, reject) => {
			this.challengeWaiters.push({
				resolve,
				reject
			});
		});
	}
	async signOut() {
		this.cancellation?.abort(/* @__PURE__ */ new Error("Pi login cancelled"));
		await this.operation?.catch(() => void 0);
		await this.session.logout(this.spec.id);
		this.state = { status: "signed-out" };
		this.challenge = void 0;
	}
	async dispose() {
		this.cancellation?.abort(/* @__PURE__ */ new Error("Pi login plugin disposed"));
		await this.operation?.catch(() => void 0);
	}
	start() {
		const cancellation = new AbortController();
		this.cancellation = cancellation;
		this.challenge = void 0;
		this.state = { status: "signing-in" };
		this.operation = loginPiProviderSession(this.spec.id, {
			signal: cancellation.signal,
			prompt: answerWebPrompt,
			notify: (event) => {
				this.onEvent(event);
			}
		}, this.session).then(async () => {
			this.state = await this.readStored();
		}, (error) => {
			this.rejectChallenge(error);
			this.state = {
				status: "error",
				message: safeMessage(error)
			};
		}).finally(() => {
			this.operation = void 0;
			this.cancellation = void 0;
		});
	}
	onEvent(event) {
		if (event.type === "device_code") {
			this.acceptChallenge({
				provider: this.spec.id,
				url: event.verificationUri,
				...event.userCode.length > 0 ? { userCode: event.userCode } : {}
			});
			return;
		}
		if (event.type === "auth_url") this.acceptChallenge({
			provider: this.spec.id,
			url: event.url
		});
	}
	acceptChallenge(challenge) {
		if (!isSafeAuthUrl(challenge.url, this.spec)) {
			const error = /* @__PURE__ */ new Error(`${this.spec.id} returned an authorization URL outside its official hosts`);
			this.cancellation?.abort(error);
			this.rejectChallenge(error);
			return;
		}
		this.challenge = challenge;
		this.state = {
			status: "signing-in",
			url: challenge.url,
			...challenge.userCode === void 0 ? {} : { userCode: challenge.userCode }
		};
		for (const waiter of this.challengeWaiters.splice(0)) waiter.resolve(challenge);
	}
	async readStored() {
		const [stored] = await piLoginStatus(this.session.store, this.spec.id);
		if (stored === void 0 || !stored.authenticated) return { status: "signed-out" };
		return {
			status: "signed-in",
			models: this.session.visibleModels(this.spec.id).map((model) => model.id),
			...stored.expiresAt === void 0 || Number.isNaN(stored.expiresAt.valueOf()) ? {} : { expiresAt: stored.expiresAt.toISOString() }
		};
	}
	rejectChallenge(error) {
		for (const waiter of this.challengeWaiters.splice(0)) waiter.reject(error);
	}
};
var PiLoginWebAuth = class {
	byId = /* @__PURE__ */ new Map();
	constructor(session) {
		for (const spec of PI_LOGIN_PROVIDERS) this.byId.set(spec.id, new ProviderAuth(spec, session));
	}
	slot(id) {
		const slot = this.byId.get(id);
		if (slot === void 0) throw new Error(`dsh-pi-login: unknown provider "${id}"`);
		return slot;
	}
	async status() {
		const out = [];
		for (const spec of PI_LOGIN_PROVIDERS) out.push({
			id: spec.id,
			route: spec.route,
			displayName: spec.displayName,
			shortName: spec.shortName,
			account: await this.slot(spec.id).snapshot()
		});
		return out;
	}
	async signIn(id) {
		requirePiLoginProvider(id);
		return this.slot(id).signIn();
	}
	async signOut(id) {
		requirePiLoginProvider(id);
		await this.slot(id).signOut();
	}
	async dispose() {
		await Promise.all([...this.byId.values()].map((slot) => slot.dispose()));
	}
};
function trustedRequest(req) {
	const remote = req.socket.remoteAddress;
	if (remote !== "127.0.0.1" && remote !== "::1" && remote !== "::ffff:127.0.0.1") return false;
	if (req.headers["sec-fetch-site"] === "cross-site") return false;
	const host = req.headers.host;
	if (host === void 0) return false;
	const origin = req.headers.origin;
	if (origin === void 0) return true;
	try {
		return new URL(origin).host === new URL(`http://${host}`).host;
	} catch {
		return false;
	}
}
function json(res, status, value) {
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
		"x-content-type-options": "nosniff"
	});
	res.end(JSON.stringify(value));
}
async function readJson(req) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > 4096) throw new Error("request body too large");
		chunks.push(chunk);
	}
	if (chunks.length === 0) return {};
	return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
function providerIdFrom(value) {
	if (typeof value !== "object" || value === null || !("provider" in value) || typeof value.provider !== "string") throw new Error("expected { \"provider\": \"<id>\" }");
	return requirePiLoginProvider(value.provider).id;
}
function registerPiLoginAuthRoutes(ctx, session) {
	const auth = new PiLoginWebAuth(session);
	ctx.effect(() => {
		const routes = [
			ctx.webServer.register({
				kind: "exact",
				path: PI_LOGIN_AUTH_STATUS_PATH,
				handler: async (req, res) => {
					if (req.method !== "GET") return json(res, 405, { error: "method not allowed" });
					if (!trustedRequest(req)) return json(res, 403, { error: "forbidden" });
					json(res, 200, await auth.status());
				}
			}),
			ctx.webServer.register({
				kind: "exact",
				path: PI_LOGIN_AUTH_LOGIN_PATH,
				handler: async (req, res) => {
					if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
					if (!trustedRequest(req)) return json(res, 403, { error: "forbidden" });
					try {
						json(res, 200, await auth.signIn(providerIdFrom(await readJson(req))));
					} catch (error) {
						json(res, 500, { error: safeMessage(error) });
					}
				}
			}),
			ctx.webServer.register({
				kind: "exact",
				path: PI_LOGIN_AUTH_LOGOUT_PATH,
				handler: async (req, res) => {
					if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
					if (!trustedRequest(req)) return json(res, 403, { error: "forbidden" });
					try {
						await auth.signOut(providerIdFrom(await readJson(req)));
						json(res, 200, { ok: true });
					} catch (error) {
						json(res, 500, { error: safeMessage(error) });
					}
				}
			})
		];
		return async () => {
			for (const dispose of routes) dispose();
			await auth.dispose();
		};
	}, "dsh-pi-login: Web OAuth routes");
}
//#endregion
//#region src/session.ts
/** Shared OAuth store + catalog for the host plugin and CLI. */
var PiLoginSession = class {
	store;
	models;
	constructor(store = new PiLoginCredentialStore()) {
		this.store = store;
		this.models = createModels({ credentials: store });
		for (const provider of allCatalogProviders()) this.models.setProvider(provider);
	}
	spec(id) {
		const spec = PI_LOGIN_PROVIDERS.find((provider) => provider.id === id);
		if (spec === void 0) throw new Error(`dsh-pi-login: unknown provider "${id}"`);
		return spec;
	}
	provider(id) {
		return harnessProvider(this.spec(id));
	}
	visibleModels(id) {
		return this.provider(id).getModels();
	}
	async logout(id) {
		await this.store.delete(id);
	}
};
//#endregion
//#region src/index.ts
const name = "llm-pi-login";
const inject = ["llm"];
const Config = z.object({});
function apply(ctx, _config) {
	const session = new PiLoginSession(new PiLoginCredentialStore());
	ctx.llm.registerAdapter(piLoginRoutes(), createPiLoginAdapter(session, () => ctx.get("attachments")));
	ctx.inject(["webServer"], (webCtx) => registerPiLoginAuthRoutes(webCtx, session));
}
//#endregion
export { Config, PI_LOGIN_AUTH_FILENAME, PI_LOGIN_AUTH_LOGIN_PATH, PI_LOGIN_AUTH_LOGOUT_PATH, PI_LOGIN_AUTH_STATUS_PATH, PI_LOGIN_PROVIDERS, PI_LOGIN_ROUTE_PREFIX, PI_LOGIN_STREAM_IDLE_TIMEOUT_MS, PiLoginCredentialStore, PiLoginSession, apply, catalogProvider, createPiLoginAdapter, harnessProvider, inject, isSafeAuthUrl, loginPiProvider, loginPiProviderSession, logoutPiProvider, name, piLoginAuthPath, piLoginProvider, piLoginRoutes, piLoginStatus, preferredModel, registerPiLoginAuthRoutes, safeMessage };
