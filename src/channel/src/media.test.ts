import { MediaFetchError } from "openclaw/plugin-sdk/media-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AgentMailMediaPolicyError,
  loadAgentMailInboundAttachments,
  loadAgentMailOutboundAttachments,
} from "./media.js";

const loadWebMediaRaw = vi.hoisted(() => vi.fn());
const saveMediaBuffer = vi.hoisted(() => vi.fn());
const loadOutboundMediaFromUrl = vi.hoisted(() => vi.fn());
const rm = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("openclaw/plugin-sdk/web-media", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/web-media")>()),
  loadWebMediaRaw,
}));
vi.mock("openclaw/plugin-sdk/media-store", () => ({ saveMediaBuffer }));
vi.mock("openclaw/plugin-sdk/outbound-media", () => ({ loadOutboundMediaFromUrl }));
vi.mock("node:fs/promises", () => ({ rm }));

beforeEach(() => {
  loadWebMediaRaw.mockReset();
  saveMediaBuffer.mockReset();
  loadOutboundMediaFromUrl.mockReset();
  rm.mockClear();
});

describe("AgentMail inbound attachments", () => {
  it("downloads all accepted parts before persisting any", async () => {
    loadWebMediaRaw.mockReset();
    saveMediaBuffer.mockReset();
    loadWebMediaRaw
      .mockResolvedValueOnce({ buffer: Buffer.from("one"), contentType: "text/plain" })
      .mockRejectedValueOnce(new Error("signed URL expired"));
    const getAttachment = vi
      .fn()
      .mockResolvedValueOnce({
        attachmentId: "a1",
        size: 3,
        filename: "one.txt",
        downloadUrl: "https://download.example/a1",
        expiresAt: new Date(),
      })
      .mockResolvedValueOnce({
        attachmentId: "a2",
        size: 3,
        filename: "two.txt",
        downloadUrl: "https://download.example/a2",
        expiresAt: new Date(),
      });

    await expect(
      loadAgentMailInboundAttachments({
        client: { inboxes: { messages: { getAttachment } } } as never,
        inboxId: "inbox_1",
        messageId: "message_1",
        attachments: [
          { attachmentId: "a1", filename: "one.txt", size: 3 },
          { attachmentId: "a2", filename: "two.txt", size: 3 },
        ],
        maxBytes: 100,
      }),
    ).rejects.toThrow("signed URL expired");
    expect(getAttachment).toHaveBeenNthCalledWith(1, "inbox_1", "message_1", "a1");
    expect(saveMediaBuffer).not.toHaveBeenCalled();
  });

  it("skips only explicit inline parts and keeps downloadable CID attachments", async () => {
    loadWebMediaRaw.mockResolvedValueOnce({
      buffer: Buffer.from("download"),
      contentType: "application/octet-stream",
    });
    saveMediaBuffer.mockResolvedValueOnce({
      path: "/tmp/download.bin",
      contentType: "application/octet-stream",
    });
    const getAttachment = vi.fn(async () => ({
      downloadUrl: "https://download.example/cid",
      filename: "download.bin",
    }));
    await expect(
      loadAgentMailInboundAttachments({
        client: { inboxes: { messages: { getAttachment } } } as never,
        inboxId: "inbox_1",
        messageId: "message_1",
        attachments: [
          { attachmentId: "inline", size: 1, contentDisposition: "inline" },
          {
            attachmentId: "cid",
            size: 8,
            contentId: "download@cid",
            contentDisposition: "attachment",
          },
        ],
        maxBytes: 100,
      }),
    ).resolves.toEqual({
      paths: ["/tmp/download.bin"],
      types: ["application/octet-stream"],
    });
    expect(getAttachment).toHaveBeenCalledOnce();
    expect(getAttachment).toHaveBeenCalledWith("inbox_1", "message_1", "cid");
  });

  it("classifies static attachment size violations as terminal policy rejections", async () => {
    await expect(
      loadAgentMailInboundAttachments({
        client: {} as never,
        inboxId: "inbox_1",
        messageId: "message_1",
        attachments: [{ attachmentId: "oversized", size: 101 }],
        maxBytes: 100,
      }),
    ).rejects.toBeInstanceOf(AgentMailMediaPolicyError);
  });

  it("maps bounded-download overflow to a terminal policy rejection", async () => {
    loadWebMediaRaw.mockRejectedValueOnce(
      new MediaFetchError("max_bytes", "payload exceeds the configured bound"),
    );
    await expect(
      loadAgentMailInboundAttachments({
        client: {
          inboxes: {
            messages: {
              getAttachment: vi.fn(async () => ({
                downloadUrl: "https://download.example/understated",
              })),
            },
          },
        } as never,
        inboxId: "inbox_1",
        messageId: "message_1",
        attachments: [{ attachmentId: "understated", size: 1 }],
        maxBytes: 100,
      }),
    ).rejects.toBeInstanceOf(AgentMailMediaPolicyError);
  });

  it("rolls back already-saved parts when a later save fails", async () => {
    loadWebMediaRaw
      .mockResolvedValueOnce({ buffer: Buffer.from("a"), contentType: "text/plain" })
      .mockResolvedValueOnce({ buffer: Buffer.from("b"), contentType: "text/plain" });
    saveMediaBuffer
      .mockResolvedValueOnce({ path: "/tmp/a.txt", contentType: "text/plain" })
      .mockRejectedValueOnce(new Error("disk full"));
    const getAttachment = vi.fn(async (_inbox: string, _msg: string, id: string) => ({
      downloadUrl: `https://download.example/${id}`,
    }));
    await expect(
      loadAgentMailInboundAttachments({
        client: { inboxes: { messages: { getAttachment } } } as never,
        inboxId: "inbox_1",
        messageId: "message_1",
        attachments: [
          { attachmentId: "a", size: 1 },
          { attachmentId: "b", size: 1 },
        ],
        maxBytes: 100,
      }),
    ).rejects.toThrow("disk full");
    // The one file that persisted before the failure is removed so the durable retry starts clean.
    expect(rm).toHaveBeenCalledWith("/tmp/a.txt", { force: true });
  });

  it("normalizes inbound and outbound content types", async () => {
    loadWebMediaRaw.mockResolvedValueOnce({
      buffer: Buffer.from("proof"),
      contentType: "text/plain; charset=utf-8",
    });
    saveMediaBuffer.mockResolvedValueOnce({ path: "/tmp/proof.txt", contentType: "text/plain" });
    const getAttachment = vi.fn(async () => ({
      downloadUrl: "https://download.example/proof",
      contentType: "TEXT/PLAIN; charset=utf-8",
      filename: "proof.txt",
    }));
    await loadAgentMailInboundAttachments({
      client: { inboxes: { messages: { getAttachment } } } as never,
      inboxId: "inbox_1",
      messageId: "message_1",
      attachments: [{ attachmentId: "proof", size: 5 }],
      maxBytes: 100,
    });
    expect(saveMediaBuffer).toHaveBeenCalledWith(
      Buffer.from("proof"),
      "text/plain",
      "inbound",
      100,
      "proof.txt",
    );

    loadOutboundMediaFromUrl.mockResolvedValueOnce({
      buffer: Buffer.from("proof"),
      contentType: "TEXT/PLAIN; charset=utf-8",
      fileName: "proof.txt",
    });
    await expect(
      loadAgentMailOutboundAttachments({ mediaUrls: ["file:///proof.txt"], maxBytes: 100 }),
    ).resolves.toEqual([
      expect.objectContaining({ contentType: "text/plain", filename: "proof.txt" }),
    ]);
  });

  it("loads every outbound attachment before returning an atomic request", async () => {
    loadOutboundMediaFromUrl
      .mockResolvedValueOnce({
        buffer: Buffer.from("one"),
        contentType: "text/plain",
        fileName: "one.txt",
      })
      .mockRejectedValueOnce(new Error("second attachment failed"));

    await expect(
      loadAgentMailOutboundAttachments({
        mediaUrls: ["file:///one.txt", "file:///two.txt"],
        maxBytes: 100,
      }),
    ).rejects.toThrow("second attachment failed");
  });

  it("passes the shrinking aggregate budget to each outbound fetch", async () => {
    loadOutboundMediaFromUrl
      .mockResolvedValueOnce({
        buffer: Buffer.alloc(80),
        contentType: "image/png",
        fileName: "one.png",
      })
      .mockResolvedValueOnce({
        buffer: Buffer.alloc(30),
        contentType: "image/png",
        fileName: "two.png",
      });

    await expect(
      loadAgentMailOutboundAttachments({
        mediaUrls: ["file:///one.png", "file:///two.png"],
        maxBytes: 100,
      }),
    ).rejects.toThrow("aggregate media limit");
    // First fetch gets the full budget; the second only the remaining 20 bytes.
    expect(loadOutboundMediaFromUrl).toHaveBeenNthCalledWith(
      1,
      "file:///one.png",
      expect.objectContaining({ maxBytes: 100 }),
    );
    expect(loadOutboundMediaFromUrl).toHaveBeenNthCalledWith(
      2,
      "file:///two.png",
      expect.objectContaining({ maxBytes: 20 }),
    );
  });

  it("classifies bounded outbound loader failures as policy errors", async () => {
    loadOutboundMediaFromUrl.mockRejectedValueOnce(
      new MediaFetchError("max_bytes", "remote payload exceeds the configured bound"),
    );

    await expect(
      loadAgentMailOutboundAttachments({
        mediaUrls: ["file:///oversized.bin"],
        maxBytes: 100,
      }),
    ).rejects.toBeInstanceOf(AgentMailMediaPolicyError);
  });
});
