// Real Harness loop + built external plugin + real Pi Codex transport.
// Only the wire is synthetic. No production profile, credentials or network.
// Usage: node scripts/verify-network-recovery.mjs <harness-root> [result.json] [installed-plugin-root]
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire, findPackageJSON } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { zstdDecompressSync } from 'node:zlib';

const [harnessRoot, outputPath, installedPluginRoot] = process.argv.slice(2);
if (!harnessRoot) throw new Error('Pass the read-only Harness checkout root.');
const pluginRoot = installedPluginRoot ? resolve(installedPluginRoot) : fileURLToPath(new URL('..', import.meta.url));
const requirePlugin = createRequire(join(pluginRoot, 'package.json'));
const load = relative => import(pathToFileURL(join(harnessRoot, relative, 'lib/index.js')));
const { Context } = await import(pathToFileURL(requirePlugin.resolve('@deepseek-ai/cordis')));
const { default: LlmRuntime, createUserMessage, resolveRetryPolicy } = await load('packages/llm/llm');
const { default: SessionStore, SessionId } = await load('packages/core/session');
const { default: SystemPrompt } = await load('packages/core/system-prompt');
const { default: ToolRuntime } = await load('packages/core/tools');
const { default: AgentRegistry } = await load('packages/core/agent');
const { default: AgentLoop } = await load('packages/core/agent-loop');
const Retry = await load('packages/llm/llm-retry');
const pluginEntry = pathToFileURL(join(pluginRoot, 'lib/index.js'));
const { createPiLoginAdapter, PiLoginSession, PiLoginCredentialStore } = await import(pluginEntry);
const piPackage = findPackageJSON('@earendil-works/pi-ai', pluginEntry);
const pi = await import(pathToFileURL(join(dirname(piPackage), 'dist/api/openai-codex-responses.js')));
const policy = resolveRetryPolicy(undefined);
assert.equal(policy.maxRetries, 5);

const previous = { fetch: globalThis.fetch, WebSocket: globalThis.WebSocket };
const temporary = await mkdtemp(join(tmpdir(), 'dsh-network-recovery-'));
const results = [];
let active;

function textEvents(text = 'recovered response') {
  const item = { type: 'message', id: 'probe-message', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text, annotations: [] }] };
  return [
    { type: 'response.created', response: { id: `probe-response-${active.counts.attempts}` } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
    { type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: text },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id: `probe-response-${active.counts.attempts}`, status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
  ];
}
function toolEvents() {
  const item = { type: 'function_call', id: 'fc_probe', call_id: 'call_probe', name: 'network_probe', arguments: '{}' };
  return [
    { type: 'response.created', response: { id: 'probe-tool-response' } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{}' },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id: 'probe-tool-response', status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
  ];
}

class WireWebSocket extends EventTarget {
  static OPEN = 1;
  static CLOSED = 3;
  readyState = 0;
  timers = new Set();
  constructor(url) {
    super();
    assert.equal(new URL(url).hostname, 'chatgpt.com');
    active.counts.wsConnections++;
    this.later(() => { this.readyState = 1; this.dispatchEvent(new Event('open')); }, 0);
  }
  later(callback, delay) {
    const timer = setTimeout(() => { this.timers.delete(timer); callback(); }, delay);
    this.timers.add(timer);
  }
  emit(events) {
    for (const event of events) this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(event) }));
  }
  send(payload) {
    assert.equal(JSON.parse(payload).type, 'response.create');
    active.counts.wsRequests++;
    if (active.scenario === 'connection-settings') {
      this.later(() => this.emit(textEvents()), 0);
      return;
    }
    if (active.scenario === 'tool-checkpoint' && active.counts.attempts === 1) {
      this.later(() => this.emit(toolEvents()), 0);
      return;
    }
    if (active.scenario !== 'before-first-event') {
      this.later(() => this.emit(active.scenario === 'partial-output'
        ? textEvents('discard failed text').slice(0, 4)
        : textEvents().slice(0, 1)), 0);
    }
    this.later(() => {
      if (active.scenario === 'cancel') active.agent.cancel({ kind: 'user' });
      else this.dispatchEvent(new Event('error'));
    }, 20);
  }
  close() {
    this.readyState = 3;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }
}

// Install after importing the plugin so its runtime preserves this test wire.
globalThis.WebSocket = WireWebSocket;
globalThis.fetch = async (url, init) => {
  assert.equal(new URL(url).hostname, 'chatgpt.com');
  active.counts.httpRequests++;
  if (active.scenario === 'budget-exhausted') throw new TypeError('fetch failed');
  if (active.scenario === 'auth-stops') return new Response('{"error":{"message":"synthetic unauthorized"}}', { status: 401 });
  if (active.scenario === 'tool-checkpoint') {
    const encoding = new Headers(init.headers).get('content-encoding');
    const body = encoding === 'zstd' ? zstdDecompressSync(init.body).toString('utf8')
      : typeof init.body === 'string' ? init.body : Buffer.from(init.body).toString('utf8');
    const input = JSON.parse(body).input;
    active.inputTypes = input.map(item => item.type ?? item.role);
    assert.ok(input.some(item => item.type === 'function_call_output'), `Missing checkpoint output: ${active.inputTypes.join(',')}`);
  }
  return new Response(textEvents().map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  });
};

async function send(agent) {
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'keyless network regression' }], source: { kind: 'user' } }));
  await agent.whenIdle();
}

