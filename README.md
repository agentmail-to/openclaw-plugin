# AgentMail for OpenClaw

Give an OpenClaw agent an email address with [AgentMail](https://www.agentmail.to/). This package ships **two capabilities in one plugin**:

- **A CLI-backed AgentMail skill** — the agent uses the official AgentMail CLI bundled with the
  plugin. It can discover and use new AgentMail API resources without waiting for this plugin to
  add another fixed tool schema.
- **An email channel** — a durable, allowlisted, **reply-only** email channel. Inbound email drives agent turns; the agent replies within the AgentMail thread. Ingress is committed durably before acknowledgement, senders are authorized against a default-deny allowlist, and replies stay bound to the triggering message (`replyAll: false`, no proactive threads, no arbitrary recipients).

## Requirements

- Node.js 22.22.3–22.x, 24.15.0–24.x, or 25.9.0+
- OpenClaw 2026.8.1-beta.2 or newer
- An AgentMail API key from the [AgentMail console](https://console.agentmail.to/)

The published plugin includes the official AgentMail CLI for supported macOS, Linux, and Windows
architectures. A separate global CLI installation is not required.

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

Set `AGENTMAIL_API_KEY` in the environment that runs the OpenClaw Gateway. To enable **webhook** ingress for the channel, also set `AGENTMAIL_WEBHOOK_SECRET` (Svix-signed); without it the channel falls back to WebSocket ingress.

For a managed Gateway, put the channel secrets in `~/.openclaw/.env`:

```dotenv
AGENTMAIL_API_KEY=am_...
AGENTMAIL_WEBHOOK_SECRET=whsec_...
```

Keep keys out of source control. Restart the Gateway after installing or changing configuration:

```bash
openclaw gateway restart
openclaw plugins inspect agentmail --runtime
```

### CLI config

> **Credentials:** the bundled CLI does not trust credentials inherited from the invoking process.
> Configure its `apiKey` under `plugins.entries.agentmail.config` as an inline secret or SecretRef.
> The **channel** is configured separately under `channels.agentmail`.

The CLI credential and optional API base URL override belong under
`plugins.entries.agentmail.config`:

```json5
{
  plugins: {
    entries: {
      agentmail: {
        config: {
          apiKey: { source: "env", provider: "default", id: "AGENTMAIL_API_KEY" },
          baseUrl: "https://api.agentmail.to/v0",
        },
      },
    },
  },
}
```

The previous `timeoutSeconds` and `maxRetries` tool settings remain accepted so existing
configurations continue to load, but the bundled CLI does not use them.
For credential safety, command arguments cannot override `--api-key`, `--base-url`, or
`--environment`; only the operator-controlled plugin setting above can select the AgentMail
identity and API endpoint. The passthrough removes inherited AgentMail credentials, custom headers,
endpoint selectors, and standard proxy environment variables (`HTTP_PROXY`, `HTTPS_PROXY`,
`ALL_PROXY`, and `NO_PROXY`, including lowercase forms), then injects only the resolved configured
CLI credential.
If a command value must literally begin with `--base-url` or `--environment`, use the CLI's
`--option=value` form (for example, `--subject=--base-url-is-restricted`). Restricted-looking
standalone tokens are rejected in every argument position, so CLI grammar changes cannot turn one
into an unvalidated override.

### Channel config

The **channel** is configured under `channels.agentmail` (single inbox) or `channels.agentmail.accounts.<id>` (multiple):

```json5
{
  channels: {
    agentmail: {
      apiKey: { source: "env", provider: "default", id: "AGENTMAIL_API_KEY" },
      inboxId: "agent@agentmail.to",
      webhookSecret: { source: "env", provider: "default", id: "AGENTMAIL_WEBHOOK_SECRET" },
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

The configured `inboxId` also identifies the durable receive queue. Keep its casing stable across
upgrades: changing only letter case can create a new queue identity, so messages covered only by
older completion tombstones may be dispatched once more during the migration.

Durable REST recovery accommodates provider message timestamps up to 24 hours ahead of the local
clock. Messages farther in the future are still handled by live webhook or WebSocket delivery, but
missed-live recovery follows the provider timestamp and may be delayed until it enters that window.

## CLI-backed skill

The plugin registers a passthrough command:

```bash
openclaw agentmail -- --help
openclaw agentmail -- --format json inboxes list
openclaw agentmail -- --format json inboxes:messages send \
  --inbox-id agent@agentmail.to \
  --to person@example.com \
  --subject "Hello" \
  --text "Hello from OpenClaw"
```

Keep the `--` separator so OpenClaw forwards all following flags to AgentMail. The included skill
uses JSON output, consults CLI help instead of guessing flags, and covers inboxes, messages,
threads, drafts, webhooks, domains, pods, API keys, and future CLI resources.

The CLI skill runs on the OpenClaw host because that is where its executable and credentials are
installed. Sandboxed agents need permission to execute this host command.

## Develop

```bash
npm install
npm run build          # tsc
npm run cli:prepare    # fetch + verify the current platform's pinned AgentMail CLI
npm run plugin:build   # build + prepare CLI + regenerate openclaw.plugin.json
npm run plugin:check   # fail if the manifest is stale
npm test               # vitest
```

`plugin:build` compiles TypeScript, downloads the pinned CLI release for the current platform,
verifies its SHA-256 checksum, and regenerates `openclaw.plugin.json`. `npm pack` prepares every
supported CLI target so installation never runs lifecycle scripts or downloads executables. Do not
publish with lifecycle scripts disabled (`--ignore-scripts`), because `prepack` is what assembles
and validates the complete eight-platform vendor tree.

CLI release version, archive checksums, and extracted-executable checksums live in
`src/cli/agentmail-cli-release.json`. Update that file when intentionally adopting a new AgentMail
CLI release.

## License

MIT
