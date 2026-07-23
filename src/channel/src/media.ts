import { rm } from "node:fs/promises";
import type { AgentMail, AgentMailClient } from "agentmail";
import { normalizeMimeType } from "openclaw/plugin-sdk/media-mime";
import { saveMediaBuffer } from "openclaw/plugin-sdk/media-store";
import {
  loadOutboundMediaFromUrl,
  type OutboundMediaLoadOptions,
} from "openclaw/plugin-sdk/outbound-media";
import { sanitizeUntrustedFileName } from "openclaw/plugin-sdk/security-runtime";
import { MediaFetchError } from "openclaw/plugin-sdk/media-runtime";
import { loadWebMediaRaw } from "openclaw/plugin-sdk/web-media";

export type AgentMailInboundMedia = {
  paths: string[];
  types: string[];
};

export class AgentMailMediaPolicyError extends Error {}

function isAcceptedAttachment(attachment: AgentMail.Attachment): boolean {
  const disposition = attachment.contentDisposition?.toLocaleLowerCase("en-US");
  // An explicit attachment disposition wins even when the part also has a Content-ID. A bare
  // Content-ID is how embedded HTML images are commonly represented, so exclude those from the
  // user's attachment set and aggregate budget.
  return disposition === "attachment" || (disposition !== "inline" && !attachment.contentId);
}

function addAttachmentBytesToBudget(params: {
  currentBytes: number;
  attachmentBytes: number;
  maxBytes: number;
  errorMessage: string;
}): number {
  const nextBytes = params.currentBytes + params.attachmentBytes;
  if (!Number.isSafeInteger(nextBytes) || nextBytes > params.maxBytes) {
    throw new AgentMailMediaPolicyError(params.errorMessage);
  }
  return nextBytes;
}

function rethrowMediaFetchAsPolicy(error: unknown, message: string): never {
  if (error instanceof MediaFetchError && error.code === "max_bytes") {
    throw new AgentMailMediaPolicyError(message, { cause: error });
  }
  throw error;
}

