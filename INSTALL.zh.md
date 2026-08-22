# 安装 dsh-oauth-login

[English](INSTALL.md)。说明和截图在 [README.md](README.md)，英文在 [README.en.md](README.en.md)。

克隆公开仓库，再按 `file:` 包安装。

```sh
git clone https://github.com/aa2246740/dsh-oauth-login.git
dsh plugin --profile web add file:./dsh-oauth-login
```

请保留 `file:` 前缀。直接写 `./dsh-oauth-login` 会变成符号链接；本插件有意从 profile 复用 DSH 运行时的 peer dependency，因此必须使用 `file:` 副本，才能正确解析依赖。

重启 `dsh web`。设置 → **OAuth 登录**。旧版 DSH 文件只作为一次性迁移来源，不会读取或修改 Pi Agent 的登录文件。

```sh
dsh plugin --profile web exec dsh-oauth-login login openai-codex
dsh plugin --profile web exec dsh-oauth-login status
dsh plugin --profile web exec dsh-oauth-login logout openai-codex
```

插件会先使用 DSH 已继承的代理变量，再检查 `DSH_OAUTH_PROXY`、可连接的 macOS 系统代理以及通过验证的本机 HTTP CONNECT 代理，最后才回退到直连；不会添加任何地区信息。代理应用或设置改变后请重启 `dsh web`。

卸载：

```sh
dsh plugin --profile web exec dsh-oauth-login logout
dsh plugin --profile web remove dsh-oauth-login
```
