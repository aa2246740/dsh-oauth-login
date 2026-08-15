# Install dsh-pi-login

Private repository. Clone, then add the folder.

```sh
git clone https://github.com/aa2246740/dsh-pi-login.git
dsh plugin --profile web add ./dsh-pi-login
```

Restart `dsh web`. Settings → **Pi Login**.

```sh
dsh plugin --profile web exec dsh-pi-login login openai-codex
dsh plugin --profile web exec dsh-pi-login status
dsh plugin --profile web exec dsh-pi-login logout openai-codex
```

Uninstall:

```sh
dsh plugin --profile web exec dsh-pi-login logout
dsh plugin --profile web remove dsh-pi-login
```
