# dsh-pi-login

[English](README.md) | 中文

把 Pi Agent 的 **`/login`** 接到 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 里。

走同一套 `models.login(provider, 'oauth')`。凭据只写 **`$DSH_HOME/.pi-login-auth.json`**。官方 CLI 文件（`~/.codex/auth.json`、`~/.grok/auth.json`、Claude Code…）**不读不写**。

| 设置页 | Harness 路由 | Pi provider |
|---|---|---|
| ChatGPT Codex | `pi-openai-codex` | `openai-codex` |
| Claude Pro/Max | `pi-anthropic` | `anthropic` |
| xAI Grok | `pi-xai` | `xai` |
| GitHub Copilot | `pi-github-copilot` | `github-copilot` |
| OpenRouter | `pi-openrouter` | `openrouter` |
| Kimi For Coding | `pi-kimi-coding` | `kimi-coding` |

Radius 没做：它要自己配网关。

## 安装

私有仓库，先 clone：

```sh
git clone https://github.com/aa2246740/dsh-pi-login.git
dsh plugin --profile web add ./dsh-pi-login
```

重启 `dsh web`。**设置 → Pi 登录**。

```sh
dsh plugin --profile web exec dsh-pi-login login openai-codex
dsh plugin --profile web exec dsh-pi-login login xai
dsh plugin --profile web exec dsh-pi-login status
```

对话里选 `pi-…` 路由。

## 许可

Apache-2.0
