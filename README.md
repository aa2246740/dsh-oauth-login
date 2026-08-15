# dsh-pi-login

English | [中文](README.zh.md)

Pi Agent’s **`/login`** inside [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

Same `models.login(provider, 'oauth')` calls Pi uses. One file: **`$DSH_HOME/.pi-login-auth.json`**. Official CLI files (`~/.codex/auth.json`, `~/.grok/auth.json`, Claude Code, …) are **never read or written**.

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

Private repo — clone first:

```sh
git clone https://github.com/aa2246740/dsh-pi-login.git
dsh plugin --profile web add ./dsh-pi-login
```

Restart `dsh web`. **Settings → Pi Login**.

```sh
dsh plugin --profile web exec dsh-pi-login login openai-codex
dsh plugin --profile web exec dsh-pi-login login xai
dsh plugin --profile web exec dsh-pi-login status
```

Pick a `pi-…` route in the composer.

## License

Apache-2.0
