# Local TLS fixture

This is a public, disposable test key and self-signed certificate for
`oauth-proxy.test` and loopback. It protects no real service or data.
Tests add this certificate to their process-local trust store and restore the
original trust store afterward. TLS verification is never disabled.

The controlled CONNECT proxies and HTTPS/WSS origin run on ephemeral loopback
ports. No model provider, OAuth credential, or external network is involved.
