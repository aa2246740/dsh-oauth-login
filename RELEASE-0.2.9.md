# dsh-oauth-login 0.2.9

Codex subscription routes now declare hosted search with an explicit mode: `codexSearch: cached` by default, `live` for external web access, or `off` to retain the client's web tools. Cached search sends `external_web_access: false`; live search sends `true`. Codex requests no longer inherit hosted image-generation declarations from the generic Responses path.

The payload is checked again after a caller's `onPayload` hook so that the selected search mode remains effective. Existing transcript tool changes, system messages, usage observation and hosted trace filtering are preserved. Unsupported account capabilities still surface as errors; no model or search mode is silently substituted.

macOS acceptance used a bounded GPT-6 Sol max cached-search request through the actual Desktop Host. This does not establish upstream search counts, billing, or support for every account and mode. Native Electron UI interaction remains unverified.

## Validation

All 213 tests passed on macOS, including local TLS fixtures and Codex SDK payload serialization that stops before network transport. Type checking, build, DSHX checks and archive validation passed. Server and client entry files exactly match the previously accepted v9 installation. A fresh authenticated Web run was blocked by an expired private browser handoff; no new real-model call was made for this release.
