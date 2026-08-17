# dsh-oauth-login

English | [中文](README.zh.md)

Pi Agent’s **`/login`** inside [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

Uses the same provider adapters as Pi, but creates an independent OAuth grant. Credentials live only in **`$DSH_HOME/.dsh-oauth-auth.json`**. Pi Agent’s `~/.pi/agent/auth.json` and other official CLI files are **never read or written**.

| Settings card | Harness route | Pi provider |
|---|---|---|
| ChatGPT Codex | `pi-openai-codex` | `openai-codex` |
| Claude Pro/Max | `pi-anthropic` | `anthropic` |
| xAI Grok | `pi-xai` | `xai` |
| GitHub Copilot | `pi-github-copilot` | `github-copilot` |
| OpenRouter | `pi-openrouter` | `openrouter` |
| Kimi For Coding | `pi-kimi-coding` | `kimi-coding` |

Radius is omitted: it needs a custom gateway.

## Install

Clone the public repository, then install it as a `file:` package:

```sh
git clone https://github.com/aa2246740/dsh-oauth-login.git
dsh plugin --profile web add file:./dsh-oauth-login
```

Keep the `file:` prefix. A bare `./dsh-oauth-login` is installed as a symlink;
this plugin intentionally uses the Harness runtime as peer dependencies, so
the copied `file:` install is required for Node to resolve those dependencies
from the profile.

Restart `dsh web`. **Settings → OAuth Login**. Existing DSH installs migrate the old `.pi-login-auth.json` filename on the next write; it is not Pi Agent’s auth file.

```sh
dsh plugin --profile web exec dsh-oauth-login login openai-codex
dsh plugin --profile web exec dsh-oauth-login login xai
dsh plugin --profile web exec dsh-oauth-login status
```

Pick a `pi-…` route in the composer.

## Proxy behavior

OAuth and subscribed-provider requests automatically use the first available
route in this order:

1. inherited `HTTP_PROXY`, `HTTPS_PROXY`, or `ALL_PROXY`;
2. the plugin-only `DSH_OAUTH_PROXY` override;
3. an enabled and reachable macOS system HTTP/HTTPS proxy;
4. a verified HTTP CONNECT proxy on a common loopback port;
5. direct access.

Loopback candidates are accepted only after a credential-free CONNECT probe.
The plugin does not add country, region, locale, or other geographic metadata.
To force a proxy, start DSH with `DSH_OAUTH_PROXY=http://127.0.0.1:45678`.
Restart `dsh web` after changing proxy applications or settings.

## Security

OAuth grants are owned by DSH and stored locally with owner-only permissions.
Never paste auth files, callback URLs, authorization codes, or tokens into a
public issue. See [SECURITY.md](SECURITY.md) for private reporting guidance.

This is a community plugin and is not affiliated with DeepSeek, Pi Agent, or
the supported OAuth providers.

## License

Apache-2.0
