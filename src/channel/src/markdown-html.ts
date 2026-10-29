/**
 * Minimal, dependency-free Markdown -> HTML renderer for AgentMail outbound replies.
 *
 * Agent channel replies are authored as Markdown. AgentMail's reply API accepts an optional
 * `html` body alongside `text`; without it every reply is delivered as text/plain and clients
 * (Gmail included) show the raw emphasis markers, lists and tables. Rendering the same Markdown
 * to HTML and sending both gives clients a multipart/alternative message while keeping the
 * plain-text alternative for text-only clients and archives.
 *
 * Scope is deliberately small: headings, emphasis, inline code, fenced code, links (explicit and
 * bare URLs), bullet/numbered lists, pipe tables, blockquotes, horizontal rules and paragraphs.
 */

export interface EmailHtmlOptions {
  /** Anchor colour used for links. */
  linkColor?: string;
  /** Optional left-anchored max width (for example "720px"). Empty means full width. */
  maxWidth?: string;
}

const DEFAULT_LINK_COLOR = "#0b62c4";
const SLOT = "\u0000";

const CODE_INLINE_STYLE =
  "font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:0.9em;" +
  "background:#f2f4f6;border-radius:4px;padding:1px 4px;";

const FONT_STACK =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function sanitizeStyleValue(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const cleaned = value.replace(/["<>\\]/g, "").trim();
  return cleaned || undefined;
}

function isTableSeparator(line: string): boolean {
  return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(line);
}

function splitTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function isBlockStart(line: string): boolean {
  return (
    /^\s{0,3}(#{1,6})\s+/.test(line) ||
    /^\s*(```+|~~~+)/.test(line) ||
    /^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line) ||
    /^\s*>/.test(line) ||
    /^\s*([-*+]|\d+[.)])\s+/.test(line)
  );
}

export function renderEmailHtml(markdown: string, options: EmailHtmlOptions = {}): string {
  const linkColor = sanitizeStyleValue(options.linkColor) ?? DEFAULT_LINK_COLOR;
  const maxWidth = sanitizeStyleValue(options.maxWidth);

  const renderInline = (raw: string): string => {
    const saved: string[] = [];
    const stash = (html: string): string => {
      saved.push(html);
      return `${SLOT}${saved.length - 1}${SLOT}`;
    };

    let text = escapeHtml(raw);
    // Code spans and links are stashed first so later inline rules cannot rewrite their contents.
    text = text.replace(/`([^`]+)`/g, (_match, code: string) =>
      stash(`<code style="${CODE_INLINE_STYLE}">${code}</code>`),
    );
    text = text.replace(/!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g, (_match, alt: string, url: string) =>
      stash(`<a href="${url}" style="color:${linkColor};">${alt || url}</a>`),
    );
    text = text.replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      (_match, label: string, url: string) =>
        stash(`<a href="${url}" style="color:${linkColor};">${label}</a>`),
    );
    text = text.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_match, prefix: string, url: string) => {
      // Keep sentence punctuation outside the anchor instead of inside the href.
      const trailing = url.match(/^(.*?)([.,;:!?]+)$/);
      const clean = trailing ? trailing[1] : url;
      const tail = trailing ? trailing[2] : "";
      return `${prefix}${stash(`<a href="${clean}" style="color:${linkColor};">${clean}</a>`)}${tail}`;
    });
    text = text.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
    text = text.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, "$1<em>$2</em>");
    text = text.replace(/~~([^~\n]+)~~/g, "<del>$1</del>");
    return text.replace(/\u0000(\d+)\u0000/g, (_match, index: string) => saved[Number(index)] ?? "");
  };

  const renderTable = (rows: string[][]): string => {
    const [head = [], ...body] = rows;
    const header = head
      .map(
        (cell) =>
          `<th style="border:1px solid #dfe3e8;padding:6px 9px;text-align:left;vertical-align:top;` +
          `background:#f3f5f7;font-weight:600;">${renderInline(cell)}</th>`,
      )
      .join("");
    const trs = body
      .map(
        (row) =>
          `<tr>${row
            .map(
              (cell) =>
                `<td style="border:1px solid #dfe3e8;padding:6px 9px;text-align:left;vertical-align:top;">` +
                `${renderInline(cell)}</td>`,
            )
            .join("")}</tr>`,
      )
      .join("");
    return (
      '<table style="border-collapse:collapse;width:100%;margin:0 0 14px;font-size:14px;">' +
      `<thead><tr>${header}</tr></thead><tbody>${trs}</tbody></table>`
    );
  };

  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const blocks: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = line.match(/^\s*(```+|~~~+)/);
    if (fence) {
      const marker = fence[1]?.[0] ?? "`";
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !new RegExp(`^\\s*${marker}{3,}\\s*$`).test(lines[index] ?? "")) {
        body.push(lines[index] ?? "");
        index += 1;
      }
      index += 1;
      blocks.push(
        '<pre style="background:#f6f8fa;border:1px solid #e3e6ea;border-radius:6px;padding:10px 12px;' +
          'margin:0 0 14px;overflow:auto;font-size:13px;line-height:1.45;">' +
          `<code style="font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;">` +
          `${escapeHtml(body.join("\n"))}</code></pre>`,
      );
      continue;
    }

    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (heading) {
      const level = Math.min((heading[1]?.length ?? 1) + 1, 4);
      const size = level === 2 ? 20 : level === 3 ? 17 : 15;
      blocks.push(
        `<h${level} style="margin:20px 0 8px;font-size:${size}px;line-height:1.3;font-weight:600;` +
          `color:#111827;">${renderInline(heading[2] ?? "")}</h${level}>`,
      );
      index += 1;
      continue;
    }

    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      blocks.push('<hr style="border:0;border-top:1px solid #e3e6ea;margin:18px 0;" />');
      index += 1;
      continue;
    }

    if (line.includes("|") && isTableSeparator(lines[index + 1] ?? "")) {
      const rows: string[][] = [splitTableRow(line)];
      index += 2;
      while (index < lines.length && (lines[index] ?? "").includes("|") && (lines[index] ?? "").trim()) {
        rows.push(splitTableRow(lines[index] ?? ""));
        index += 1;
      }
      blocks.push(renderTable(rows));
      continue;
    }

    if (/^\s*>/.test(line)) {
      const quoted: string[] = [];
      while (index < lines.length && /^\s*>/.test(lines[index] ?? "")) {
        quoted.push((lines[index] ?? "").replace(/^\s*>\s?/, ""));
        index += 1;
      }
      blocks.push(
        '<blockquote style="margin:0 0 14px;padding:2px 0 2px 12px;border-left:3px solid #d4d4d4;' +
          `color:#4b5563;">${renderInline(quoted.join("\n")).replace(/\n/g, "<br />")}</blockquote>`,
      );
      continue;
    }

    const listMatch = line.match(/^\s*([-*+]|\d+[.)])\s+/);
    if (listMatch) {
      const ordered = /^\d/.test(listMatch[1] ?? "");
      const items: string[] = [];
      while (index < lines.length && (lines[index] ?? "").trim()) {
        const item = (lines[index] ?? "").match(/^\s*([-*+]|\d+[.)])\s+(.*)$/);
        if (item) {
          items.push(item[2] ?? "");
          index += 1;
          continue;
        }
        if (isBlockStart(lines[index] ?? "")) {
          break;
        }
        // Continuation line of the previous item.
        items[items.length - 1] = `${items[items.length - 1] ?? ""} ${(lines[index] ?? "").trim()}`;
        index += 1;
      }
      const tag = ordered ? "ol" : "ul";
      const body = items.map((item) => `<li style="margin:4px 0;">${renderInline(item)}</li>`).join("");
      blocks.push(`<${tag} style="margin:0 0 14px;padding-left:22px;">${body}</${tag}>`);
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length && (lines[index] ?? "").trim() && !isBlockStart(lines[index] ?? "")) {
      if (
        (lines[index] ?? "").includes("|") &&
        isTableSeparator(lines[index + 1] ?? "")
      ) {
        break;
      }
      paragraph.push(lines[index] ?? "");
      index += 1;
    }
    if (paragraph.length === 0) {
      // Defensive: never loop forever on an unparsed construct.
      paragraph.push(line);
      index += 1;
    }
    blocks.push(
      `<p style="margin:0 0 14px;">${renderInline(paragraph.join("\n")).replace(/\n/g, "<br />")}</p>`,
    );
  }

  const body = blocks.length > 0 ? blocks.join("\n") : '<p style="margin:0;"></p>';
  const column = maxWidth
    ? `<div style="max-width:${maxWidth};margin-left:0;margin-right:auto;text-align:left;">${body}</div>`
    : body;

  // A presentation table (not a max-width div with auto margins) keeps the column anchored to the
  // left edge: Gmail honours `max-width` + `margin:0 auto` and centres the whole body otherwise.
  return [
    "<!doctype html>",
    '<html><head><meta charset="utf-8" />' +
      '<meta name="viewport" content="width=device-width, initial-scale=1" /></head>',
    '<body style="margin:0;padding:0;background:#ffffff;text-align:left;">',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" ' +
      'style="width:100%;border-collapse:collapse;background:#ffffff;">',
    '<tr><td align="left" valign="top" style="padding:16px 20px 20px;text-align:left;' +
      `font-family:${FONT_STACK};font-size:15px;line-height:1.6;color:#1f2328;` +
      'word-break:break-word;">',
    column,
    "</td></tr></table>",
    "</body></html>",
  ].join("\n");
}
