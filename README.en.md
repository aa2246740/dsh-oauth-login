# dsh-oauth-login

[中文](README.md) | English

```sh
dsh plugin --profile web add github:aa2246740/dsh-oauth-login
```

You need official `dsh` on PATH (or `npx @deepseek-ai/dsh`) and **pnpm**. Then restart that Host and reload the page. `dsh plugin add` writes the profile. It does not hot-load a running Host.

OAuth login for ChatGPT, Claude, Grok, Copilot, OpenRouter, and Kimi on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), plus Zhipu GLM Coding Plan via its official plan API key. Credentials go only to `$DSH_HOME/.dsh-oauth-auth.json`.

Official `codex login`, Claude Code, `grok` CLI, and Pi Agent `~/.pi/agent/auth.json` are not read or written.

The UI is **Settings → 订阅登录**.

![Provider list signed out](docs/screenshots/01-providers-signed-out.png)

![Copilot waiting for authorization](docs/screenshots/05-copilot-sign-in.gif)

![Copilot waiting on a device code](docs/screenshots/03-copilot-signing-in.png)

![Mixed signed-in state](docs/screenshots/04-mixed-live-states.png)

![CLI status reads the DSH store](docs/screenshots/06-cli-status-store.png)

## Install

Node 22.19+ and official DeepSeek Harness **0.1.5-rc.2**.

That `github:` command works because this package declares `dsh.bundle.patch` and commits built `lib/`. Official `dsh plugin add` runs pnpm in `$DSH_HOME/profiles/web` and appends this package to `dsh.profile.bundles`. You do not need Creator Mode or a second toolchain.

If `dsh` is not on PATH:

```sh
npx @deepseek-ai/dsh plugin --profile web add github:aa2246740/dsh-oauth-login
```

Use `file:` only when you are editing a local clone (do not drop the prefix):

```sh
git clone https://github.com/aa2246740/dsh-oauth-login.git
dsh plugin --profile web add file:./dsh-oauth-login
```

Keep the `file:` prefix. A bare `./dsh-oauth-login` becomes a symlink and peer dependencies will not resolve.

Open **Settings → 订阅登录**. Pick a `pi-…` route in chat.

```sh
dsh plugin --profile web exec dsh-oauth-login login openai-codex
dsh plugin --profile web exec dsh-oauth-login login xai
dsh plugin --profile web exec dsh-oauth-login login zai-coding-cn
dsh plugin --profile web exec dsh-oauth-login status
```

`status` does not print tokens. Legacy `.pi-login-auth.json` is renamed on the next write.

## Providers

| Settings | Harness route | Pi provider | Credential |
|---|---|---|---|
| ChatGPT Codex | `pi-openai-codex` | `openai-codex` | OAuth |
| Claude Pro/Max | `pi-anthropic` | `anthropic` | OAuth |
| xAI Grok | `pi-xai` | `xai` | OAuth |
| GitHub Copilot | `pi-github-copilot` | `github-copilot` | OAuth |
| OpenRouter | `pi-openrouter` | `openrouter` | OAuth |
| Kimi For Coding | `pi-kimi-coding` | `kimi-coding` | OAuth |
| Zhipu GLM Coding Plan | `pi-zai-coding-cn` | `zai-coding-cn` | Plan API key |

Radius is not implemented.

OpenRouter pulls the official catalog after OAuth and refreshes about every 15 minutes while signed in. The model menu can filter free models. The catalog cache is `$DSH_HOME/.dsh-oauth-openrouter-models.json` and holds no credentials. See [OpenRouter model sync](docs/openrouter-sync.md).

Zhipu **连接套餐** opens the official [Coding Plan page](https://bigmodel.cn/coding-plan/personal/overview). Paste the key back into DSH. The API is `https://open.bigmodel.cn/api/coding/paas/v4`. BigModel cookies are not read. From 0.2.1 the list includes both `glm-5.3` and `glm-5.3-flash`.

Do not paste this auth file, API keys, callback URLs, codes, or tokens into public issues. Private reports: [SECURITY.md](SECURITY.md).

## Hosted search and images

On these routes the plugin removes DSH `web_search` / `web_fetch` and attaches the vendor tools:

| Route | Hosted tools |
|---|---|
| `pi-xai` | `web_search`, `x_search`, `image_generation` |
| `pi-openai-codex` | `web_search`, `image_generation` |
| `pi-anthropic` | `web_search_20250305` |

Copilot, OpenRouter, Kimi, and Zhipu do not get hosted tools. To keep DSH search:

```yaml
- id: llm-oauth-login
  name: dsh-oauth-login
  config:
    nativeTools: false
```

`nativeImage: false` keeps search and drops image generation.

Chat retries use official `dsh-llm-retry`. HTTP 429 is not the same as quota exhaustion. **Settings → 订阅登录 → 网络代理** affects only this plugin.

## License

Apache-2.0. See [LICENSE](LICENSE).
