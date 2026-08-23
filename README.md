# Linus's Pi Plugins

Personal extensions for the [Pi coding agent](https://pi.dev).

## Install

```bash
pi install git:github.com/linusboehm/pi-plugins
```

Restart Pi after installation, or run `/reload` in an existing session.

## Extensions

### `/answer`

Extracts questions from the latest assistant response and presents an interactive form for answering them one at a time.

It prefers an authenticated Codex Mini model, then Claude Haiku, and otherwise uses the current model. Requests go through Pi's model registry so API keys, OAuth credentials, provider headers, and custom provider configuration are respected.

Use either:

```text
/answer
```

or `Ctrl+.`.

## Update

```bash
pi update git:github.com/linusboehm/pi-plugins
```

## Uninstall

```bash
pi remove git:github.com/linusboehm/pi-plugins
```