try {
  for (const scenario of ['after-first-event', 'before-first-event', 'partial-output', 'tool-checkpoint', 'cancel', 'auth-stops', 'connection-settings', 'budget-exhausted']) {
    const ctx = new Context();
    const id = SessionId(`network-${scenario}`);
    let session;
    let unregister;
    active = { scenario, counts: { attempts: 0, wsConnections: 0, wsRequests: 0, httpRequests: 0, toolExecutions: 0 }, sessionIds: [] };
    const start = Date.now();
    try {
      for (const plugin of [LlmRuntime, SessionStore, SystemPrompt, ToolRuntime, AgentRegistry, Retry]) await ctx.plugin(plugin);
      await ctx.plugin(AgentLoop, { agents: [] });
      session = new PiLoginSession(new PiLoginCredentialStore(join(temporary, scenario, 'auth.json')),
        { enabled: false, image: false }, undefined, { env: {}, platform: 'linux', candidates: [] });
      const claim = Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'synthetic-account' } })).toString('base64');
      await session.store.modify('openai-codex', async () => ({ type: 'oauth', access: `synthetic.${claim}.unsigned`, refresh: 'synthetic-refresh', expires: Date.now() + 3_600_000 }));
      const adapter = createPiLoginAdapter(session, () => undefined);
      const prepare = adapter.prepareCall.bind(adapter);
      adapter.prepareCall = async (...args) => {
        const prepared = await prepare(...args);
        return { ...prepared, stream: options => {
          active.counts.attempts++;
          active.sessionIds.push(String(options.sessionId));
          return prepared.stream(options);
        } };
      };
      unregister = ctx.llm.registerAdapter(['pi-openai-codex'], adapter);
      ctx.tools.register({ name: 'network_probe', description: 'Local counter only', parameters: { type: 'object', properties: {} },
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
        execute: async () => { active.counts.toolExecutions++; return 'executed-once'; } });
      const agent = ctx.agentLoop.create(id, { provider: 'pi-openai-codex', model: 'gpt-5.6-sol' });
      active.agent = agent;
      await send(agent);
      if (scenario === 'connection-settings') {
        await send(agent);
        assert.equal(active.counts.wsConnections, 1, 'unchanged settings reuse the original WS');
        await session.proxy.save({ ...(await session.proxy.settings.read()), websocket: { enabled: false, url: '' } });
        await send(agent);
        assert.equal(active.counts.wsConnections, 2, 'changed WS settings retire the cached connection');
        await session.proxy.save({ ...(await session.proxy.settings.read()), http: { enabled: false, url: '' } });
        await send(agent);
        assert.equal(active.counts.wsConnections, 2, 'HTTP-only change does not retire a direct WS');
      }
      if (scenario === 'after-first-event') {
        assert.equal(pi.getOpenAICodexWebSocketDebugStats(id).websocketFallbackActive, true);
        await session.proxy.save({ ...(await session.proxy.settings.read()), websocket: { enabled: false, url: '' } });
        await send(agent);
        assert.equal(active.counts.wsConnections, 1, 'saving settings must not erase the SSE fallback latch');
      }
      const retries = agent.session.events.filter(event => event.type === 'llm/retry');
      const end = agent.session.events.findLast(event => event.type === 'turn/end');
      active.lastEnd = end?.data.reason;
      const texts = agent.session.deriveMessages().filter(message => message.role === 'assistant')
        .flatMap(message => message.content).filter(block => block.type === 'text').map(block => block.text);
      assert.ok(active.sessionIds.every(value => value === String(id)), 'original session identity must survive retries');
      assert.ok(!texts.includes('discard failed text'), 'failed partial output is not committed');
      const expectedRetries = scenario === 'budget-exhausted' ? 5
        : ['after-first-event', 'partial-output', 'tool-checkpoint', 'auth-stops'].includes(scenario) ? 1 : 0;
      assert.equal(retries.length, expectedRetries);
      if (scenario === 'budget-exhausted') {
        assert.equal(active.counts.attempts, 6);
        assert.equal(active.counts.wsConnections, 1);
        assert.equal(active.counts.httpRequests, 5);
        assert.equal(end.data.reason.kind, 'error');
      } else if (scenario === 'cancel') {
        assert.equal(active.counts.attempts, 1);
        assert.equal(active.counts.httpRequests, 0);
        assert.equal(end.data.reason.kind, 'aborted');
      } else if (scenario === 'auth-stops') {
        assert.equal(active.counts.attempts, 2);
        assert.equal(end.data.reason.kind, 'error');
      } else {
        assert.equal(end.data.reason.kind, 'completed');
        assert.ok(texts.every(text => text === 'recovered response'));
        assert.equal(texts.length, scenario === 'connection-settings' ? 4 : scenario === 'after-first-event' ? 2 : 1);
      }
      if (scenario === 'tool-checkpoint') assert.equal(active.counts.toolExecutions, 1);
      results.push({ scenario, pass: true, ...active.counts, retries: retries.length, end: end.data.reason.kind, errorCode: end.data.reason.error?.code, elapsedMs: Date.now() - start });
    } catch (error) {
      results.push({ scenario, pass: false, ...active.counts, end: active.lastEnd, inputTypes: active.inputTypes, error: error.message, elapsedMs: Date.now() - start });
    } finally {
      unregister?.();
      await ctx.fiber.dispose();
      await session?.proxy.dispose();
      pi.closeOpenAICodexWebSocketSessions(id);
      pi.resetOpenAICodexWebSocketDebugStats(id);
    }
    console.log(JSON.stringify(results.at(-1)));
  }
} finally {
  globalThis.fetch = previous.fetch;
  globalThis.WebSocket = previous.WebSocket;
  await rm(temporary, { recursive: true, force: true });
}

const result = { status: results.every(row => row.pass) ? 'PASS' : 'FAIL',
  scope: 'Real Harness loop, built plugin, real Pi Codex SDK; in-memory wire only, no live provider acceptance.',
  pluginRoot, harnessRoot, defaultRetryPolicy: policy, results };
if (outputPath) await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);
process.exitCode = result.status === 'PASS' ? 0 : 1;
