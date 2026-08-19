import { LlmError, RetryPolicySchema, resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { AsyncLocalStorage } from "node:async_hooks";
import { createModels } from "@earendil-works/pi-ai";
import { execFile } from "node:child_process";
import { connect } from "node:net";
import { EnvHttpProxyAgent, install, setGlobalDispatcher } from "undici";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { withFileLock, writeFileAtomic } from "@deepseek-ai/dsh-atomic-write";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import z from "@deepseek-ai/schemastery";
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
	if (provider === void 0) throw new Error(`dsh-oauth-login: unknown provider "${id}"`);
	return provider;
}
function piLoginRoutes() {
	return PI_LOGIN_PROVIDERS.map((provider) => provider.route);
}
//#endregion
//#region src/hosted-capture.ts
/** Per-request bag for hosted Responses output that pi-ai drops. */
const hostedCapture = new AsyncLocalStorage();
function currentHostedCapture() {
	return hostedCapture.getStore();
}
/** Keep ALS alive across each iterator step so the OpenAI SDK fetch inherits it. */
function iterateInCapture(capture, source) {
	return { [Symbol.asyncIterator]() {
		const iterator = source[Symbol.asyncIterator]();
		return {
			next: () => hostedCapture.run(capture, () => iterator.next()),
			return: (value) => hostedCapture.run(capture, () => iterator.return?.(value) ?? Promise.resolve({
				done: true,
				value: void 0
			})),
			throw: (error) => hostedCapture.run(capture, () => iterator.throw?.(error) ?? Promise.reject(error))
		};
	} };
}
//#endregion
//#region src/hosted-images.ts
function isRecord$1(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function sniffImageMediaType(bytes) {
	if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
	if (bytes.length >= 8 && bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71) return "image/png";
	if (bytes.length >= 6 && bytes[0] === 71 && bytes[1] === 73 && bytes[2] === 70) return "image/gif";
	if (bytes.length >= 12 && bytes[8] === 87 && bytes[9] === 69 && bytes[10] === 66 && bytes[11] === 80) return "image/webp";
}
function stripDataUrl(value) {
	return /^data:image\/[a-zA-Z0-9.+-]+;base64,(.+)$/s.exec(value.trim())?.[1] ?? value.trim();
}
function base64FromUnknown(value) {
	if (typeof value === "string" && value.length > 0) return stripDataUrl(value);
	if (!isRecord$1(value)) return void 0;
	if (typeof value.b64_json === "string" && value.b64_json.length > 0) return stripDataUrl(value.b64_json);
	if (typeof value.base64 === "string" && value.base64.length > 0) return stripDataUrl(value.base64);
	if (typeof value.result === "string" && value.result.length > 0) return stripDataUrl(value.result);
}
function pushImage(into, id, base64) {
	if (id !== void 0 && into.some((existing) => existing.id === id)) return;
	if (id === void 0 && into.some((existing) => existing.base64 === base64)) return;
	into.push(id === void 0 ? { base64 } : {
		id,
		base64
	});
}
function collectHostedImageFromItem(item, into) {
	if (!isRecord$1(item) || item.type !== "image_generation_call") return;
	if (item.status !== void 0 && item.status !== "completed") return;
	const base64 = base64FromUnknown(item.result);
	if (base64 === void 0) return;
	pushImage(into, typeof item.id === "string" ? item.id : void 0, base64);
}
function collectHostedImagesFromEvent(event, into) {
	if (!isRecord$1(event) || typeof event.type !== "string") return;
	if (event.type === "response.output_item.done") {
		collectHostedImageFromItem(event.item, into);
		return;
	}
	if (event.type.startsWith("response.image_generation_call.")) {
		collectHostedImageFromItem(event.item, into);
		if (event.type.endsWith(".completed")) {
			const base64 = base64FromUnknown(event.result);
			if (base64 !== void 0) pushImage(into, typeof event.item_id === "string" ? event.item_id : isRecord$1(event.item) && typeof event.item.id === "string" ? event.item.id : void 0, base64);
		}
		return;
	}
	if (event.type !== "response.completed" && event.type !== "response.incomplete") return;
	const output = isRecord$1(event.response) ? event.response.output : void 0;
	if (!Array.isArray(output)) return;
	for (const item of output) collectHostedImageFromItem(item, into);
}
function decodeHostedImage(base64) {
	let data;
	try {
		data = Uint8Array.from(Buffer.from(base64, "base64"));
	} catch {
		return;
	}
	if (data.length === 0) return void 0;
	const mediaType = sniffImageMediaType(data);
	return mediaType === void 0 ? void 0 : {
		data,
		mediaType
	};
}
function extensionFor(mediaType) {
	switch (mediaType) {
		case "image/jpeg": return "jpg";
		case "image/png": return "png";
		case "image/webp": return "webp";
		case "image/gif": return "gif";
	}
}
/**
* pi-ai replay cannot represent assistant ImageBlocks. Drop them before the
* next request so replay metadata still lines up with remaining content.
*/
function stripAssistantImages(messages) {
	return messages.map((message) => {
		if (message.role !== "assistant") return message;
		const content = message.content.filter((block) => block.type !== "image");
		return content.length === message.content.length ? message : {
			...message,
			content
		};
	});
}
async function* injectHostedImages(source, capture, save) {
	let maxIndex = -1;
	const tail = [];
	for await (const chunk of source) {
		if ("index" in chunk && typeof chunk.index === "number") maxIndex = Math.max(maxIndex, chunk.index);
		if (chunk.type === "usage" || chunk.type === "finish") {
			tail.push(chunk);
			continue;
		}
		yield chunk;
	}
	for (const image of capture.images) {
		const decoded = decodeHostedImage(image.base64);
		if (decoded === void 0) continue;
		try {
			const attachment = await save({
				data: decoded.data,
				mediaType: decoded.mediaType,
				name: `generated.${extensionFor(decoded.mediaType)}`
			});
			const index = maxIndex + 1;
			maxIndex = index;
			yield {
				type: "block-start",
				index,
				blockType: "image"
			};
			yield {
				type: "block-end",
				index,
				block: {
					type: "image",
					attachment
				}
			};
		} catch {}
	}
	yield* tail;
}
//#endregion
//#region src/ids.ts
/** Basename of the DSH-owned multi-provider OAuth document. */
const PI_LOGIN_AUTH_FILENAME = ".dsh-oauth-auth.json";
/** Legacy DSH filename accepted during the one-time storage migration. */
const LEGACY_PI_LOGIN_AUTH_FILENAME = ".pi-login-auth.json";
/** Prefix for harness routes so they never collide with catalog / other plugins. */
const PI_LOGIN_ROUTE_PREFIX = "pi-";
/** Provider idle ceiling used by every composite route. */
const PI_LOGIN_STREAM_IDLE_TIMEOUT_MS = 3e5;
/** Startup line `dshx verify` looks for. */
const PI_LOGIN_BOOT_MARKER = "[my-plugins/dsh-oauth-login] loaded";
//#endregion
//#region src/model-error-hint.ts
/** User-facing copy for classified model failures this plugin owns. */
/**
* Default Harness `retryPolicy` codes. Keep aligned with
* `resolveRetryPolicy(undefined)` in `@deepseek-ai/dsh-llm`.
*/
const TRANSIENT_MODEL_CODES = Object.freeze([
	"EMPTY_RESPONSE",
	"RATE_LIMIT",
	"SERVER",
	"TIMEOUT",
	"TRANSPORT"
]);
const QUOTA_HINT = "This is account quota or credits, not a temporary busy signal. Automatic retry will not refill it. Check the plan, usage window, or balance.";
const RATE_LIMIT_HINT = "This is a request-rate or peak-busy limit. A 429 is often this, not an empty balance. After automatic retries end, wait and send another message. If Continue fails or the composer stays stuck, start a new chat.";
const TRANSIENT_HINT = "After this turn ends, send another message to try again. If Continue fails or the composer stays stuck, start a new chat.";
const SENTINELS = [
	"Automatic retry will not refill it",
	"request-rate or peak-busy limit",
	"After this turn ends, send another message"
];
/** Stable Chat copy for one official `LlmError` code. Does not invent 5h vs weekly vs billing. */
function hintForCode(code) {
	if (code === "QUOTA") return QUOTA_HINT;
	if (code === "RATE_LIMIT") return RATE_LIMIT_HINT;
	if (TRANSIENT_MODEL_CODES.includes(code)) return TRANSIENT_HINT;
}
function alreadyHinted(message) {
	return SENTINELS.some((marker) => message.includes(marker));
}
function hintFailure(failure) {
	const hint = hintForCode(failure.code);
	if (hint === void 0 || alreadyHinted(failure.message)) return failure;
	return {
		...failure,
		message: `${failure.message} ${hint}`
	};
}
/** Append a code-specific hint without changing the routable `code`. */
function withModelErrorHint(error) {
	if (!(error instanceof LlmError)) return error;
	const hinted = hintFailure(error.failure);
	if (hinted === error.failure) return error;
	return new LlmError(hinted.message, error.code, {
		cause: error,
		...error.failure.status === void 0 ? {} : { status: error.failure.status },
		...error.failure.providerRetryAfterMs === void 0 ? {} : { providerRetryAfterMs: error.failure.providerRetryAfterMs },
		...error.failure.requestId === void 0 ? {} : { requestId: error.failure.requestId }
	});
}
//#endregion
//#region src/native-tools.ts
/** DSH model-facing tools that steal traffic from a subscribed provider. */
const DSH_WEB_TOOL_NAMES = ["web_search", "web_fetch"];
/** Matching tool-web prompt sections. */
const DSH_WEB_SECTION_NAMES = ["tool:web_search", "tool:web_fetch"];
const DSH_WEB_TOOL_NAME_SET = new Set(DSH_WEB_TOOL_NAMES);
const DSH_WEB_SECTION_NAME_SET = new Set(DSH_WEB_SECTION_NAMES);
/** Precise xAI server-side X Search operations published by the provider. */
const XAI_SERVER_X_SEARCH_NAMES = [
	"x_user_search",
	"x_keyword_search",
	"x_semantic_search",
	"x_thread_fetch"
];
const XAI_SERVER_X_SEARCH_NAME_SET = new Set(XAI_SERVER_X_SEARCH_NAMES);
/**
* Hosted / server-executed names that can leak as client function calls
* after this plugin removes DSH's implementations from the route.
*/
const HOSTED_CLIENT_LEAK_NAMES = [
	...XAI_SERVER_X_SEARCH_NAMES,
	"web_search",
	"web_fetch",
	"image_generation",
	"imagine_text_to_image",
	"imagine_image_to_image",
	"imagine_image_edit"
];
const HOSTED_CLIENT_LEAK_NAME_SET = new Set(HOSTED_CLIENT_LEAK_NAMES);
const DEFAULT_NATIVE_TOOL_POLICY = {
	enabled: true,
	image: true
};
const SEARCH_GUIDANCE = "This turn already includes this account's native hosted search. Do not call web_search or web_fetch — those DSH tools are not available on this route.";
const SEARCH_AND_IMAGE_GUIDANCE = "This turn already includes this account's native hosted search and image generation. Do not call web_search or web_fetch — those DSH tools are not available on this route.";
function responsesSearch() {
	return { type: "web_search" };
}
function responsesXSearch() {
	return { type: "x_search" };
}
function responsesImage() {
	return { type: "image_generation" };
}
function anthropicSearch() {
	return {
		type: "web_search_20250305",
		name: "web_search"
	};
}
function nativePlan(providerId, policy = DEFAULT_NATIVE_TOOL_POLICY) {
	if (!policy.enabled) return void 0;
	switch (providerId) {
		case "xai": return {
			providerId,
			hosted: [
				responsesSearch(),
				responsesXSearch(),
				...policy.image ? [responsesImage()] : []
			],
			guidance: policy.image ? SEARCH_AND_IMAGE_GUIDANCE : SEARCH_GUIDANCE
		};
		case "openai-codex": return {
			providerId,
			hosted: [responsesSearch(), ...policy.image ? [responsesImage()] : []],
			guidance: policy.image ? SEARCH_AND_IMAGE_GUIDANCE : SEARCH_GUIDANCE
		};
		case "anthropic": return {
			providerId,
			hosted: [anthropicSearch()],
			guidance: SEARCH_GUIDANCE
		};
		default: return;
	}
}
function nativePlanForRoute(route, policy = DEFAULT_NATIVE_TOOL_POLICY) {
	if (route === void 0) return void 0;
	const spec = piLoginProviderByRoute(route);
	return spec === void 0 ? void 0 : nativePlan(spec.id, policy);
}
function isDshWebToolName(name) {
	return DSH_WEB_TOOL_NAME_SET.has(name);
}
function isDshWebSectionName(name) {
	return DSH_WEB_SECTION_NAME_SET.has(name);
}
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
/**
* xAI's Responses stream currently exposes server-executed X Search details
* as custom tool calls. The outer `xs_call-*` id distinguishes those traces
* from a same-named client function, which Harness must still execute.
*/
function isXaiServerXSearchCall(block) {
	if (!isRecord(block) || block.type !== "tool-call") return false;
	if (typeof block.name !== "string" || !XAI_SERVER_X_SEARCH_NAME_SET.has(block.name)) return false;
	if (typeof block.id !== "string") return false;
	const outerId = block.id.split("|", 1)[0] ?? "";
	return /^xs_call[-_]/.test(outerId);
}
/**
* Server-executed hosted search / image traces that Harness must not try to run.
* X Search leaks use `xs_call-*`. DSH `web_search` / `web_fetch` were stripped
* from this route, so a leftover same-named call is also a leak.
*/
function isHostedServerToolCall(block) {
	if (!isRecord(block) || block.type !== "tool-call") return false;
	if (typeof block.name !== "string" || !HOSTED_CLIENT_LEAK_NAME_SET.has(block.name)) return false;
	if (isXaiServerXSearchCall(block)) return true;
	if (block.name === "web_search" || block.name === "web_fetch") return true;
	return block.name === "image_generation" || block.name.startsWith("imagine_");
}
/**
* xAI hosted search hops arrive as empty `reasoning` blocks whose signature
* id is `tco_<response>_call-…`. The UI renders each as a blank Think card.
*/
function isHostedSearchReasoningReplay(block) {
	if (!isRecord(block) || block.type !== "reasoning") return false;
	const signature = block.thinkingSignature;
	if (typeof signature !== "string" || signature.length === 0) return false;
	try {
		const parsed = JSON.parse(signature);
		return typeof parsed.id === "string" && parsed.id.startsWith("tco_");
	} catch {
		return signature.includes("\"id\":\"tco_") || signature.startsWith("tco_");
	}
}
function filterPiReplayState(replayState, dropped, forceStop) {
	if (!isRecord(replayState) || replayState.kind !== "pi-ai" || !Array.isArray(replayState.blocks)) return replayState;
	let seenText = false;
	return {
		...replayState,
		blocks: replayState.blocks.filter((block, index) => {
			if (dropped.has(index) || isHostedSearchReasoningReplay(block)) return false;
			if (isRecord(block) && block.type === "text") {
				seenText = true;
				return true;
			}
			if (seenText && isRecord(block) && block.type === "reasoning") return false;
			return true;
		}),
		...forceStop ? { stopReason: "stop" } : {}
	};
}
function isEmptyReasoningText(text) {
	return text.trim().length === 0;
}
/**
* Remove hosted server-side search / image traces after pi-ai 0.82.1 has
* mistaken them for client function calls. Other blocks retain stream order,
* actual client tools survive, and pi-ai replay metadata stays index-aligned.
*/
async function* filterHostedServerToolTraces(source) {
	const dropped = /* @__PURE__ */ new Set();
	const pending = /* @__PURE__ */ new Set();
	const reasoning = /* @__PURE__ */ new Map();
	let buffered = [];
	let keptToolCalls = 0;
	let textStarted = false;
	const flush = function* () {
		for (const item of buffered) {
			if ("index" in item && dropped.has(item.index)) continue;
			yield item;
		}
		buffered = [];
	};
	const closeReasoning = function* (index, end) {
		const held = reasoning.get(index);
		if (held === void 0) {
			if (end !== void 0) yield end;
			return;
		}
		reasoning.delete(index);
		const ended = end?.type === "block-end" && end.block.type === "reasoning" ? end.block.text : "";
		const text = ended.length > 0 ? ended : held.text;
		if (held.afterText || isEmptyReasoningText(text)) return;
		yield* held.chunks;
		if (end !== void 0) yield end;
	};
	for await (const chunk of source) {
		if (chunk.type === "block-start" && chunk.blockType === "text" || chunk.type === "text-delta") textStarted = true;
		if (chunk.type === "block-start" && chunk.blockType === "reasoning") {
			reasoning.set(chunk.index, {
				chunks: [chunk],
				text: "",
				afterText: textStarted
			});
			continue;
		}
		if (chunk.type === "reasoning-delta" && reasoning.has(chunk.index)) {
			const held = reasoning.get(chunk.index);
			if (held !== void 0) {
				held.chunks.push(chunk);
				held.text += chunk.text;
			}
			continue;
		}
		if (chunk.type === "block-end" && chunk.block.type === "reasoning") {
			yield* closeReasoning(chunk.index, chunk);
			continue;
		}
		if (chunk.type === "block-start" && chunk.blockType === "tool-call") {
			pending.add(chunk.index);
			buffered.push(chunk);
			continue;
		}
		if (pending.size > 0) {
			buffered.push(chunk);
			if (chunk.type === "block-end" && chunk.block.type === "tool-call" && pending.has(chunk.index)) {
				if (isHostedServerToolCall(chunk.block)) dropped.add(chunk.index);
				else keptToolCalls += 1;
				pending.delete(chunk.index);
				if (pending.size === 0) yield* flush();
			}
			continue;
		}
		if (chunk.type === "finish") {
			for (const index of [...reasoning.keys()]) yield* closeReasoning(index);
			const forceStop = chunk.reason.kind === "tool-calls" && dropped.size > 0 && keptToolCalls === 0;
			yield {
				...chunk,
				...forceStop ? { reason: { kind: "stop" } } : {},
				replayState: filterPiReplayState(chunk.replayState, dropped, forceStop)
			};
			continue;
		}
		yield chunk;
	}
	for (const index of [...reasoning.keys()]) yield* closeReasoning(index);
	if (buffered.length > 0) yield* flush();
}
/** @deprecated Use {@link filterHostedServerToolTraces}. */
const filterXaiServerToolTraces = filterHostedServerToolTraces;
/** A function-calling tool DSH registered as web_search / web_fetch. */
function isDshWebFunctionTool(tool) {
	if (!isRecord(tool)) return false;
	const name = typeof tool.name === "string" ? tool.name : void 0;
	if (name === void 0 || !isDshWebToolName(name)) return false;
	const type = tool.type;
	return type === void 0 || type === "function";
}
function hostedToolKey(tool) {
	return `${typeof tool.type === "string" ? tool.type : "function"}:${typeof tool.name === "string" ? tool.name : ""}`;
}
function applyNativeToolsToPayload(payload, providerId, policy = DEFAULT_NATIVE_TOOL_POLICY) {
	const plan = nativePlan(providerId, policy);
	if (plan === void 0 || !isRecord(payload)) return payload;
	const kept = (Array.isArray(payload.tools) ? payload.tools : []).filter((tool) => !isDshWebFunctionTool(tool));
	const seen = new Set(kept.filter(isRecord).map((tool) => hostedToolKey(tool)));
	const hosted = plan.hosted.filter((tool) => {
		const key = hostedToolKey(tool);
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
	return {
		...payload,
		tools: [...hosted, ...kept]
	};
}
function wrapOnPayload(existing, providerId, policy = DEFAULT_NATIVE_TOOL_POLICY) {
	if (nativePlan(providerId, policy) === void 0) return existing;
	return async (payload, model) => {
		const injected = applyNativeToolsToPayload(payload, providerId, policy);
		if (existing === void 0) return injected;
		return await existing(injected, model);
	};
}
function filterPiContext(context, providerId, policy = DEFAULT_NATIVE_TOOL_POLICY) {
	if (nativePlan(providerId, policy) === void 0 || context.tools === void 0) return context;
	return {
		...context,
		tools: context.tools.filter((tool) => !isDshWebToolName(tool.name))
	};
}
function maskDshWebAssembly(assembly, plan) {
	return {
		...assembly,
		tools: assembly.tools.filter((tool) => !isDshWebToolName(tool.name)),
		sections: [...assembly.sections.filter((section) => !isDshWebSectionName(section.name)), {
			name: "oauth:native-tools",
			text: plan.guidance
		}]
	};
}
//#endregion
//#region src/adapter.ts
/** One PiAiAdapter covering every Pi-login harness route. */
/**
* Official Pi adapter plus Chat copy. `dsh-llm-retry` still owns the attempt
* budget and routes on `code`. Provider 429/quota usually arrive as finish
* chunks, not thrown errors, so both paths get the same hint.
*/
var PiLoginAdapter = class extends PiAiAdapter {
	native;
	resolveAttachments;
	constructor(config, native, resolveAttachments) {
		super(config);
		this.native = native;
		this.resolveAttachments = resolveAttachments;
	}
	async *stream(options) {
		const capture = { images: [] };
		const sanitized = {
			...options,
			messages: stripAssistantImages(options.messages)
		};
		try {
			const raw = iterateInCapture(capture, super.stream(sanitized));
			const filtered = (this.native.enabled ? nativePlanForRoute(sanitized.provider, this.native) : void 0) === void 0 ? raw : filterHostedServerToolTraces(raw);
			const attachments = this.native.image ? this.resolveAttachments() : void 0;
			const source = attachments === void 0 ? filtered : injectHostedImages(filtered, capture, (input) => attachments.saveImage(input));
			for await (const chunk of source) {
				if (chunk.type === "finish" && chunk.reason.kind === "error") {
					yield {
						...chunk,
						reason: {
							...chunk.reason,
							failure: hintFailure(chunk.reason.failure)
						}
					};
					continue;
				}
				yield chunk;
			}
		} catch (error) {
			throw withModelErrorHint(error);
		}
	}
};
function createPiLoginAdapter(session, resolveAttachments, options = {}) {
	const streamIdleTimeoutMs = options.streamIdleTimeoutMs ?? 3e5;
	const retryPolicy = resolveRetryPolicy(options.retryPolicy, "dsh-oauth-login retryPolicy");
	return new PiLoginAdapter({
		profiles: () => {
			const profiles = /* @__PURE__ */ new Map();
			for (const spec of PI_LOGIN_PROVIDERS) profiles.set(spec.route, {
				provider: spec.route,
				displayName: spec.displayName,
				streamIdleTimeoutMs,
				retryPolicy,
				configuredMaxTokens: /* @__PURE__ */ new Map(),
				piProvider: session.provider(spec.id)
			});
			return profiles;
		},
		resolveApiKey: async (route) => {
			await session.ensureTransport();
			const spec = piLoginProviderByRoute(route);
			if (spec === void 0) throw new LlmError(`dsh-oauth-login: unknown route "${route}"`, "MISSING_CREDENTIAL");
			const apiKey = (await session.models.getAuth(spec.id))?.auth.apiKey;
			if (apiKey === void 0 || apiKey.length === 0) throw new LlmError(`${spec.displayName} is not signed in. Open Settings → OAuth Login and sign in.`, "MISSING_CREDENTIAL");
			return apiKey;
		},
		resolveAttachments
	}, session.native, resolveAttachments);
}
//#endregion
//#region src/responses-tap.ts
/** Peek Responses SSE for hosted image_generation_call items pi-ai ignores. */
const TAPPED = Symbol("dsh-oauth-hosted-tap");
function requestUrl(input) {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.href;
	return input.url;
}
function requestMethod(input, init) {
	if (init?.method !== void 0) return init.method.toUpperCase();
	if (typeof input !== "string" && !(input instanceof URL) && input.method.length > 0) return input.method.toUpperCase();
	return "GET";
}
function isResponsesRequest(input, init) {
	if (requestMethod(input, init) !== "POST") return false;
	try {
		const path = new URL(requestUrl(input)).pathname;
		return path === "/responses" || path.endsWith("/responses");
	} catch {
		return false;
	}
}
function parseSseBlock(block) {
	const data = block.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n").trim();
	if (data.length === 0 || data === "[DONE]") return void 0;
	try {
		return JSON.parse(data);
	} catch {
		return;
	}
}
function consumeResponsesSseText(text, onEvent) {
	const parts = text.split(/\r?\n\r?\n/);
	const rest = parts.pop() ?? "";
	for (const block of parts) {
		const event = parseSseBlock(block);
		if (event !== void 0) onEvent(event);
	}
	return rest;
}
function peekResponsesBody(body, onEvent) {
	const decoder = new TextDecoder();
	let buffer = "";
	return body.pipeThrough(new TransformStream({
		transform(chunk, controller) {
			controller.enqueue(chunk);
			buffer = consumeResponsesSseText(buffer + decoder.decode(chunk, { stream: true }), onEvent);
		},
		flush(controller) {
			if (buffer.length === 0) return;
			const event = parseSseBlock(buffer);
			if (event !== void 0) onEvent(event);
		}
	}));
}
function tapResponsesResponse(response, onEvent) {
	if (response.body === null) return response;
	return new Response(peekResponsesBody(response.body, onEvent), response);
}
function wrapFetchForHostedOutput(fetchImpl) {
	return async (input, init) => {
		const capture = currentHostedCapture();
		if (capture === void 0 || !isResponsesRequest(input, init)) return await fetchImpl(input, init);
		return tapResponsesResponse(await fetchImpl(input, init), (event) => collectHostedImagesFromEvent(event, capture.images));
	};
}
function installHostedOutputFetch() {
	const current = globalThis.fetch;
	if (current[TAPPED] === true) return;
	const next = Object.assign(wrapFetchForHostedOutput(current), { [TAPPED]: true });
	globalThis.fetch = next;
}
//#endregion
//#region src/http.ts
/** Proxy-aware HTTP transport for OAuth and subscribed-provider requests. */
const originalFetch = globalThis.fetch;
let installedFetch;
const DEFAULT_LOOPBACK_PROXY_CANDIDATES = [
	"http://127.0.0.1:7890",
	"http://127.0.0.1:45678",
	"http://127.0.0.1:7891",
	"http://127.0.0.1:8080",
	"http://127.0.0.1:8888"
];
const PROXY_ENV_KEYS = [
	"HTTPS_PROXY",
	"https_proxy",
	"HTTP_PROXY",
	"http_proxy",
	"ALL_PROXY",
	"all_proxy"
];
function normalizeProxyUrl(value) {
	const trimmed = value.trim();
	if (trimmed.length === 0) throw new Error("dsh-oauth-login: proxy URL is empty");
	const url = new URL(trimmed.includes("://") ? trimmed : `http://${trimmed}`);
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`dsh-oauth-login: unsupported proxy protocol "${url.protocol}"`);
	if (url.hostname.length === 0) throw new Error("dsh-oauth-login: proxy URL has no host");
	url.pathname = "/";
	url.search = "";
	url.hash = "";
	return url.toString();
}
function inheritedProxy(env) {
	for (const key of PROXY_ENV_KEYS) {
		const value = env[key];
		if (value !== void 0 && value.trim().length > 0) return value;
	}
}
function scutilValue(output, key) {
	const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return output.match(new RegExp(`^\\s*${escaped}\\s*:\\s*(.+?)\\s*$`, "m"))?.[1];
}
function parseMacOSSystemProxy(output) {
	for (const kind of ["HTTPS", "HTTP"]) {
		if (scutilValue(output, `${kind}Enable`) !== "1") continue;
		const host = scutilValue(output, `${kind}Proxy`);
		const port = Number(scutilValue(output, `${kind}Port`));
		if (host === void 0 || host.length === 0 || !Number.isInteger(port) || port <= 0 || port > 65535) continue;
		return normalizeProxyUrl(`http://${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}:${port}`);
	}
}
async function readMacOSSystemProxy() {
	return await new Promise((resolve) => {
		execFile("/usr/sbin/scutil", ["--proxy"], {
			encoding: "utf8",
			timeout: 1500,
			maxBuffer: 131072
		}, (error, stdout) => resolve(error === null ? parseMacOSSystemProxy(stdout) : void 0));
	});
}
function isLoopbackProxy(proxyUrl) {
	const hostname = new URL(proxyUrl).hostname.replace(/^\[(.*)\]$/, "$1").toLowerCase();
	return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
}
/**
* Verify that a candidate is an HTTP CONNECT proxy. The probe contains no
* OAuth code, credential, token, cookie, or geographic metadata.
*/
async function probeHttpConnectProxy(proxyUrl) {
	const url = new URL(proxyUrl);
	if (url.protocol !== "http:") return false;
	const port = Number(url.port || "80");
	if (!Number.isInteger(port) || port <= 0 || port > 65535) return false;
	return await new Promise((resolve) => {
		const socket = connect({
			host: url.hostname,
			port
		});
		let settled = false;
		let response = "";
		const finish = (accepted) => {
			if (settled) return;
			settled = true;
			socket.destroy();
			resolve(accepted);
		};
		socket.setTimeout(800);
		socket.once("connect", () => {
			socket.write("CONNECT auth.openai.com:443 HTTP/1.1\r\nHost: auth.openai.com:443\r\nConnection: close\r\n\r\n");
		});
		socket.on("data", (chunk) => {
			response += chunk.toString("latin1");
			const lineEnd = response.indexOf("\r\n");
			if (lineEnd >= 0) finish(/^HTTP\/1\.[01] 200(?:\s|$)/.test(response.slice(0, lineEnd)));
			else if (response.length > 16384) finish(false);
		});
		socket.once("timeout", () => finish(false));
		socket.once("error", () => finish(false));
		socket.once("end", () => finish(/^HTTP\/1\.[01] 200(?:\s|$)/.test(response)));
	});
}
async function resolveOAuthProxy(options = {}) {
	const env = options.env ?? process.env;
	if (inheritedProxy(env) !== void 0) return { source: "environment" };
	const explicit = env.DSH_OAUTH_PROXY;
	if (explicit !== void 0 && explicit.trim().length > 0) return {
		source: "explicit",
		proxyUrl: normalizeProxyUrl(explicit)
	};
	const probe = options.probe ?? probeHttpConnectProxy;
	if ((options.platform ?? process.platform) === "darwin") {
		const systemProxy = await (options.readSystemProxy ?? readMacOSSystemProxy)();
		if (systemProxy !== void 0) {
			const normalized = normalizeProxyUrl(systemProxy);
			if (await probe(normalized)) return {
				source: "system",
				proxyUrl: normalized
			};
		}
	}
	const normalizedCandidates = (options.candidates ?? DEFAULT_LOOPBACK_PROXY_CANDIDATES).flatMap((candidate) => {
		try {
			const normalized = normalizeProxyUrl(candidate);
			return isLoopbackProxy(normalized) ? [normalized] : [];
		} catch {
			return [];
		}
	});
	const selected = (await Promise.all(normalizedCandidates.map(async (candidate) => {
		try {
			return await probe(candidate);
		} catch {
			return false;
		}
	}))).findIndex(Boolean);
	if (selected >= 0) return {
		source: "loopback",
		proxyUrl: normalizedCandidates[selected]
	};
	return { source: "direct" };
}
function noProxyValue(env) {
	const entries = new Set((env.NO_PROXY ?? env.no_proxy ?? "").split(/[\s,]+/).filter(Boolean));
	entries.add("localhost");
	entries.add("127.0.0.1");
	entries.add("::1");
	return [...entries].join(",");
}
function inheritedProxyOptions(env) {
	const allProxy = env.ALL_PROXY ?? env.all_proxy ?? "";
	return {
		httpProxy: env.HTTP_PROXY ?? env.http_proxy ?? allProxy,
		httpsProxy: env.HTTPS_PROXY ?? env.https_proxy ?? allProxy
	};
}
async function configureOAuthHttpTransport(options = {}) {
	const env = options.env ?? process.env;
	const resolution = await resolveOAuthProxy({
		...options,
		env
	});
	const selectedProxy = "proxyUrl" in resolution ? resolution.proxyUrl : void 0;
	const inherited = inheritedProxyOptions(env);
	const dispatcher = new EnvHttpProxyAgent({
		allowH2: false,
		httpProxy: selectedProxy ?? inherited.httpProxy,
		httpsProxy: selectedProxy ?? inherited.httpsProxy,
		noProxy: noProxyValue(env)
	});
	setGlobalDispatcher(dispatcher);
	if (installedFetch === void 0 ? globalThis.fetch === originalFetch : globalThis.fetch === installedFetch) {
		install();
		installedFetch = globalThis.fetch;
	}
	installHostedOutputFetch();
	return resolution;
}
//#endregion
//#region src/extra-models.ts
const EXTRA_MODELS_BY_PROVIDER = { xai: [{
	id: "grok-4.6",
	name: "Grok 4.6",
	api: "openai-responses",
	provider: "xai",
	baseUrl: "https://api.x.ai/v1",
	reasoning: true,
	input: ["text", "image"],
	cost: {
		input: 2,
		output: 6,
		cacheRead: .3,
		cacheWrite: 0
	},
	contextWindow: 5e5,
	maxTokens: 5e5,
	compat: { supportsLongCacheRetention: false },
	thinkingLevelMap: {
		off: null,
		minimal: null,
		low: "low",
		medium: "medium",
		high: "high",
		xhigh: "xhigh",
		max: null
	}
}] };
/**
* Extra models this plugin publishes for one pi-ai provider id.
* @param providerId - catalog provider id (e.g. `xai`), not the harness route.
*/
function extraModelsFor(providerId) {
	return EXTRA_MODELS_BY_PROVIDER[providerId] ?? [];
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
	if (base === void 0) throw new Error(`dsh-oauth-login: the installed pi-ai catalog ships no "${id}" provider`);
	return base;
}
/**
* Catalog models plus plugin-owned extras, remapped onto the harness route.
* Extras fill gaps the installed pi-ai version has not shipped yet (e.g. grok-4.6).
*/
function harnessModels(spec) {
	const base = catalogProvider(spec.id).getModels();
	const seen = new Set(base.map((model) => model.id));
	const merged = [...base];
	for (const extra of extraModelsFor(spec.id)) {
		if (seen.has(extra.id)) continue;
		seen.add(extra.id);
		merged.push(extra);
	}
	return merged.map((model) => model.provider === spec.route ? model : {
		...model,
		provider: spec.route
	});
}
function preferredModel(spec, models = harnessModels(spec)) {
	const ids = new Set(models.map((model) => model.id));
	for (const candidate of spec.preferredModels) if (ids.has(candidate)) return candidate;
	return models[0]?.id ?? spec.id;
}
function harnessProvider(spec, native = DEFAULT_NATIVE_TOOL_POLICY) {
	const base = catalogProvider(spec.id);
	return {
		id: spec.route,
		name: spec.displayName,
		...base.baseUrl === void 0 ? {} : { baseUrl: base.baseUrl },
		auth: {
			...base.auth,
			apiKey: harnessApiKeyAuth(spec.displayName)
		},
		getModels: () => harnessModels(spec),
		stream: (model, context, options) => {
			const onPayload = wrapOnPayload(options?.onPayload, spec.id, native);
			return base.stream(model, filterPiContext(context, spec.id, native), onPayload === options?.onPayload ? options : {
				...options,
				onPayload
			});
		},
		streamSimple: (model, context, options) => {
			const onPayload = wrapOnPayload(options?.onPayload, spec.id, native);
			return base.streamSimple(model, filterPiContext(context, spec.id, native), onPayload === options?.onPayload ? options : {
				...options,
				onPayload
			});
		}
	};
}
function allCatalogProviders() {
	return PI_LOGIN_PROVIDERS.map((spec) => catalogProvider(spec.id));
}
//#endregion
//#region src/store.ts
/**
* Multi-provider OAuth store. File is $DSH_HOME/.dsh-oauth-auth.json.
* The old .pi-login-auth.json name is read only as a DSH-owned migration source.
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
	legacyFilename;
	constructor(filename = piLoginAuthPath()) {
		this.filename = resolve(filename);
		this.legacyFilename = basename(this.filename) === ".dsh-oauth-auth.json" ? resolve(join(dirname(this.filename), LEGACY_PI_LOGIN_AUTH_FILENAME)) : void 0;
	}
	async readDocument() {
		const candidates = [this.filename, ...this.legacyFilename === void 0 ? [] : [this.legacyFilename]];
		for (const filename of candidates) {
			await assertOwnerOnly(filename);
			try {
				return parseDocument(await readFile(filename, "utf8"), filename);
			} catch (error) {
				if (isENOENT(error)) continue;
				throw error;
			}
		}
		return {
			version: AUTH_FORMAT_VERSION,
			credentials: {}
		};
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
/** DSH-owned models.login() for every subscribed provider in the catalog. */
async function loginPiProvider(providerId, interaction, store = new PiLoginCredentialStore()) {
	requirePiLoginProvider(providerId);
	await configureOAuthHttpTransport();
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
	requirePiLoginProvider(providerId);
	await session.ensureTransport();
	session.models.setProvider(catalogProvider(providerId));
	await session.models.login(providerId, "oauth", interaction);
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
const PI_LOGIN_AUTH_STATUS_PATH = "/plugins/dsh-oauth-login/auth/status";
const PI_LOGIN_AUTH_LOGIN_PATH = "/plugins/dsh-oauth-login/auth/login";
const PI_LOGIN_AUTH_LOGOUT_PATH = "/plugins/dsh-oauth-login/auth/logout";
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
	/** Wait until an in-flight sign-in settles (success or error). No-op if idle. */
	async waitUntilSettled() {
		await this.operation?.catch(() => void 0);
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
	session;
	byId = /* @__PURE__ */ new Map();
	constructor(session) {
		this.session = session;
		for (const spec of PI_LOGIN_PROVIDERS) this.byId.set(spec.id, new ProviderAuth(spec, session));
	}
	slot(id) {
		const slot = this.byId.get(id);
		if (slot === void 0) throw new Error(`dsh-oauth-login: unknown provider "${id}"`);
		return slot;
	}
	async status() {
		await this.session.refreshStoredGrants();
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
	/** Wait until the named provider's in-flight sign-in settles. */
	async waitUntilSettled(id) {
		requirePiLoginProvider(id);
		await this.slot(id).waitUntilSettled();
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
function registerPiLoginAuthRoutes(ctx, session, options = {}) {
	const auth = new PiLoginWebAuth(session);
	const notifyAuthChanged = async () => {
		await options.onAuthChanged?.();
	};
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
						const challenge = await auth.signIn(providerIdFrom(await readJson(req)));
						auth.waitUntilSettled(challenge.provider).then(async () => {
							await notifyAuthChanged();
						});
						json(res, 200, challenge);
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
						await notifyAuthChanged();
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
	}, "dsh-oauth-login: Web OAuth routes");
}
//#endregion
//#region src/oauth-refresh.ts
/**
* When to spend a refresh_token. Chat already refreshes via Models.getAuth;
* this helper is for status / boot / the host timer so the store does not sit
* on a stale expires stamp.
*/
/** Refresh when the stored access stamp is inside this window (Pi already skews expires by 5 min). */
const OAUTH_REFRESH_SOON_MS = 9e5;
/** Host timer. Access lives ~6h; this is just how often we look. */
const OAUTH_REFRESH_POLL_MS = 9e5;
const lastAttempt = /* @__PURE__ */ new Map();
function grantNeedsRefresh(expires, now = Date.now()) {
	return now >= expires - OAUTH_REFRESH_SOON_MS;
}
function refreshAttemptKey(storeId, providerId) {
	return `${storeId}\0${providerId}`;
}
function refreshOnCooldown(key, now = Date.now()) {
	const previous = lastAttempt.get(key);
	return previous !== void 0 && now - previous < 3e5;
}
function markRefreshAttempt(key, now = Date.now()) {
	lastAttempt.set(key, now);
}
async function refreshGrant(getAuth, providerId) {
	try {
		await getAuth(providerId);
		return "ok";
	} catch {
		return "failed";
	}
}
//#endregion
//#region src/session.ts
/** Shared OAuth store + catalog for the host plugin and CLI. */
var PiLoginSession = class {
	store;
	models;
	native;
	transportPromise;
	constructor(store = new PiLoginCredentialStore(), native = DEFAULT_NATIVE_TOOL_POLICY) {
		this.store = store;
		this.native = native;
		this.models = createModels({ credentials: store });
		for (const provider of allCatalogProviders()) this.models.setProvider(provider);
	}
	ensureTransport() {
		if (this.transportPromise !== void 0) return this.transportPromise;
		const pending = configureOAuthHttpTransport();
		this.transportPromise = pending;
		pending.catch(() => {
			if (this.transportPromise === pending) this.transportPromise = void 0;
		});
		return pending;
	}
	spec(id) {
		const spec = piLoginProvider(id);
		if (spec === void 0) throw new Error(`dsh-oauth-login: unknown provider "${id}"`);
		return spec;
	}
	provider(id) {
		return harnessProvider(this.spec(id), this.native);
	}
	visibleModels(id) {
		return this.provider(id).getModels();
	}
	/**
	* Harness routes that currently hold a stored OAuth grant.
	* Model pickers should only advertise these — logging out must drop the route.
	*/
	async authenticatedRoutes() {
		const signedIn = new Set((await this.store.list()).map((item) => item.providerId));
		return PI_LOGIN_PROVIDERS.filter((provider) => signedIn.has(provider.id)).map((provider) => provider.route);
	}
	async logout(id) {
		await this.store.delete(id);
	}
	/**
	* Renew access tokens that are expired or close to expiry.
	* Failures stay in the store; the next poll or chat retries.
	*/
	async refreshStoredGrants(now = Date.now()) {
		await this.ensureTransport();
		for (const { providerId } of await this.store.list()) {
			const credential = await this.store.read(providerId);
			if (credential?.type !== "oauth" || !grantNeedsRefresh(credential.expires, now)) continue;
			const key = refreshAttemptKey(this.store.filename, providerId);
			if (refreshOnCooldown(key, now)) continue;
			markRefreshAttempt(key, now);
			await refreshGrant((id) => this.models.getAuth(id), providerId);
		}
	}
};
//#endregion
//#region src/plugin-config.ts
/** Provider-owned knobs published on the `llm-oauth-login` row. */
const Config = z.object({
	streamIdleTimeoutMs: z.number().min(1).default(PI_LOGIN_STREAM_IDLE_TIMEOUT_MS),
	retryPolicy: RetryPolicySchema,
	nativeTools: z.boolean().default(true),
	nativeImage: z.boolean().default(true)
});
//#endregion
//#region src/index.ts
const name = "llm-oauth-login";
const inject = ["llm"];
/**
* Publish only the routes that currently hold an OAuth grant.
* Logging out must drop that route from the model picker immediately.
*/
async function syncAuthenticatedRoutes(session, registration) {
	registration.replace(await session.authenticatedRoutes());
}
function apply(ctx, config) {
	console.log("[my-plugins/dsh-oauth-login] loaded");
	const native = {
		enabled: config.nativeTools !== false,
		image: config.nativeImage !== false
	};
	const session = new PiLoginSession(new PiLoginCredentialStore(), native);
	const registration = ctx.llm.registerAdapter(piLoginRoutes(), createPiLoginAdapter(session, () => ctx.get("attachments"), {
		streamIdleTimeoutMs: config.streamIdleTimeoutMs,
		retryPolicy: config.retryPolicy
	}));
	const refreshRoutes = () => syncAuthenticatedRoutes(session, registration);
	refreshRoutes();
	ctx.effect(() => {
		const timer = setInterval(() => {
			session.refreshStoredGrants();
		}, OAUTH_REFRESH_POLL_MS);
		session.refreshStoredGrants();
		return () => clearInterval(timer);
	}, "dsh-oauth-login: refresh oauth grants");
	ctx.inject(["webServer"], (webCtx) => {
		registerPiLoginAuthRoutes(webCtx, session, { onAuthChanged: refreshRoutes });
	});
	ctx.inject(["systemPrompt"], (promptCtx) => {
		promptCtx.on("system-prompt/assemble", async (_assembly, context, next) => {
			const assembled = await next();
			const plan = nativePlanForRoute(context.agent?.options?.provider, session.native);
			return plan === void 0 ? assembled : maskDshWebAssembly(assembled, plan);
		});
	});
}
//#endregion
export { Config, DEFAULT_NATIVE_TOOL_POLICY, LEGACY_PI_LOGIN_AUTH_FILENAME, OAUTH_REFRESH_POLL_MS, OAUTH_REFRESH_SOON_MS, PI_LOGIN_AUTH_FILENAME, PI_LOGIN_AUTH_LOGIN_PATH, PI_LOGIN_AUTH_LOGOUT_PATH, PI_LOGIN_AUTH_STATUS_PATH, PI_LOGIN_BOOT_MARKER, PI_LOGIN_PROVIDERS, PI_LOGIN_ROUTE_PREFIX, PI_LOGIN_STREAM_IDLE_TIMEOUT_MS, PiLoginCredentialStore, PiLoginSession, QUOTA_HINT, RATE_LIMIT_HINT, TRANSIENT_HINT, TRANSIENT_MODEL_CODES, apply, applyNativeToolsToPayload, catalogProvider, collectHostedImagesFromEvent, createPiLoginAdapter, decodeHostedImage, extraModelsFor, filterHostedServerToolTraces, filterXaiServerToolTraces, grantNeedsRefresh, harnessModels, harnessProvider, hintFailure, hintForCode, inject, injectHostedImages, isHostedSearchReasoningReplay, isHostedServerToolCall, isSafeAuthUrl, isXaiServerXSearchCall, loginPiProvider, loginPiProviderSession, logoutPiProvider, name, nativePlan, nativePlanForRoute, piLoginAuthPath, piLoginProvider, piLoginRoutes, piLoginStatus, preferredModel, registerPiLoginAuthRoutes, safeMessage, sniffImageMediaType, stripAssistantImages, withModelErrorHint };
