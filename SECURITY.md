# Security Policy

## Supported versions

tunlite is pre-1.0. Only the latest released version receives security fixes.

## Reporting a vulnerability

Please report security issues **privately** — do not open a public issue.

Use GitHub's private vulnerability reporting:
**https://github.com/yuanyuanzijin/tunlite/security/advisories/new**

You'll get an acknowledgement as soon as possible. Once a fix is ready we'll cut a
release and credit you, unless you'd prefer to stay anonymous.

## Scope

tunlite wraps your system `ssh` to manage tunnels and key-based access. It stores no
passwords and never transmits your config (`export` omits secrets). Reports about how
tunlite invokes `ssh`, installs public keys (`setup-key`), or secures the daemon
socket / IPC are especially welcome.
