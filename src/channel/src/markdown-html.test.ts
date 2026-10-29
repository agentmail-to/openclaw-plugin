import { describe, expect, it } from "vitest";

import { renderEmailHtml } from "./markdown-html.js";

describe("renderEmailHtml", () => {
  it("renders headings, emphasis and lists", () => {
    const html = renderEmailHtml("# Title\n\nHello **Dan** and *Sam*:\n\n- one\n- two\n");
    expect(html).toContain(">Title</h2>");
    expect(html).toContain("<strong>Dan</strong>");
    expect(html).toContain("<em>Sam</em>");
    expect(html).toContain("<ul");
    expect(html).toContain(">one</li>");
    expect(html).toContain(">two</li>");
  });

  it("keeps the text column left aligned", () => {
    const html = renderEmailHtml("Hello");
    expect(html).toContain('role="presentation"');
    expect(html).toContain("text-align:left");
    // Gmail honours max-width plus auto margins and centres the body; the shell must not use them.
    expect(html).not.toContain("margin:0 auto");
  });

  it("escapes HTML and does not execute raw markup", () => {
    const html = renderEmailHtml('5 < 6 & "quoted" <script>alert(1)</script>');
    expect(html).toContain("5 &lt; 6 &amp; &quot;quoted&quot;");
    expect(html).not.toContain("<script>");
  });

  it("autolinks bare URLs and leaves sentence punctuation outside the anchor", () => {
    const html = renderEmailHtml("See https://example.com/report.");
    expect(html).toContain('href="https://example.com/report"');
    expect(html).toContain("</a>.");
    expect(html).not.toContain('href="https://example.com/report."');
  });

  it("renders explicit markdown links and inline code", () => {
    const html = renderEmailHtml("Read [the report](https://example.com/r) and run `npm test`");
    expect(html).toContain('<a href="https://example.com/r"');
    expect(html).toContain(">the report</a>");
    expect(html).toContain("<code");
    expect(html).toContain("npm test");
  });

  it("renders pipe tables", () => {
    const html = renderEmailHtml("| Roll | CVA |\n|---|---|\n| 1234 | 450000 |\n");
    expect(html).toContain("<thead>");
    expect(html).toContain("<th");
    expect(html).toContain(">Roll</th>");
    expect(html).toContain(">450000</td>");
  });

  it("escapes fenced code and leaves its contents unformatted", () => {
    const html = renderEmailHtml("```js\nconst x = 1 < 2 && 'a';\n```\n");
    expect(html).toContain("<pre");
    expect(html).toContain("const x = 1 &lt; 2 &amp;&amp; 'a';");
    expect(html).not.toContain("<strong>");
  });

  it("preserves line breaks inside paragraphs", () => {
    const html = renderEmailHtml("line one\nline two");
    expect(html).toContain("line one<br />line two");
  });

  it("supports an optional left-anchored max width", () => {
    const html = renderEmailHtml("Hello", { maxWidth: "720px" });
    expect(html).toContain("max-width:720px");
    expect(html).toContain("margin-left:0");
    expect(html).not.toContain("margin:0 auto");
  });
});