export async function loadAgentMailInboundAttachments(params: {
  client: AgentMailClient;
  inboxId: string;
  messageId: string;
  attachments: readonly AgentMail.Attachment[];
  maxBytes: number;
}): Promise<AgentMailInboundMedia> {
  const accepted = params.attachments.filter(isAcceptedAttachment);
  let declaredBytes = 0;
  for (const attachment of accepted) {
    // Hydrated AgentMail.Attachment objects require `size` in the provider SDK contract. Keep the
    // runtime check as a fail-closed guard for malformed or version-skewed provider payloads.
    const declaredSize: unknown = attachment.size;
    if (
      typeof declaredSize !== "number" ||
      !Number.isSafeInteger(declaredSize) ||
      declaredSize < 0
    ) {
      throw new AgentMailMediaPolicyError("AgentMail attachment has an invalid declared size");
    }
    if (declaredSize > params.maxBytes) {
      throw new AgentMailMediaPolicyError(
        "AgentMail attachment exceeds the configured per-file media limit",
      );
    }
    declaredBytes = addAttachmentBytesToBudget({
      currentBytes: declaredBytes,
      attachmentBytes: declaredSize,
      maxBytes: params.maxBytes,
      errorMessage: "AgentMail attachments exceed the configured aggregate media limit",
    });
  }

  // Download every part before persisting any of them so a failed signed URL never dispatches a
  // partial set. Keep this serial: each bounded fetch receives the remaining aggregate budget,
  // while parallel fetches could temporarily buffer the full limit once per attachment.
  const downloaded: Array<{
    buffer: Buffer;
    contentType?: string;
    filename: string;
  }> = [];
  let actualBytes = 0;
  for (const attachment of accepted) {
    const metadata = await params.client.inboxes.messages.getAttachment(
      params.inboxId,
      params.messageId,
      attachment.attachmentId,
    );
    // Each fetch is bounded by the remaining aggregate budget. The earlier declared-size loop
    // already enforced the per-file limit, so a max_bytes failure here is always aggregate
    // exhaustion (actual bytes exceeding declared). This also makes a post-fetch aggregate guard
    // unreachable, so it is intentionally omitted.
    const remaining = params.maxBytes - actualBytes;
    let loaded;
    try {
      loaded = await loadWebMediaRaw(metadata.downloadUrl, { maxBytes: remaining });
    } catch (error) {
      rethrowMediaFetchAsPolicy(
        error,
        "AgentMail attachments exceed the configured aggregate media limit",
      );
    }
    actualBytes = addAttachmentBytesToBudget({
      currentBytes: actualBytes,
      attachmentBytes: loaded.buffer.byteLength,
      maxBytes: params.maxBytes,
      errorMessage: "AgentMail attachments exceed the configured aggregate media limit",
    });
    downloaded.push({
      buffer: loaded.buffer,
      contentType:
        // Use || not ??: an empty-string provider contentType must not win over the sniffed type.
        normalizeMimeType(metadata.contentType || loaded.contentType) ?? "application/octet-stream",
      // saveMediaBuffer owns inbound filename sanitization at the persistence boundary.
      filename: metadata.filename || `attachment-${attachment.attachmentId}`,
    });
  }

  // Persist serially and roll back on failure. A partial Promise.all would orphan already-saved
  // files while the durable retry re-downloads the whole set, leaking one copy per attempt.
  const saved: Array<{ path: string; contentType?: string }> = [];
  try {
    for (const attachment of downloaded) {
      saved.push(
        await saveMediaBuffer(
          attachment.buffer,
          attachment.contentType,
          "inbound",
          params.maxBytes,
          attachment.filename,
        ),
      );
    }
  } catch (error) {
    await Promise.allSettled(saved.map((item) => rm(item.path, { force: true })));
    throw error;
  }
  return {
    paths: saved.map((item) => item.path),
    types: saved.map((item) => item.contentType ?? "application/octet-stream"),
  };
}

export async function loadAgentMailOutboundAttachments(params: {
  mediaUrls: readonly string[];
  maxBytes: number;
  mediaAccess?: OutboundMediaLoadOptions["mediaAccess"];
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
}): Promise<AgentMail.SendAttachment[]> {
  let totalBytes = 0;
  const attachments: AgentMail.SendAttachment[] = [];
  for (const [index, mediaUrl] of params.mediaUrls.entries()) {
    if (totalBytes >= params.maxBytes) {
      throw new AgentMailMediaPolicyError(
        "AgentMail outbound attachments exceed the configured aggregate media limit",
      );
    }
    let loaded;
    try {
      loaded = await loadOutboundMediaFromUrl(mediaUrl, {
        // Bound each fetch by the REMAINING aggregate budget so a multi-file reply cannot buffer up
        // to the full per-file limit once per attachment and blow past the intended memory bound.
        maxBytes: params.maxBytes - totalBytes,
        mediaAccess: params.mediaAccess,
        mediaLocalRoots: params.mediaLocalRoots,
        mediaReadFile: params.mediaReadFile,
      });
    } catch (error) {
      rethrowMediaFetchAsPolicy(
        error,
        "AgentMail outbound attachments exceed the configured aggregate media limit",
      );
    }
    totalBytes = addAttachmentBytesToBudget({
      currentBytes: totalBytes,
      attachmentBytes: loaded.buffer.byteLength,
      maxBytes: params.maxBytes,
      errorMessage: "AgentMail outbound attachments exceed the configured aggregate media limit",
    });
    // Convert to base64 immediately and let the source buffer go out of scope; only the encoded
    // representation is retained for the reply payload.
    attachments.push({
      filename: sanitizeUntrustedFileName(loaded.fileName ?? "", `attachment-${index + 1}`),
      contentType: normalizeMimeType(loaded.contentType) ?? "application/octet-stream",
      contentDisposition: "attachment",
      content: loaded.buffer.toString("base64"),
    });
  }
  return attachments;
}
