// Optional local acceptance with the host's React DOM and globally pinned
// Playwright. Runs the real settings component and built plugin API in isolation.
// Usage: node scripts/verify-network-settings-ui.mjs <output-directory>
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'tsdown';
import { PiLoginSession, PiLoginCredentialStore, registerPiLoginAuthRoutes } from '../lib/index.js';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('..', import.meta.url));
const [outputDirectory] = process.argv.slice(2);
if (!outputDirectory) throw new Error('Pass the screenshot/report output directory.');
const { launchPinnedChromium, verifyPinnedRuntime } = await import(pathToFileURL(join(homedir(), '.codex/playwright-runtime/runtime.mjs')));
const runtime = verifyPinnedRuntime();
const temporary = await mkdtemp(join(tmpdir(), 'dsh-network-ui-'));
const routes = new Map();
const cleanups = [];
const session = new PiLoginSession(new PiLoginCredentialStore(join(temporary, 'auth.json')),
  { enabled: false, image: false }, undefined, { env: {}, platform: 'linux', candidates: [] });
let browser;
let server;
let authUnavailable = false;
try {
  const entry = join(temporary, 'settings-preview.tsx');
  await writeFile(entry, `import { createRoot } from 'react-dom/client';
import { PiLoginSettings } from ${JSON.stringify(join(root, 'src/client/PiLoginSettings.tsx'))};
import { zh } from ${JSON.stringify(join(root, 'src/client/locales.ts'))};
createRoot(document.getElementById('root')).render(<PiLoginSettings t={key => zh[key]} />);
`);
  const previewBundles = await build({ config: false, cwd: root, entry: { 'settings-preview': entry }, outDir: join(temporary, 'assets'),
    format: 'iife', platform: 'browser', target: 'es2022', dts: false, logLevel: 'error', write: false,
    outExtensions: () => ({ js: '.js' }),
    tsconfig: join(root, 'tsconfig.client.json'), deps: { alwaysBundle: /.*/ },
    define: { 'process.env.NODE_ENV': '"production"' },
    alias: { react: require.resolve('react'), 'react/jsx-runtime': require.resolve('react/jsx-runtime'),
      'react-dom/client': require.resolve('react-dom/client') },
  });
  const previewChunk = previewBundles.flatMap(bundle => bundle.chunks).find(chunk => chunk.type === 'chunk' && chunk.isEntry);
  if (!previewChunk) throw new Error(`Preview build produced no entry: ${JSON.stringify(previewBundles.map(bundle => ({ entry: bundle.config.entry, chunks: bundle.chunks.map(chunk => chunk.fileName) })))}`);
  const javascript = previewChunk.code;
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>OAuth network settings — isolated verification</title><style>
:root{color-scheme:light;--dsw-alias-label-primary:#20252d;--dsw-alias-label-secondary:#606b7b;--dsw-alias-border-l2:#dce1e9;--dsw-alias-bg-module-platform:#fff;--dsw-alias-bg-page-primary:#f6f8fc;--dsw-alias-brand-primary:#2563eb;--dsw-alias-state-error-primary:#c72d35;--dsw-alias-interactive-bg-hover:#eef2f7}
@media(prefers-color-scheme:dark){:root{color-scheme:dark;--dsw-alias-label-primary:#e8eaf0;--dsw-alias-label-secondary:#a5adbc;--dsw-alias-border-l2:#3a4351;--dsw-alias-bg-module-platform:#252b35;--dsw-alias-bg-page-primary:#1c212a;--dsw-alias-brand-primary:#74a4ff;--dsw-alias-state-error-primary:#ff8d92;--dsw-alias-interactive-bg-hover:#353e4c}}
body{margin:24px;font:14px system-ui,-apple-system,sans-serif;background:var(--dsw-alias-bg-page-primary)}*{box-sizing:border-box}@media(max-width:480px){body{margin:16px}}
</style><div id="root"></div><script src="/settings-preview.js"></script></html>`;
  registerPiLoginAuthRoutes({ webServer: { register: route => {
    routes.set(route.path, route.handler); return () => routes.delete(route.path);
  } }, effect: factory => { cleanups.push(factory()); } }, session);
  server = createServer(async (req, res) => {
    if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html); return; }
    if (req.url === '/settings-preview.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(javascript); return; }
    // This preview cannot start sign-in, sign-out, provider refresh or model work.
    if (req.url?.startsWith('/plugins/dsh-oauth-login/auth/')) {
      res.writeHead(authUnavailable ? 503 : 200, { 'content-type': 'application/json' });
      res.end(authUnavailable ? '{"error":"Synthetic account status unavailable"}' : '[]'); return;
    }
    const handler = routes.get(req.url);
    if (handler && req.url === '/plugins/dsh-oauth-login/network/settings') { await handler(req, res); return; }
    res.writeHead(404); res.end();
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const url = `http://127.0.0.1:${server.address().port}`;
  browser = await launchPinnedChromium();
  const context = await browser.newContext({ viewport: { width: 960, height: 1000 }, colorScheme: 'light' });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  const field = (page, index) => page.locator('fieldset').nth(index);
  const address = (page, index) => field(page, index).getByLabel('代理地址（HTTP / HTTPS）');
  const port = (page, index) => field(page, index).getByLabel('端口');
  const toggle = (page, index) => field(page, index).getByRole('switch');
  const ready = page => page.getByRole('button', { name: '重新加载', exact: true }).waitFor({ state: 'visible' });
  const saved = page => page.getByText('已保存，新请求将使用这些设置。', { exact: true }).waitFor();
  async function save(page) { await page.getByRole('button', { name: '保存网络设置', exact: true }).click(); await saved(page); }
  await page.goto(url);
  await ready(page);
  await address(page, 0).waitFor();
  assert.equal(await toggle(page, 0).isChecked(), true);
  assert.equal(await toggle(page, 1).isChecked(), true);
  for (const index of [0, 1]) {
    assert.equal(await address(page, index).inputValue(), 'http://127.0.0.1');
    assert.equal(await port(page, index).inputValue(), '');
  }
  await mkdir(outputDirectory, { recursive: true });
  await page.locator('.dsh-oauth-network').screenshot({ path: join(outputDirectory, 'proxy-settings-defaults.png') });
  await port(page, 1).fill('45679');
  await save(page);
  assert.deepEqual((await session.proxy.settings.read()).http, { enabled: true, url: '' });
  await port(page, 0).fill('45678');
  await save(page);
  await page.reload(); await address(page, 0).waitFor();
  assert.equal(await port(page, 0).inputValue(), '45678');
  assert.equal(await port(page, 1).inputValue(), '45679');
  await toggle(page, 0).uncheck(); await save(page);
  let state = await session.proxy.settings.read();
  assert.equal(state.http.enabled, false); assert.equal(state.websocket.enabled, true);
  assert.equal(state.http.url, 'http://127.0.0.1:45678');

  const other = await context.newPage();
  await other.goto(url); await address(other, 1).waitFor();
  await toggle(page, 0).check(); await toggle(page, 1).uncheck(); await save(page);
  await port(other, 1).fill('45680');
  await other.getByRole('button', { name: '保存网络设置', exact: true }).click();
  await other.getByText('其他页面已修改设置，请重新加载后再保存。', { exact: true }).waitFor();
  await other.getByRole('button', { name: '重新加载', exact: true }).click();
  await field(other, 1).getByText('已关闭：直接连接，忽略代理环境变量。保留地址，方便下次开启。', { exact: true }).waitFor();
  assert.equal(await toggle(other, 1).isChecked(), false);
  await other.close();
  state = await session.proxy.settings.read();
  assert.equal(state.http.enabled, true); assert.equal(state.websocket.enabled, false);
  const revision = state.revision;
  await toggle(page, 1).check(); await port(page, 1).fill('0');
  await page.getByRole('button', { name: '保存网络设置', exact: true }).click();
  await page.getByRole('alert').waitFor();
  assert.equal((await session.proxy.settings.read()).revision, revision);
  await port(page, 1).fill('45678'); await save(page);
  const expected = { enabled: true, url: 'http://127.0.0.1:45678' };
  state = await session.proxy.settings.read();
  assert.deepEqual(state.http, expected); assert.deepEqual(state.websocket, expected);

  await mkdir(outputDirectory, { recursive: true });
  const screenshots = [];
  for (const [name, width, scheme] of [['light', 960, 'light'], ['dark', 960, 'dark'], ['mobile', 390, 'light']]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.emulateMedia({ colorScheme: scheme });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), true);
    const screenshot = join(outputDirectory, `proxy-settings-${name}.png`);
    await page.locator('.dsh-oauth-network').screenshot({ path: screenshot });
    screenshots.push(screenshot);
  }
  authUnavailable = true;
  await page.reload(); await address(page, 0).waitFor();
  await page.getByText('Synthetic account status unavailable', { exact: true }).waitFor();
  assert.equal(await port(page, 0).inputValue(), '45678', 'proxy settings stay available when account loading fails');
  assert.deepEqual(pageErrors, []);
  const result = { status: 'PASS', runtime: { playwright: runtime.playwrightVersion, chromiumRevision: runtime.chromiumRevision },
    scope: 'Actual React settings component and built plugin API; isolated server, not installed in the running DSH.',
    cases: ['prefilled addresses with empty ports', 'one channel configured leaves the other on automatic discovery',
      'independent addresses and ports', 'save and reload', 'HTTP off / WS on', 'HTTP on / WS off',
      'stale revision conflict', 'invalid port rejected without saving', 'account failure does not hide settings', 'light/dark/mobile no horizontal overflow'],
    screenshots, pageErrors, settings: state };
  await writeFile(join(outputDirectory, 'settings-ui-results.json'), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser?.close();
  if (server?.listening) await new Promise(resolve => server.close(resolve));
  for (const cleanup of cleanups) await cleanup();
  await session.proxy.dispose();
  await rm(temporary, { recursive: true, force: true });
}
