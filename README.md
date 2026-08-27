# dsh-oauth-login

中文 | [English](README.en.md)

把 ChatGPT、Claude、Grok、Copilot、OpenRouter、Kimi 的 OAuth 登录和智谱 GLM Coding Plan 接到 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)。复用 Pi Agent 的 provider 适配器，凭据只写 DSH 自己的 `$DSH_HOME/.dsh-oauth-auth.json`。

厂商公开 OAuth 就按其流程登录；智谱使用官方 Coding Plan API Key。官方 `codex login`、Claude Code、`grok` CLI、Pi Agent 的 `~/.pi/agent/auth.json`，这里不读也不写。

## 长什么样

下面保留的是早期 OAuth-only 版本装进 `dsh web` 后的实拍截图，不是设计稿。当前 0.2.0 入口已改为 **设置 → 订阅登录**，并新增智谱套餐接入和 OpenRouter 模型同步；旧截图不展示这些新增功能。

设置页里的语言跟着 Harness，这台机器当时是中文。

![设置里的厂商列表，都还没登录](docs/screenshots/01-providers-signed-out.png)

点 GitHub Copilot 的「登录」。插件向 GitHub 要 device code，卡片变成「正在等待授权」，并给出 `github.com/login/device`。官方 CLI 的登录文件不会被创建。

![点登录之后，Copilot 进入等待授权](docs/screenshots/05-copilot-sign-in.gif)

![Copilot 正在等授权码，其余厂商仍未登录](docs/screenshots/03-copilot-signing-in.png)

Grok 那张绿点是写进 `$DSH_HOME/.dsh-oauth-auth.json` 的占位授权，用来拍「已登录 / 退出」。不是真的 xAI 会话，文件内容没有出现在任何截图里。

![Grok 已登录，Copilot 仍在等授权](docs/screenshots/04-mixed-live-states.png)

命令行读的也是 DSH 这份 store，不是官方 CLI 的登录文件。`status` 不打印 token。Codex 未登录时退出码是 1。`ls` 用来确认 `~/.pi`、`~/.codex`、`~/.claude` 没被碰过。

![CLI status、独立 store、未登录时退出 1](docs/screenshots/06-cli-status-store.png)

## 安装

需要 Node 22.19+，以及能跑起来的 DeepSeek Harness。

```sh
npx @deepseek-ai/dsh web
```

另开一个终端，在 Harness 旁边装这个插件。`file:` 前缀必须留着。

```sh
git clone https://github.com/aa2246740/dsh-oauth-login.git
dsh plugin --profile web add file:./dsh-oauth-login
```

写成 `./dsh-oauth-login` 会被装成符号链接。本插件把 DSH 运行时当成 peer dependency，必须用 `file:` 拷进 profile，Node 才能从那边解析依赖。

重启 `dsh web`。打开 **设置 → 订阅登录**。对话里选 `pi-…` 路由。

```sh
dsh plugin --profile web exec dsh-oauth-login login openai-codex
dsh plugin --profile web exec dsh-oauth-login login xai
dsh plugin --profile web exec dsh-oauth-login login zai-coding-cn
dsh plugin --profile web exec dsh-oauth-login status
```

旧版 DSH 的 `.pi-login-auth.json` 只在下次写入时迁到新文件名，不会当成 Pi Agent 的登录文件。

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

Radius 没做。它要自己配网关。

## OpenRouter 模型同步与免费筛选

OAuth 登录成功后自动拉取官方模型目录；已登录时，DSH 服务每 **15 分钟**
同步一次。重启先显示本地缓存，过期再更新。也可在模型菜单或
**设置 → 订阅登录 → OpenRouter** 点击**刷新模型**，手动刷新间隔至少 60 秒。

模型菜单支持**全部 / 仅免费**，按官方实时价格标注**免费 · 有限额**，
并显示工具调用能力、上下文长度、上次同步时间。同步失败保留旧列表并标为
缓存；新增模型会进入实际调用适配器，后台更新不会替你切换当前模型。

免费不代表无限调用，仍受 OpenRouter 速率、每日额度和供应商容量限制。
免费请求会使用零价格上限，禁用付费模型回退及已知收费插件；曾标为免费的
型号变成收费或下架后，不会静默按付费方式调用。账户/组织强制启用的收费
插件不受 DSH 控制，请先在 OpenRouter 关闭这类强制规则。

目录缓存不含凭据，独立保存为 `$DSH_HOME/.dsh-oauth-openrouter-models.json`。
详细边界与验证约定见 [OpenRouter 模型同步](docs/openrouter-sync.md)。

## 智谱 GLM Coding Plan

