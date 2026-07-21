# AgentMail for OpenClaw

Give an OpenClaw agent an email address with [AgentMail](https://www.agentmail.to/). This native tool plugin can create inboxes, read and search messages, send new email, reply and forward within threads, and manage message labels.

## Requirements

- Node.js 22.22.3+, 24.15+, or 25.9+
- OpenClaw 2026.5.17 or newer
- An AgentMail API key from the [AgentMail console](https://console.agentmail.to/)

## Install

Build and install a local checkout:

```bash
npm install
npm run plugin:build
openclaw plugins install .
openclaw plugins enable agentmail
```

For development, use `openclaw plugins install --link .` so OpenClaw loads this checkout directly.

## Configure

Set `AGENTMAIL_API_KEY` in the environment that runs the OpenClaw Gateway. OpenClaw can scope it to this plugin in `~/.openclaw/openclaw.json`:

```json5
{
  plugins: {
    entries: {
      agentmail: {
        enabled: true,
        env: {
          AGENTMAIL_API_KEY: "am_...",
        },
      },
    },
  },
}
```

Keep the key out of source control. Restart the Gateway after installing or changing configuration:

```bash
openclaw gateway restart
openclaw plugins inspect agentmail --runtime
```

Optional SDK settings belong under `plugins.entries.agentmail.config`:

```json5
{
  plugins: {
    entries: {
      agentmail: {
        config: {
          timeoutSeconds: 30,
          maxRetries: 2,
          // baseUrl: "https://api.agentmail.to/v0",
        },
      },
    },
  },
}
```

## Tools

| Tool | Purpose |
| --- | --- |
| `agentmail_list_inboxes` | List available inboxes |
| `agentmail_create_inbox` | Create an inbox, with optional idempotent `clientId` |
| `agentmail_list_messages` | List and filter messages in an inbox |
| `agentmail_search_messages` | Full-text search messages |
| `agentmail_get_message` | Retrieve a complete message |
| `agentmail_send_message` | Send text/HTML email with optional attachments |
| `agentmail_reply_to_message` | Reply or reply-all in an existing thread |
| `agentmail_forward_message` | Forward an existing message |
| `agentmail_update_message_labels` | Add or remove labels, including `read`/`unread` |

Send, reply, and forward accept an optional `idempotencyKey` to make retries safe. Attachments can use Base64-encoded `content` or a public `url`.

## Develop

```bash
npm install
npm run plugin:build
npm run plugin:validate
npm test
```

`plugin:build` compiles TypeScript and regenerates `openclaw.plugin.json`. Commit manifest changes whenever tool metadata or plugin configuration changes.

## License

MIT
