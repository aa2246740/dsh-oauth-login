# Install dsh-oauth-login

[中文](INSTALL.zh.md). Product pages: [README.md](README.md) (中文), [README.en.md](README.en.md).

Clone the public repository, then add the folder as a `file:` package.

```sh
git clone https://github.com/aa2246740/dsh-oauth-login.git
dsh plugin --profile web add file:./dsh-oauth-login
```

Keep the `file:` prefix. A bare `./dsh-oauth-login` becomes a symlink, while this
plugin intentionally resolves its DSH runtime peer dependencies from the
profile; the `file:` install copies the package into that resolution tree.

Restart `dsh web`. Settings → **OAuth Login**. Existing DSH installs keep the old filename as a one-time DSH migration source and never touch Pi Agent auth.

```sh
dsh plugin --profile web exec dsh-oauth-login login openai-codex
dsh plugin --profile web exec dsh-oauth-login status
dsh plugin --profile web exec dsh-oauth-login logout openai-codex
```

The plugin automatically honors inherited proxy variables, then checks
`DSH_OAUTH_PROXY`, the reachable macOS system proxy, and verified local HTTP
CONNECT proxies before falling back to direct access. It never adds geographic
metadata. Restart `dsh web` after changing proxy applications or settings.

Uninstall:

```sh
dsh plugin --profile web exec dsh-oauth-login logout
dsh plugin --profile web remove dsh-oauth-login
```
