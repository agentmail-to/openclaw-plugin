import { Type } from "typebox";
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import {
  agentMailConfigSchema,
  createAgentMailClient,
  requestOptions,
} from "./client.js";

const nonEmptyString = (description: string) =>
  Type.String({ description, minLength: 1 });

const optionalRecipients = (description: string) =>
  Type.Optional(
    Type.Array(nonEmptyString(description), {
      description,
      maxItems: 50,
    }),
  );

const optionalLabels = Type.Optional(
  Type.Array(nonEmptyString("Label name."), {
    description: "Message labels.",
    maxItems: 100,
  }),
);

const optionalDateTime = (description: string) =>
  Type.Optional(Type.String({ description, format: "date-time" }));

const attachmentsSchema = Type.Optional(
  Type.Array(
    Type.Object(
      {
        filename: Type.Optional(nonEmptyString("Attachment filename.")),
        contentType: Type.Optional(nonEmptyString("MIME content type.")),
        contentDisposition: Type.Optional(
          Type.Union([Type.Literal("attachment"), Type.Literal("inline")], {
            description: "Whether the attachment is downloaded or displayed inline.",
          }),
        ),
        contentId: Type.Optional(nonEmptyString("Content ID for an inline attachment.")),
        content: Type.Optional(nonEmptyString("Base64-encoded attachment content.")),
        url: Type.Optional(nonEmptyString("Public URL from which AgentMail can fetch the attachment.")),
      },
      { additionalProperties: false },
    ),
    { description: "Attachments to include in the message." },
  ),
);

const composeFields = {
  to: optionalRecipients("Recipient email address."),
  cc: optionalRecipients("CC recipient email address."),
  bcc: optionalRecipients("BCC recipient email address."),
  replyTo: optionalRecipients("Reply-to email address."),
  labels: optionalLabels,
  text: Type.Optional(Type.String({ description: "Plain-text message body." })),
  html: Type.Optional(Type.String({ description: "HTML message body." })),
  attachments: attachmentsSchema,
};

const messageLocationFields = {
  inboxId: nonEmptyString("Inbox ID or email address that owns the message."),
  messageId: nonEmptyString("AgentMail message ID."),
};

function parseDate(value: string | undefined): Date | undefined {
  if (!value) {
    return undefined;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    // Fail fast with a clear message instead of passing an Invalid Date into the SDK, which would
    // otherwise surface later as an opaque RangeError.
    throw new Error(`Invalid ISO 8601 timestamp: ${JSON.stringify(value)}`);
  }
  return date;
}

