# dsh-oauth-login

中文 | [English](README.en.md)

```sh
dsh plugin --profile web add github:aa2246740/dsh-oauth-login
```

PATH 上需要官方 `dsh`（没有的话用 `npx @deepseek-ai/dsh`）和 **pnpm**。装完重启这个 Host，刷新页面。`dsh plugin add` 只写 profile，不会热挂正在跑的 Host。

把 ChatGPT、Claude、Grok、Copilot、OpenRouter、Kimi 的 OAuth 登录和智谱 GLM Coding Plan 接到 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)。凭据只写 `$DSH_HOME/.dsh-oauth-auth.json`。

厂商公开 OAuth 就按其流程登录。智谱用官方 Coding Plan API Key。官方 `codex login`、Claude Code、`grok` CLI、Pi Agent 的 `~/.pi/agent/auth.json`，这里不读也不写。

入口在 **设置 → 订阅登录**。

![设置里的厂商列表](docs/screenshots/01-providers-signed-out.png)

![Copilot 等待授权](docs/screenshots/05-copilot-sign-in.gif)

![Copilot 正在等授权码](docs/screenshots/03-copilot-signing-in.png)

![混合登录状态](docs/screenshots/04-mixed-live-states.png)

![CLI status 读的是 DSH 这份 store](docs/screenshots/06-cli-status-store.png)

## 安装

需要 Node 22.19+，以及能跑起来的官方 DeepSeek Harness **0.1.5-rc.2**。

这条 `github:` 命令能装上，是因为包装了 `dsh.bundle.patch`，并且仓库提交了编好的 `lib/`。官方 `dsh plugin add` 在 `$DSH_HOME/profiles/web` 里跑 pnpm，再把这个包装进 `dsh.profile.bundles`。不需要 Creator Mode，也不需要另装一套工具。

没有 `dsh` 时：

```sh
npx @deepseek-ai/dsh plugin --profile web add github:aa2246740/dsh-oauth-login
```

本机改源码时再用 `file:`（不要写成裸的 `./`）：

```sh
git clone https://github.com/aa2246740/dsh-oauth-login.git
dsh plugin --profile web add file:./dsh-oauth-login
```

`file:` 前缀必须留着。写成 `./dsh-oauth-login` 会被装成符号链接，peer 依赖解析不到。

打开 **设置 → 订阅登录**。对话里选 `pi-…` 路由。

```sh
dsh plugin --profile web exec dsh-oauth-login login openai-codex
dsh plugin --profile web exec dsh-oauth-login login xai
dsh plugin --profile web exec dsh-oauth-login login zai-coding-cn
dsh plugin --profile web exec dsh-oauth-login status
```

`status` 不打印 token。旧版 `.pi-login-auth.json` 只在下次写入时迁到新文件名。

## 支持哪些登录

| 设置页 | Harness 路由 | Pi provider | 凭据方式 |
|---|---|---|---|
| ChatGPT Codex | `pi-openai-codex` | `openai-codex` | OAuth |
| Claude Pro/Max | `pi-anthropic` | `anthropic` | OAuth |
| xAI Grok | `pi-xai` | `xai` | OAuth |
| GitHub Copilot | `pi-github-copilot` | `github-copilot` | OAuth |
| OpenRouter | `pi-openrouter` | `openrouter` | OAuth |
| Kimi For Coding | `pi-kimi-coding` | `kimi-coding` | OAuth |
| 智谱 GLM Coding Plan | `pi-zai-coding-cn` | `zai-coding-cn` | Plan API Key |

Radius 没做。

OpenRouter 登录成功后拉官方模型目录，已登录时大约每 15 分钟同步一次。模型菜单可以筛「仅免费」。目录缓存在 `$DSH_HOME/.dsh-oauth-openrouter-models.json`，不含凭据。细节见 [OpenRouter 模型同步](docs/openrouter-sync.md)。

智谱点「连接套餐」会打开官方 [Coding Plan 个人页](https://bigmodel.cn/coding-plan/personal/overview)，把 Key 贴回本机 DSH。接口是 `https://open.bigmodel.cn/api/coding/paas/v4`。插件不读 BigModel Cookie。从 0.2.1 起同时提供 `glm-5.3` 和 `glm-5.3-flash`。

不要把这份登录文件、API Key、回调 URL、授权码或 token 贴到公开 Issue。私下报告见 [SECURITY.md](SECURITY.md)。

## 厂商自己的搜索和出图

这些路由上，插件会拿掉 DSH 的 `web_search` / `web_fetch`，改挂厂商自己的工具：

| 路由 | Hosted tools |
|---|---|
| `pi-xai` | `web_search`、`x_search`、`image_generation` |
| `pi-openai-codex` | `web_search`、`image_generation` |
| `pi-anthropic` | `web_search_20250305` |

Copilot、OpenRouter、Kimi、智谱不挂 hosted tool。要继续用 DSH 自己的搜索：

```yaml
- id: llm-oauth-login
  name: dsh-oauth-login
  config:
    nativeTools: false
```

`nativeImage: false` 只留搜索，去掉出图。

Chat 失败重试走官方 `dsh-llm-retry`。429 不等于额度耗尽。设置 → 订阅登录 → 网络代理只影响本插件。

## 许可

Apache-2.0。见 [LICENSE](LICENSE)。
