# Linus's Pi Plugins

Personal extensions for the [Pi coding agent](https://pi.dev).

## Install

```bash
pi install git:github.com/linusboehm/pi-plugins
```

Restart Pi after installation, or run `/reload` in an existing session.

## Extensions

### `/answer`

Extracts questions from the latest assistant response and presents an interactive form for answering them one at a time. Explicit recommendations and lettered or numbered multiple-choice options are preserved and displayed with the question.

It prefers an authenticated Codex Mini model, then Claude Haiku, and otherwise uses the current model. Requests go through Pi's model registry so API keys, OAuth credentials, provider headers, and custom provider configuration are respected.

Use either:

```text
/answer
```

or `Ctrl+.`.

### `/btw`

Opens a persistent side conversation without interrupting the main agent thread. The side chat receives the main conversation as context, can use coding tools, and can optionally summarize its findings back into the main chat.

Open the side-chat overlay:

```text
/btw
```

Ask immediately:

```text
/btw How does this module work?
```

When closing a non-empty side chat, choose whether to keep it for later or inject a summary into the main conversation.

## Update

```bash
pi update git:github.com/linusboehm/pi-plugins
```

## Uninstall

```bash
pi remove git:github.com/linusboehm/pi-plugins
```
