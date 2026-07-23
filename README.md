# AgentMail for OpenClaw

Give an OpenClaw agent an email address with [AgentMail](https://www.agentmail.to/). This package ships **two capabilities in one plugin**:

- **Email tools** — the agent can create inboxes and read, search, send, reply, forward, and label email on demand.
- **An email channel** — a durable, allowlisted, **reply-only** email channel. Inbound email drives agent turns; the agent replies within the AgentMail thread. Ingress is committed durably before acknowledgement, senders are authorized against a default-deny allowlist, and replies stay bound to the triggering message (`replyAll: false`, no proactive threads, no arbitrary recipients).

## Requirements

- Node.js 22.22.3+, 24.15+, or 25.9+
- OpenClaw 2026.7.2 (beta) or newer
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

Provide the API key through `AGENTMAIL_API_KEY` in the Gateway environment or as
`channels.agentmail.apiKey`. To enable **webhook** ingress, also configure
`AGENTMAIL_WEBHOOK_SECRET` (Svix-signed); without it the channel falls back to WebSocket ingress.

OpenClaw can scope the secrets to this plugin in `~/.openclaw/openclaw.json`:

```json5
{
  plugins: {
    entries: {
      agentmail: {
        enabled: true,
        env: {
          AGENTMAIL_API_KEY: "am_...",
          AGENTMAIL_WEBHOOK_SECRET: "whsec_...", // optional; enables webhook ingress
        },
      },
    },
  },
}
```

Keep keys out of source control. Restart the Gateway after installing or changing configuration:

```bash
openclaw gateway restart
openclaw plugins inspect agentmail --runtime
```

### Tool config (optional SDK settings)

> **Credentials:** the email **tools** use the resolved `apiKey` from the default
> `channels.agentmail` account when configured, with `AGENTMAIL_API_KEY` as the tools-only fallback.
> This keeps inline and secret-reference channel configuration shared across both surfaces.

Optional AgentMail SDK settings for the **tools** belong under `plugins.entries.agentmail.config`:

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

### Channel config

The **channel** is configured under `channels.agentmail` (single inbox) or `channels.agentmail.accounts.<id>` (multiple):

```json5
{
  channels: {
    agentmail: {
      apiKey: { source: "env", provider: "agentmail", id: "AGENTMAIL_API_KEY" },
      inboxId: "agent@agentmail.to",
      webhookSecret: { source: "env", provider: "agentmail", id: "AGENTMAIL_WEBHOOK_SECRET" },
      dmPolicy: "allowlist",       // default; an empty allowFrom denies every sender
      allowFrom: ["person@example.com"],
      mediaMaxMb: 20,
    },
  },
}
```

Security defaults worth knowing:

- `dmPolicy` defaults to `allowlist`. With an empty `allowFrom`, **every sender is denied**.
- `dmPolicy: "open"` requires `allowFrom` to include `"*"`.
- Every reply re-hydrates the triggering message and re-authorizes its `From`, so an untrusted `Reply-To` cannot redirect delivery.

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
npm run build          # tsc
npm run plugin:build   # build + regenerate openclaw.plugin.json
npm run plugin:check   # fail if the manifest is stale
npm test               # vitest
```

`plugin:build` compiles TypeScript and regenerates `openclaw.plugin.json` (tool metadata + channel declarations) via `scripts/build-manifest.mjs`. Commit manifest changes whenever tool metadata or the channel config schema changes.

## License

MIT
