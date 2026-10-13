import type { AgentMail } from "agentmail";
import { describe, expect, it, vi } from "vitest";

// OpenClaw 2026.10.5-beta.2 no longer exports markdownToText from this SDK subpath.
vi.mock("openclaw/plugin-sdk/web-content-extractor", async (importOriginal) => {
  const { htmlToMarkdown } =
    await importOriginal<typeof import("openclaw/plugin-sdk/web-content-extractor")>();
  return { htmlToMarkdown };
});

import { resolveAgentMailMessageText } from "./inbound.js";

describe("AgentMail HTML with the current OpenClaw SDK exports", () => {
  it.each(["extractedHtml", "html"] as const)("converts %s without markdownToText", (field) => {
    const message = {
      [field]: '<h2>Next steps</h2><ul><li>Read <a href="https://example.com/guide">the guide</a></li></ul>',
    } as AgentMail.Message;

    expect(resolveAgentMailMessageText(message)).toBe(
      "## Next steps\n\n- Read [the guide](https://example.com/guide)",
    );
  });

  it("prefers extracted HTML over quoted plain-text history", () => {
    expect(
      resolveAgentMailMessageText({
        extractedHtml: "<p>New reply</p>",
        text: "New reply\n\nOld quoted history",
        html: "<p>Old HTML history</p>",
      } as AgentMail.Message),
    ).toBe("New reply");
  });

  it("falls back to plain text when extracted HTML has no visible content", () => {
    expect(
      resolveAgentMailMessageText({
        extractedHtml: "<script>hidden()</script>",
        text: "Plain-text reply",
      } as AgentMail.Message),
    ).toBe("Plain-text reply");
  });

  it("falls back to the subject when HTML has no visible content", () => {
    expect(
      resolveAgentMailMessageText({
        html: "<script>hidden()</script>",
        subject: " Subject-only request ",
      } as AgentMail.Message),
    ).toBe("Subject-only request");
  });
});
