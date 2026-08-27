/** OAuth subscriptions Pi Agent exposes via /login. Radius is omitted (needs a gateway). */

export interface PiLoginProvider {
  /** pi-ai provider id used by models.login(). */
  readonly id: string
  /** Harness LLM route. Distinct from catalog routes and from other plugins. */
  readonly route: string
  /** Credential method this plugin deliberately exposes for this provider. */
  readonly authType: 'oauth' | 'api_key'
  /** Official account page opened before an interactive API-key prompt. */
  readonly loginUrl?: string
  readonly displayName: string
  readonly shortName: string
  readonly blurb: string
  readonly blurbZh: string
  /** HTTPS hosts this provider is allowed to open during login. */
  readonly allowedHosts: readonly string[]
  /** Extra allowed host suffixes (leading-dot match). */
  readonly allowedSuffixes: readonly string[]
  readonly preferredModels: readonly string[]
}

export const PI_LOGIN_PROVIDERS: readonly PiLoginProvider[] = [
  {
    id: 'openai-codex',
    route: 'pi-openai-codex',
    authType: 'oauth',
    displayName: 'ChatGPT Codex',
    shortName: 'Codex',
    blurb: 'ChatGPT Plus/Pro Codex. Independent of official `codex login`.',
    blurbZh: 'ChatGPT Plus/Pro 的 Codex。和官方 `codex login` 互不影响。',
    allowedHosts: ['auth.openai.com', 'chatgpt.com', 'www.chatgpt.com'],
    allowedSuffixes: ['.openai.com', '.chatgpt.com'],
    preferredModels: ['gpt-5.4', 'gpt-5.3-codex', 'gpt-5.3-codex-spark'],
  },
  {
    id: 'anthropic',
    route: 'pi-anthropic',
    authType: 'oauth',
    displayName: 'Claude Pro/Max',
    shortName: 'Claude',
    blurb: 'Claude subscription. Independent of official Claude Code login.',
    blurbZh: 'Claude 订阅。和官方 Claude Code 登录互不影响。',
    allowedHosts: ['claude.ai', 'www.claude.ai', 'platform.claude.com'],
    allowedSuffixes: ['.anthropic.com', '.claude.ai'],
    preferredModels: ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-opus-4-5'],
  },
  {
    id: 'xai',
    route: 'pi-xai',
    authType: 'oauth',
    displayName: 'xAI Grok',
    shortName: 'Grok',
    blurb: 'SuperGrok / X Premium. Independent of official `grok` CLI.',
    blurbZh: 'SuperGrok / X Premium。和官方 `grok` CLI 互不影响。',
    allowedHosts: ['auth.x.ai', 'accounts.x.ai', 'x.ai', 'www.x.ai'],
    allowedSuffixes: ['.x.ai'],
    preferredModels: ['grok-4.6', 'grok-4.5', 'grok-4.3'],
  },
  {
    id: 'github-copilot',
    route: 'pi-github-copilot',
    authType: 'oauth',
    displayName: 'GitHub Copilot',
    shortName: 'Copilot',
    blurb: 'GitHub Copilot subscription via device code.',
    blurbZh: 'GitHub Copilot 订阅，走 device code。',
    allowedHosts: ['github.com', 'www.github.com', 'api.github.com'],
    allowedSuffixes: ['.github.com', '.githubcopilot.com'],
    preferredModels: ['gpt-5.4', 'claude-sonnet-4.6', 'claude-opus-4.6'],
  },
  {
    id: 'openrouter',
    route: 'pi-openrouter',
    authType: 'oauth',
    displayName: 'OpenRouter',
    shortName: 'OpenRouter',
    blurb: 'OpenRouter OAuth mints a key billed from your OpenRouter credits.',
    blurbZh: 'OpenRouter OAuth 会签发一把钥匙，从你的 OpenRouter 余额扣费。',
    allowedHosts: ['openrouter.ai', 'www.openrouter.ai'],
    allowedSuffixes: ['.openrouter.ai'],
    preferredModels: [],
  },
  {
    id: 'kimi-coding',
    route: 'pi-kimi-coding',
    authType: 'oauth',
    displayName: 'Kimi For Coding',
    shortName: 'Kimi',
    blurb: 'Kimi Code subscription.',
    blurbZh: 'Kimi Code 订阅。',
    allowedHosts: ['auth.kimi.com', 'kimi.com', 'www.kimi.com', 'api.kimi.com'],
    allowedSuffixes: ['.kimi.com'],
    preferredModels: ['kimi-for-coding', 'k3'],
  },
  {
    id: 'zai-coding-cn',
    route: 'pi-zai-coding-cn',
    authType: 'api_key',
    loginUrl: 'https://bigmodel.cn/coding-plan/personal/overview',
    displayName: '智谱 GLM Coding Plan',
    shortName: 'GLM',
    blurb: 'Zhipu GLM Coding Plan (China) via its official Plan API key.',
    blurbZh: '智谱 GLM Coding Plan 中国区套餐，使用套餐页签发的专用 API Key。',
    allowedHosts: ['bigmodel.cn', 'www.bigmodel.cn', 'open.bigmodel.cn'],
    allowedSuffixes: ['.bigmodel.cn'],
    preferredModels: ['glm-5.3-flash', 'glm-5.3', 'glm-5.2', 'glm-5-turbo', 'glm-5.1', 'glm-4.7'],
  },
]

export function piLoginProvider(id: string): PiLoginProvider | undefined {
  return PI_LOGIN_PROVIDERS.find(provider => provider.id === id)
}

export function piLoginProviderByRoute(route: string): PiLoginProvider | undefined {
  return PI_LOGIN_PROVIDERS.find(provider => provider.route === route)
}

export function requirePiLoginProvider(id: string): PiLoginProvider {
  const provider = piLoginProvider(id)
  if (provider === undefined) {
    throw new Error(`dsh-oauth-login: unknown provider "${id}"`)
  }
  return provider
}

export function piLoginRoutes(): string[] {
  return PI_LOGIN_PROVIDERS.map(provider => provider.route)
}
