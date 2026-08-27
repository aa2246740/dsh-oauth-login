# OpenRouter model sync

## Request and scope

Use the normal DSH OAuth plugin to discover current OpenRouter models and make
free models easy to select. Preserve the existing two-level composer menu,
search, reasoning selection, GLM key-input fix and all other providers. Do not
change DSH core, credentials, existing conversations, or the selected model.

## Runtime contract

- After OpenRouter login: refresh the public Models API immediately.
- Startup: show the persisted catalog; refresh when older than 15 minutes.
- While signed in: one Host-owned timer refreshes every 15 minutes. Logout and
  plugin disposal cancel the timer and in-flight refresh.
- Opening the menu reads cached metadata and asks for an async stale refresh.
- Manual refresh is coalesced across windows and has a 60-second cooldown.
- A network, empty-data or partial-response failure preserves the last-good
  list and timestamp. Cache lives beside the plugin credential file in
  .dsh-oauth-openrouter-models.json, with no tokens or keys.
- New models enter the actual pi-ai-backed DSH adapter, not only the menu.
- Full live catalogs replace obsolete builtin entries; missing current
  selections are not silently changed to another model.

## Price and safety contract

The free badge uses official prices, including extra unit costs. Missing or
invalid prices and conditional pricing overrides are not labelled free.
The expiration_date field means endpoint deprecation, not a promotion deadline.
Unknown promotion deadlines are not invented.

Free requests pin the model ID, set all supported provider price caps to zero,
disable provider/model fallbacks, disable known paid OpenRouter plugins, and
reject hosted tools or file/audio processing. Ordinary DSH function tools stay
available. A model previously advertised as free keeps its zero-price guard
even after a restart or price change. A promotion ending never opts the user
into a paid call. Explicit paid model variants remain separate choices.

Platform-enforced account/organization plugins can override per-request
settings. DSH cannot override those policies: users must disable forced paid
plugins in OpenRouter before relying on free inference. The UI states this
limit; it does not promise that all account-level services are free.

Official contracts:
[Models API](https://openrouter.ai/docs/guides/overview/models),
[price caps](https://openrouter.ai/docs/guides/routing/provider-selection#max-price),
[plugins](https://openrouter.ai/docs/guides/features/plugins),
[free router](https://openrouter.ai/docs/guides/routing/routers/free-router).

## Native UI contract

Clarity-first, single-agent implementation. Keep the host's font, compact
menu density, theme tokens and two-level layout. No new font, imagery,
animation, dashboard or layout family. The visual cue is a small green
text badge, never color alone. A stale free badge becomes neutral and says
it is cached. Model names may truncate; price/safety state must not.

Show All / Free only (OpenRouter), tool capability, context size, last sync,
refresh feedback and a retry path. The OpenRouter settings card shares the
same client metadata store. A background update cannot steal keyboard focus
or change selection. Controls wrap at narrow widths; menu scrolling is
internal. No token/key values are needed for browser verification.

## OKF decision bindings

| Active concept | Decision | Target | Verification |
| --- | --- | --- | --- |
| request-integrity | Normal DSH only; no core or selection mutation | Adapter, menu, deployment | Route tests; exact Host/PID verification |
| accessibility-usability | Text badges, named controls, stable focus | Filters, refresh, model rows | Keyboard/focus and screen-state tests |
| responsive-interaction | Wrap status/filters; bounded, scrollable menu | Composer popover | Desktop and narrow screenshots/geometry |
| state-language | Distinguish cached, stale, refreshing, failed and signed out | Shared sync status | Failure/cooldown tests and visible state review |
| typography-system | Keep native type; wrap critical status; separate model ID | Model metadata rows | Long-label and mixed Chinese/English rendering |

Support: existing DSH theme/source, web-product/content-model branches,
visual-verification and quality-gates. A compact feature contract is used
instead of introducing a separate design system for this existing component.

## Acceptance

Unit checks cover parsing, free classification, cache restart, refresh
frequency/coalescing, logout races, real adapter resolution, and final outbound
payload guards. Rendered checks cover search/free filtering, manual refresh,
cached failure, focus, unchanged selection and narrow layout. dshx check,
artifact sync and running Host/UI evidence are separate delivery gates.
