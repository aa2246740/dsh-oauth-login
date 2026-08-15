# 安装 dsh-pi-login

私有仓库。先 clone，再按文件夹安装。

```sh
git clone https://github.com/aa2246740/dsh-pi-login.git
dsh plugin --profile web add ./dsh-pi-login
```

重启 `dsh web`。设置 → **Pi 登录**。

```sh
dsh plugin --profile web exec dsh-pi-login login openai-codex
dsh plugin --profile web exec dsh-pi-login status
dsh plugin --profile web exec dsh-pi-login logout openai-codex
```

卸载：

```sh
dsh plugin --profile web exec dsh-pi-login logout
dsh plugin --profile web remove dsh-pi-login
```