export default defineToolPlugin({
  id: "agentmail",
  name: "AgentMail",
  description: "Create AgentMail inboxes and send, receive, search, and manage email.",
  configSchema: agentMailConfigSchema,
  tools: (tool) => [
    tool({
      name: "agentmail_list_inboxes",
      label: "List AgentMail inboxes",
      description: "List the email inboxes available to the configured AgentMail account.",
      parameters: Type.Object({
        limit: Type.Optional(
          Type.Integer({ description: "Maximum number of inboxes to return.", minimum: 1 }),
        ),
        pageToken: Type.Optional(nonEmptyString("Pagination token from a previous response.")),
        ascending: Type.Optional(
          Type.Boolean({ description: "Return inboxes in ascending creation order." }),
        ),
      }, { additionalProperties: false }),
      execute: async (params, config, context) => {
        const client = createAgentMailClient(config, context.api.config);
        return client.inboxes.list(params, requestOptions(context.signal));
      },
    }),
    tool({
      name: "agentmail_create_inbox",
      label: "Create AgentMail inbox",
      description:
        "Create an AgentMail inbox. Use clientId when the operation may be retried to avoid duplicate inboxes.",
      parameters: Type.Object(
        {
          username: Type.Optional(nonEmptyString("Requested email username.")),
          domain: Type.Optional(nonEmptyString("Verified domain; defaults to agentmail.to.")),
          displayName: Type.Optional(nonEmptyString("Human-readable sender display name.")),
          clientId: Type.Optional(nonEmptyString("Idempotency key for inbox creation.")),
          metadata: Type.Optional(
            Type.Record(
              Type.String(),
              Type.Union([Type.String(), Type.Number(), Type.Boolean()]),
              { description: "Custom inbox metadata." },
            ),
          ),
        },
        { additionalProperties: false },
      ),
      execute: async (params, config, context) => {
        const client = createAgentMailClient(config, context.api.config);
        return client.inboxes.create(params, requestOptions(context.signal));
      },
    }),
    tool({
      name: "agentmail_list_messages",
      label: "List AgentMail messages",
      description:
        "List messages in an AgentMail inbox, newest first by default. Supports labels and exact-field substring filters.",
      parameters: Type.Object(
        {
          inboxId: nonEmptyString("Inbox ID or email address to read."),
          limit: Type.Optional(
            Type.Integer({ description: "Maximum number of messages to return.", minimum: 1 }),
          ),
          pageToken: Type.Optional(nonEmptyString("Pagination token from a previous response.")),
          labels: optionalLabels,
          before: optionalDateTime("Only include messages before this ISO 8601 timestamp."),
          after: optionalDateTime("Only include messages after this ISO 8601 timestamp."),
          ascending: Type.Optional(
            Type.Boolean({ description: "Return messages oldest first." }),
          ),
          includeSpam: Type.Optional(Type.Boolean({ description: "Include spam messages." })),
          includeBlocked: Type.Optional(Type.Boolean({ description: "Include blocked messages." })),
          includeUnauthenticated: Type.Optional(
            Type.Boolean({ description: "Include unauthenticated messages." }),
          ),
          includeTrash: Type.Optional(Type.Boolean({ description: "Include trashed messages." })),
          from: Type.Optional(
            Type.Array(nonEmptyString("Sender substring filter."), {
              description: "Sender substring filters; all values must match.",
            }),
          ),
          to: Type.Optional(
            Type.Array(nonEmptyString("Recipient substring filter."), {
              description: "Recipient substring filters; all values must match.",
            }),
          ),
          subject: Type.Optional(
            Type.Array(nonEmptyString("Subject substring filter."), {
              description: "Subject substring filters; all values must match.",
            }),
          ),
        },
        { additionalProperties: false },
      ),
      execute: async ({ inboxId, before, after, ...params }, config, context) => {
        const client = createAgentMailClient(config, context.api.config);
        return client.inboxes.messages.list(
          inboxId,
          {
            ...params,
            ...(before ? { before: parseDate(before) } : {}),
            ...(after ? { after: parseDate(after) } : {}),
          },
          requestOptions(context.signal),
        );
      },
    }),
    tool({
      name: "agentmail_search_messages",
      label: "Search AgentMail messages",
      description:
        "Full-text search an AgentMail inbox across sender, recipients, subject, and body, ranked by relevance.",
      parameters: Type.Object(
        {
          inboxId: nonEmptyString("Inbox ID or email address to search."),
          query: nonEmptyString("Full-text search query."),
          limit: Type.Optional(
            Type.Integer({ description: "Maximum number of matches to return.", minimum: 1, maximum: 100 }),
          ),
          pageToken: Type.Optional(nonEmptyString("Pagination token from a previous response.")),
          before: optionalDateTime("Only include messages before this ISO 8601 timestamp."),
          after: optionalDateTime("Only include messages after this ISO 8601 timestamp."),
        },
        { additionalProperties: false },
      ),
      execute: async ({ inboxId, query, before, after, ...params }, config, context) => {
        const client = createAgentMailClient(config, context.api.config);
        return client.inboxes.messages.search(
          inboxId,
          {
            q: query,
            ...params,
            ...(before ? { before: parseDate(before) } : {}),
            ...(after ? { after: parseDate(after) } : {}),
          },
          requestOptions(context.signal),
        );
      },
    }),
    tool({
      name: "agentmail_get_message",
      label: "Get AgentMail message",
      description:
        "Get one complete AgentMail message. Prefer extractedText or extractedHtml when processing a reply without quoted history.",
      parameters: Type.Object(messageLocationFields, { additionalProperties: false }),
      execute: async ({ inboxId, messageId }, config, context) => {
        const client = createAgentMailClient(config, context.api.config);
        return client.inboxes.messages.get(
          inboxId,
          messageId,
          requestOptions(context.signal),
        );
      },
    }),
    tool({
      name: "agentmail_send_message",
      label: "Send AgentMail message",
      description:
        "Send a new email from an AgentMail inbox. Provide both text and HTML when practical for accessibility and deliverability.",
      parameters: Type.Object(
        {
          inboxId: nonEmptyString("Inbox ID or email address to send from."),
          to: Type.Array(nonEmptyString("Recipient email address."), {
            description: "Primary recipients.",
            minItems: 1,
            maxItems: 50,
          }),
          subject: nonEmptyString("Email subject."),
          text: Type.Optional(Type.String({ description: "Plain-text message body." })),
          html: Type.Optional(Type.String({ description: "HTML message body." })),
          cc: composeFields.cc,
          bcc: composeFields.bcc,
          replyTo: composeFields.replyTo,
          labels: composeFields.labels,
          attachments: composeFields.attachments,
          idempotencyKey: Type.Optional(
            nonEmptyString("Key that prevents duplicate sends when retrying the same operation."),
          ),
        },
        { additionalProperties: false },
      ),
      execute: async ({ inboxId, idempotencyKey, ...message }, config, context) => {
        const client = createAgentMailClient(config, context.api.config);
        return client.inboxes.messages.send(inboxId, message, {
          ...requestOptions(context.signal),
          ...(idempotencyKey ? { idempotencyKey } : {}),
        });
      },
    }),
    tool({
      name: "agentmail_reply_to_message",
      label: "Reply to AgentMail message",
      description: "Reply to an existing message while keeping the AgentMail thread intact.",
      parameters: Type.Object(
        {
          ...messageLocationFields,
          text: composeFields.text,
          html: composeFields.html,
          to: composeFields.to,
          cc: composeFields.cc,
          bcc: composeFields.bcc,
          replyTo: composeFields.replyTo,
          labels: composeFields.labels,
          attachments: composeFields.attachments,
          replyAll: Type.Optional(
            Type.Boolean({ description: "Reply to all original recipients." }),
          ),
          idempotencyKey: Type.Optional(
            nonEmptyString("Key that prevents duplicate replies when retrying the same operation."),
          ),
        },
        { additionalProperties: false },
      ),
      execute: async (
        { inboxId, messageId, idempotencyKey, ...message },
        config,
        context,
      ) => {
        const client = createAgentMailClient(config, context.api.config);
        return client.inboxes.messages.reply(inboxId, messageId, message, {
          ...requestOptions(context.signal),
          ...(idempotencyKey ? { idempotencyKey } : {}),
        });
      },
    }),
    tool({
      name: "agentmail_forward_message",
      label: "Forward AgentMail message",
      description: "Forward an existing AgentMail message to one or more recipients.",
      parameters: Type.Object(
        {
          ...messageLocationFields,
          to: Type.Array(nonEmptyString("Recipient email address."), {
            description: "Forward recipients.",
            minItems: 1,
            maxItems: 50,
          }),
          subject: Type.Optional(nonEmptyString("Optional subject override.")),
          text: composeFields.text,
          html: composeFields.html,
          cc: composeFields.cc,
          bcc: composeFields.bcc,
          replyTo: composeFields.replyTo,
          labels: composeFields.labels,
          attachments: composeFields.attachments,
          idempotencyKey: Type.Optional(
            nonEmptyString("Key that prevents duplicate forwards when retrying the same operation."),
          ),
        },
        { additionalProperties: false },
      ),
      execute: async (
        { inboxId, messageId, idempotencyKey, ...message },
        config,
        context,
      ) => {
        const client = createAgentMailClient(config, context.api.config);
        return client.inboxes.messages.forward(inboxId, messageId, message, {
          ...requestOptions(context.signal),
          ...(idempotencyKey ? { idempotencyKey } : {}),
        });
      },
    }),
    tool({
      name: "agentmail_update_message_labels",
      label: "Update AgentMail message labels",
      description:
        "Add or remove labels on a message, for example adding read and removing unread after processing it.",
      parameters: Type.Object(
        {
          ...messageLocationFields,
          addLabels: Type.Optional(
            Type.Array(nonEmptyString("Label to add."), { minItems: 1 }),
          ),
          removeLabels: Type.Optional(
            Type.Array(nonEmptyString("Label to remove."), { minItems: 1 }),
          ),
        },
        { additionalProperties: false },
      ),
      execute: async (
        { inboxId, messageId, ...labels },
        config,
        context,
      ) => {
        if (!labels.addLabels && !labels.removeLabels) {
          throw new Error("Provide addLabels or removeLabels.");
        }

        const client = createAgentMailClient(config, context.api.config);
        return client.inboxes.messages.update(
          inboxId,
          messageId,
          labels,
          requestOptions(context.signal),
        );
      },
    }),
  ],
});
