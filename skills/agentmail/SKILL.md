---
name: agentmail
description: "Manage AgentMail inboxes, messages, threads, drafts, webhooks, domains, pods, and API keys with the bundled AgentMail CLI."
metadata:
  {
    "openclaw":
      {
        "requires": { "bins": ["openclaw"], "env": ["AGENTMAIL_API_KEY"] },
        "primaryEnv": "AGENTMAIL_API_KEY",
      },
  }
---

# AgentMail CLI

Use the AgentMail CLI bundled with this plugin through:

```bash
openclaw agentmail -- <agentmail arguments>
```

Always put `--` after `agentmail`; it prevents OpenClaw from interpreting AgentMail flags.
Never pass `--api-key`, `--base-url`, `--environment`, or print the API key. Authentication is
inherited from `AGENTMAIL_API_KEY`, and only operator-controlled plugin configuration may select
the API endpoint.

Run this command on the OpenClaw host, not inside an agent sandbox. The bundled executable and
skill-scoped credentials are available only to host execution.

## Discover commands dynamically

The CLI is the source of truth. Inspect help before guessing a resource, command, or flag:

```bash
openclaw agentmail -- --help
openclaw agentmail -- inboxes --help
openclaw agentmail -- inboxes:messages --help
openclaw agentmail -- inboxes:messages send --help
```

Prefer machine-readable output:

```bash
openclaw agentmail -- --format json --format-error json inboxes list
```

Use `--transform '<gjson expression>'` when it can reduce a large response without losing
information needed for the task.

## Common operations

```bash
# Inboxes
openclaw agentmail -- --format json inboxes list
openclaw agentmail -- --format json inboxes create --display-name "My Agent"
openclaw agentmail -- --format json inboxes get --inbox-id <inbox-id>

# Messages
openclaw agentmail -- --format json inboxes:messages list --inbox-id <inbox-id>
openclaw agentmail -- --format json inboxes:messages get \
  --inbox-id <inbox-id> --message-id <message-id>
openclaw agentmail -- --format json inboxes:messages send \
  --inbox-id <inbox-id> \
  --to recipient@example.com \
  --subject "Subject" \
  --text "Plain-text body"
openclaw agentmail -- --format json inboxes:messages reply \
  --inbox-id <inbox-id> --message-id <message-id> --text "Reply body"
openclaw agentmail -- --format json inboxes:messages forward \
  --inbox-id <inbox-id> --message-id <message-id> --to recipient@example.com

# Threads and drafts
openclaw agentmail -- --format json inboxes:threads list --inbox-id <inbox-id>
openclaw agentmail -- --format json inboxes:drafts list --inbox-id <inbox-id>

# Other API resources
openclaw agentmail -- webhooks --help
openclaw agentmail -- domains --help
openclaw agentmail -- pods --help
openclaw agentmail -- api-keys --help
```

Before destructive operations, bulk changes, creating credentials, or sending email to a new
recipient, follow the user's approval and confirmation policy. Use idempotency flags when the
command help exposes them and an operation may be retried.

For attachments, the CLI accepts `@path`, `@file://path`, and `@data://path` arguments. Read only
files the user has authorized and prefer `@data://` for binary content.
