# dsh-oauth-login 0.2.10

## DeepSeek Harness compatibility

Built and tested against DeepSeek Harness `0.2.1-rc.2` (`687f282e8625c6b8d11ff58211a90524be2e4317`). Use the prebuilt release package or this repository’s compiled artifacts with the official plugin installer.

`@deepseek-ai/dsh` peer and `engines.dsh` are `>=0.2.1-rc.1 <0.2.2`. Host prefers `engines.dsh` since 0.2.1. Runtime invariants companion (`./invariant`, `@deepseek-ai/dsh-invariants`) is removed per the official upgrade guide. Development pins and `@earendil-works/pi-ai` move to the 0.2.1 / 1.x stack (`pi-ai` `^1.1.0`).

Validation was performed on cloud Linux. This release does not claim new Windows or macOS runtime acceptance beyond the stock web Host proof in the adapt PR.
