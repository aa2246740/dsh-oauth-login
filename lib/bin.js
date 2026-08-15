#!/usr/bin/env node
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import z from "@deepseek-ai/schemastery";
import "@deepseek-ai/dsh-llm";
import "@deepseek-ai/dsh-llm-pi-ai";
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
function requirePiLoginProvider(id) {
	const provider = piLoginProvider(id);
	if (provider === void 0) throw new Error(`dsh-pi-login: unknown provider "${id}"`);
	return provider;
}
//#endregion
//#region src/ids.ts
/** Basename of the multi-provider OAuth document inside the Harness home. */
const PI_LOGIN_AUTH_FILENAME = ".pi-login-auth.json";
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
z.object({});
//#endregion
//#region src/bin.ts
/** Standalone credential CLI. Never reads or writes official CLI auth files. */
function openBrowser(rawUrl, providerId) {
	const spec = requirePiLoginProvider(providerId);
	if (!isSafeAuthUrl(rawUrl, spec)) throw new Error(`refusing to open authorization URL outside ${spec.displayName} official hosts`);
	const url = new URL(rawUrl);
	const command = process.platform === "win32" ? {
		file: "rundll32.exe",
		args: ["url.dll,FileProtocolHandler", url.href]
	} : process.platform === "darwin" ? {
		file: "open",
		args: [url.href]
	} : {
		file: "xdg-open",
		args: [url.href]
	};
	try {
		const child = spawn(command.file, command.args, {
			detached: true,
			stdio: "ignore",
			windowsHide: true
		});
		child.on("error", () => {});
		child.unref();
	} catch {}
}
function notify(event, providerId, useBrowser) {
	switch (event.type) {
		case "auth_url":
			process.stdout.write(`Open this URL to sign in:\n${event.url}\n`);
			if (event.instructions !== void 0) process.stdout.write(`${event.instructions}\n`);
			if (useBrowser) openBrowser(event.url, providerId);
			break;
		case "device_code":
			process.stdout.write(`Open this URL to sign in:\n${event.verificationUri}\n`);
			if (event.userCode.length > 0) process.stdout.write(`Enter code: ${event.userCode}\n`);
			if (useBrowser) openBrowser(event.verificationUri, providerId);
			break;
		case "info":
		case "progress": process.stdout.write(`${event.message}\n`);
	}
}
async function answerPrompt(prompt, question) {
	if (prompt.type === "select") {
		const oauth = prompt.options.find((option) => option.id === "oauth" || option.id.includes("oauth"));
		const browser = prompt.options.find((option) => option.id.includes("browser"));
		return oauth?.id ?? browser?.id ?? prompt.options[0]?.id ?? "oauth";
	}
	const suffix = prompt.placeholder === void 0 ? "" : ` (${prompt.placeholder})`;
	return question(`${prompt.message}${suffix}: `, { ...prompt.signal === void 0 ? {} : { signal: prompt.signal } });
}
function printHelp() {
	const ids = PI_LOGIN_PROVIDERS.map((provider) => `    ${provider.id.padEnd(18)} ${provider.displayName}`).join("\n");
	process.stdout.write([
		"Usage: dsh-pi-login <login|logout|status> [provider]",
		"",
		"  login [provider]   Pi-native OAuth. Own file, not official CLIs",
		"  logout [provider]  remove a dsh credential (or all if omitted)",
		"  status [provider]  report non-secret credential state",
		"",
		"Providers:",
		ids,
		""
	].join("\n"));
}
function resolveIds(raw) {
	if (raw === void 0) return PI_LOGIN_PROVIDERS.map((provider) => provider.id);
	return [requirePiLoginProvider(raw).id];
}
async function run(argv) {
	if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
		printHelp();
		return 0;
	}
	const [rawAction, rawProvider, ...rest] = argv;
	if (rawAction !== "login" && rawAction !== "logout" && rawAction !== "status") {
		process.stderr.write(`dsh-pi-login: expected login, logout, or status; got ${JSON.stringify(rawAction)}\n`);
		return 1;
	}
	if (rest.length > 0) {
		process.stderr.write(`dsh-pi-login: unexpected extra arguments: ${rest.join(" ")}\n`);
		return 1;
	}
	const action = rawAction;
	try {
		const session = new PiLoginSession();
		switch (action) {
			case "status": {
				const ids = resolveIds(rawProvider);
				let failed = false;
				process.stdout.write(`store: ${piLoginAuthPath()}\n`);
				for (const id of ids) {
					const [status] = await piLoginStatus(session.store, id);
					const spec = requirePiLoginProvider(id);
					if (status === void 0 || !status.authenticated) {
						process.stdout.write(`${spec.displayName}: signed out\n`);
						failed = true;
						continue;
					}
					const expires = status.expiresAt;
					const suffix = expires === void 0 || Number.isNaN(expires.valueOf()) ? "" : `; access expires ${expires.toISOString()}`;
					const models = session.visibleModels(id).map((model) => model.id).slice(0, 8).join(", ");
					process.stdout.write(`${spec.displayName}: signed in${suffix}\n`);
					process.stdout.write(`  route: ${spec.route}\n`);
					process.stdout.write(`  models: ${models}\n`);
				}
				return failed && rawProvider !== void 0 ? 1 : 0;
			}
			case "logout": {
				const ids = resolveIds(rawProvider);
				for (const id of ids) {
					await session.logout(id);
					process.stdout.write(`${requirePiLoginProvider(id).displayName}: signed out\n`);
				}
				process.stdout.write("Official CLI auth files were not touched.\n");
				return 0;
			}
			case "login": {
				if (rawProvider === void 0) {
					process.stderr.write("dsh-pi-login: login requires a provider id (see --help)\n");
					return 1;
				}
				const id = requirePiLoginProvider(rawProvider).id;
				const readline = createInterface({
					input: process.stdin,
					output: process.stdout
				});
				try {
					await loginPiProviderSession(id, {
						prompt: (prompt) => answerPrompt(prompt, (text, options) => readline.question(text, options)),
						notify: (event) => notify(event, id, true)
					}, session);
				} finally {
					readline.close();
				}
				process.stdout.write(`${requirePiLoginProvider(id).displayName}: signed in\n`);
				process.stdout.write(`store: ${piLoginAuthPath()}\n`);
				process.stdout.write("Official CLI auth files were not read or written.\n");
				return 0;
			}
		}
	} catch (error) {
		process.stderr.write(`dsh-pi-login: ${action} failed: ${safeMessage(error)}\n`);
		return 1;
	}
}
if (process.argv[1] !== void 0 && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) process.exitCode = await run(process.argv.slice(2));
//#endregion
export { run };
