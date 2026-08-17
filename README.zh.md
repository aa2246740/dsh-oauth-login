# dsh-oauth-login

[English](README.md) | 中文

把 Pi Agent 的 **`/login`** 接到 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 里。

复用 Pi 的 provider 适配器，但使用 DSH 自己的独立 OAuth 授权。凭据只写 **`$DSH_HOME/.dsh-oauth-auth.json`**；Pi Agent 的 `~/.pi/agent/auth.json` 和其他官方 CLI 文件**不读不写**。

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

克隆公开仓库，再按 `file:` 方式安装：

```sh
git clone https://github.com/aa2246740/dsh-oauth-login.git
dsh plugin --profile web add file:./dsh-oauth-login
```

请保留 `file:` 前缀。直接写 `./dsh-oauth-login` 会被安装成符号链接；本插件有意把 DSH 运行时作为 peer dependency，因此必须使用 `file:` 副本，Node 才能从 profile 解析这些依赖。

重启 `dsh web`。**设置 → OAuth 登录**。旧版 DSH 的 `.pi-login-auth.json` 只作为 DSH 自己的迁移来源，不会当作 Pi Agent 文件处理。

```sh
dsh plugin --profile web exec dsh-oauth-login login openai-codex
dsh plugin --profile web exec dsh-oauth-login login xai
dsh plugin --profile web exec dsh-oauth-login status
```

对话里选 `pi-…` 路由。

## 代理行为

OAuth 登录和订阅模型请求会按以下顺序自动选择网络路径：

1. DSH 进程继承的 `HTTP_PROXY`、`HTTPS_PROXY` 或 `ALL_PROXY`；
2. 本插件专用的 `DSH_OAUTH_PROXY`；
3. 已开启且可连接的 macOS 系统 HTTP/HTTPS 代理；
4. 常见本机端口上、通过 HTTP CONNECT 验证的代理；
5. 直连。

本机候选端口只有通过不含凭据的 CONNECT 探测后才会启用。插件不会添加国家、地区、语言或其他地理信息。若要强制指定代理，可用 `DSH_OAUTH_PROXY=http://127.0.0.1:45678` 启动 DSH。代理应用或设置改变后请重启 `dsh web`。

## 安全

OAuth 授权由 DSH 独立持有，并以仅当前用户可读写的权限保存在本机。请勿在公开 Issue 中粘贴登录文件、回调 URL、授权码或 token。私下报告方式见 [SECURITY.md](SECURITY.md)。

这是社区插件，与 DeepSeek、Pi Agent 及所支持的 OAuth 厂商均无隶属关系。

## 许可

Apache-2.0
