# 安装 dsh-oauth-login

[English](INSTALL.md)。说明和截图在 [README.md](README.md)，英文在 [README.en.md](README.en.md)。

克隆公开仓库，再按 `file:` 包安装。

```sh
git clone https://github.com/aa2246740/dsh-oauth-login.git
dsh plugin --profile web add file:./dsh-oauth-login
```

请保留 `file:` 前缀。直接写 `./dsh-oauth-login` 会变成符号链接；本插件有意从 profile 复用 DSH 运行时的 peer dependency，因此必须使用 `file:` 副本，才能正确解析依赖。

重启 `dsh web`。设置 → **订阅登录**。旧版 DSH 文件只作为一次性迁移来源，不会读取或修改 Pi Agent 的登录文件。

```sh
dsh plugin --profile web exec dsh-oauth-login login openai-codex
dsh plugin --profile web exec dsh-oauth-login login zai-coding-cn
dsh plugin --profile web exec dsh-oauth-login status
dsh plugin --profile web exec dsh-oauth-login logout openai-codex
```

智谱 GLM Coding Plan 会打开官方套餐页，再在本机提示你输入 API Key；
插件不会读取你的浏览器登录状态。

升级服务端插件后先重启一次 DSH，再进入「设置 → 订阅登录 → 网络代理」。HTTP 与 WebSocket 可以独立配置，地址默认填入 `http://127.0.0.1`，端口留空。开启并填写端口时优先使用该代理；默认地址且端口留空时沿用自动发现，不会默认使用 80 端口；关闭时直接连接。请使用 HTTP(S) CONNECT / 混合代理端口，不能填纯 SOCKS 端口。页面保存后用于新请求，不需要再次重启；改变启动时继承的环境变量则需要重启。详见[网络代理与恢复机制](docs/network-proxy.md)。

卸载：

```sh
dsh plugin --profile web exec dsh-oauth-login logout
dsh plugin --profile web remove dsh-oauth-login
```
