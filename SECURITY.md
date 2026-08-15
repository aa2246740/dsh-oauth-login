# Security Policy

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting for this repository:

1. Open the repository's **Security** tab.
2. Choose **Report a vulnerability**.
3. Include reproduction steps without including real credentials.

Do not open a public issue containing OAuth callback URLs, authorization codes,
access or refresh tokens, API keys, cookies, or the contents of
`$DSH_HOME/.dsh-oauth-auth.json`.

## Security boundaries

- DSH owns a separate OAuth grant and never reads or writes Pi Agent or official
  CLI auth files.
- Stored credentials are restricted to the current operating-system user.
- Local proxy candidates must pass a credential-free HTTP CONNECT probe before
  use. OAuth payloads remain protected by end-to-end TLS.
- Authorization URLs are restricted to the provider hosts declared by the
  installed Pi AI provider catalog.

The `0.1.x` line receives security fixes while it is the latest release line.