智谱公开的 Coding Plan 接入方式是套餐专用 API Key，不是面向第三方插件的
网页 OAuth。点击智谱卡片的**连接套餐**后，插件会打开官方
[Coding Plan 个人页](https://bigmodel.cn/coding-plan/personal/overview)，再请你把
Key 粘贴到本机 DSH 页面。官方接口为
`https://open.bigmodel.cn/api/coding/paas/v4`。

插件不会读取 BigModel Cookie、浏览器存储、网页内容，也不会从其他应用
提取 Key。只有你选择 `pi-zai-coding-cn` 路由时，保存的 Key 才会交给 Pi 的
`zai-coding-cn` 适配器发送。
这条路由默认使用 `glm-5.3-flash`，同时保留 Coding Plan 的旧模型。当前
Pi 目录尚未收录该模型，因此由插件补齐 GLM-5.3-Flash 的模型描述。

## 登录文件在哪

OAuth 授权与 Plan API Key 只写 `$DSH_HOME/.dsh-oauth-auth.json`，权限是当前用户可读写。不要把这份文件、API Key、回调 URL、授权码或 token 贴到公开 Issue。私下报告见 [SECURITY.md](SECURITY.md)。

## 厂商自己的搜索和出图

官方 DSH 会注册 `web_search`，再经 `ctx.web` 打出去，默认又用 `DEEPSEEK_API_KEY` 走一轮 DeepSeek Messages。OAuth 账号自己的 hosted tool 就被盖住了。

在这些路由上，插件会从模型可见 schema 里拿掉 DSH 的 `web_search` / `web_fetch`，改挂厂商自己的工具。

| 路由 | Hosted tools |
|---|---|
| `pi-xai` | `web_search`、`x_search`、`image_generation` |
| `pi-openai-codex` | `web_search`、`image_generation` |
| `pi-anthropic` | `web_search_20250305` |

Copilot、OpenRouter、Kimi、智谱不挂 hosted tool。OpenRouter 免费请求另有零价格和收费插件保护，见上文；DeepSeek 官方对话不改。

这些工具走的是该厂商的订阅 / tool 额度，不再要 Exa、Perplexity 或 DeepSeek Search。服务端搜索痕迹不会再当成 DSH 工具去跑。Grok 搜索 hop 里的空 Think，以及正文开始之后才冒出来的旁白 Think，会从流里丢掉。托管出图写入附件库，显示在助手那一轮。

Hosted tools 是这一次请求的能力。只有调用方带了 `tools` 列表，插件才会去做去重和注入。自动审批、标题生成这类不带 `tools` 的纯文本调用保持纯文本。

要继续用 DSH 自己的搜索：

```yaml
- id: llm-oauth-login
  name: dsh-oauth-login
  config:
    nativeTools: false
```

`nativeImage: false` 只留搜索，去掉出图。

## 模型失败时

插件不另写一套重试。Chat 用官方 `dsh-llm-retry` 和官方 `LlmError` 码。插件只在原文后面补一句说明，不改 code。

| 码 | 通常是什么 | 怎么做 |
|---|---|---|
| `RATE_LIMIT` | 请求限流或高峰。很多 HTTP 429 落在这里。 | 等完默认五次自动重试，再发一条。 |
| `QUOTA` | 套餐、用量窗、余额。 | 再试也补不回来，去查厂商套餐。 |
| `TIMEOUT` / `TRANSPORT` | 空闲断流或网络。 | 本轮结束后再发一条。 |
| `SERVER` | 对端 5xx / 部分 overloaded。 | 和其他暂时故障一样。 |
| `AUTH` / `MISSING_CREDENTIAL` | 没登录、没有 Plan Key 或凭据被拒。 | 设置 → 订阅登录。Chat 有时把 AUTH 显示成 “API key is invalid”。 |

429 不等于繁忙，也不等于没钱。官方按厂商原文分类：像额度用尽就标 `QUOTA`，其余 429 标 `RATE_LIMIT`。5 小时 / 周限额只有原文说得像 usage-limit / quota 时才会进 `QUOTA`。

RC8 默认对暂时故障自动重试五次，然后本轮结束。Continue 失败或输入框卡住，开新对话。

要加大次数而不改插件代码，给 `llm-oauth-login` 行加配置：

```yaml
- id: llm-oauth-login
  name: dsh-oauth-login
  config:
    retryPolicy:
      mode: normal
      maxRetries: 7
      backoff:
        initialDelayMs: 1000
        maxDelayMs: 30000
        jitterRatio: 0.1
```

`mode: always` 会把每一种失败都重试到成功或取消，可能烧额度。Creator Mode / 宿主模型的超时走你在对话里选的那条路由，不是这个插件。

## 代理

OAuth 和订阅模型请求按这个顺序选路：进程继承的 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY`，插件自己的 `DSH_OAUTH_PROXY`，已开启且能连上的 macOS 系统代理，本机常见端口上通过 HTTP CONNECT 验证的代理，最后才直连。

本机候选端口只有通过不含凭据的 CONNECT 探测后才会用。插件不写国家、地区、语言。要指定代理，用 `DSH_OAUTH_PROXY=http://127.0.0.1:45678` 启动 DSH。代理改完之后重启 `dsh web`。

## 许可

Apache-2.0。这是社区插件，和 DeepSeek、Pi Agent 以及上面这些 OAuth 厂商都没有隶属关系。
