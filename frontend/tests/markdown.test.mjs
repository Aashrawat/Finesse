import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

let server;
let Markdown;
before(async () => {
  server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    server: { middlewareMode: true, watch: null },
    appType: "custom",
    logLevel: "error",
  });
  Markdown = (await server.ssrLoadModule("/src/components/research/Markdown.tsx")).default;
});
after(async () => { await server?.close(); });

const render = (text) => renderToStaticMarkup(createElement(Markdown, { text }));

test("Einstein's equation renders inside the bold summary with an accessible superscript", () => {
  const html = render(String.raw`A simple summary: **Albert Einstein changed modern physics with relativity and \(E = mc^2\).**`);
  assert.match(html, /<strong[^>]*>Albert Einstein[\s\S]*data-testid="math-inline"[\s\S]*<\/strong>/);
  assert.match(html, /<msup><mi>c<\/mi><mn>2<\/mn><\/msup>/);
  assert.doesNotMatch(html, /\\\(|\\\)/);
});

test("the pasted summary's double-escaped delimiters render without stray backslashes", () => {
  const html = render(String.raw`A simple summary: **Albert Einstein was the scientist who changed modern physics with relativity and the famous equation \\(E = mc^2\\).**`);
  assert.match(html, /data-testid="math-inline"/);
  assert.match(html, /<msup><mi>c<\/mi><mn>2<\/mn><\/msup>/);
  assert.doesNotMatch(html, /\\/);
});

for (const [name, text, display] of [
  ["parentheses", String.raw`\(E = mc^2\)`, false],
  ["single dollars", "$E = mc^2$", false],
  ["brackets", String.raw`\[E = mc^2\]`, true],
  ["double-escaped brackets", String.raw`\\[E = mc^2\\]`, true],
  ["double dollars", "$$E = mc^2$$", true],
]) {
  test(`supports ${name} math delimiters`, () => {
    const html = render(text);
    assert.match(html, new RegExp(`data-testid="math-${display ? "display" : "inline"}"`));
    assert.match(html, /<math[^>]*xmlns="http:\/\/www.w3.org\/1998\/Math\/MathML"/);
    assert.doesNotMatch(html, /class="katex-error"/);
  });
}

test("multiline aligned equations preserve blank lines and TeX structure", () => {
  const html = render(String.raw`\[
\begin{aligned}
E &= mc^2 \\

F &= ma
\end{aligned}
\]
Explanation after the equation.`);
  assert.match(html, /data-testid="math-display"/);
  assert.match(html, /<mtable/);
  assert.match(html, /Explanation after the equation/);
  assert.doesNotMatch(html, /class="katex-error"/);
});

test("inline and fenced code keep literal LaTeX", () => {
  const expression = String.raw`\(E = mc^2\)`;
  const html = render("Inline `" + expression + "`.\n\n```latex\n" + expression + "\n```");
  assert.match(html, /data-testid="code-block"/);
  assert.match(html, /\\\(E = mc\^2\\\)/);
  assert.doesNotMatch(html, /data-testid="math-/);
});

test("prices stay plain text alongside dollar-delimited math", () => {
  const html = render(String.raw`Prices are $5 and $10. An escaped price is \$20. The variable is $x^2$.`);
  assert.match(html, /Prices are \$5 and \$10/);
  assert.equal(html.match(/data-testid="math-inline"/g)?.length, 1);
});

test("tables, source chips, headings and links retain their formatting with math", () => {
  const html = render(String.raw`## Energy \(E\)

| Quantity | Formula |
| --- | --- |
| Energy | \(mc^2\) |

[Reference](https://example.org/physics) [source: physics.pdf, page 3]`);
  assert.match(html, /<h2[^>]*>Energy[\s\S]*data-testid="math-inline"/);
  assert.match(html, /<table/);
  assert.match(html, /data-testid="citation-chip"/);
  assert.match(html, /href="https:\/\/example.org\/physics"/);
  assert.equal(html.match(/data-testid="math-inline"/g)?.length, 2);
});

test("every streaming prefix renders safely before the equation is complete", () => {
  const text = String.raw`\[
\frac{1}{2} + \sqrt{x}
\]`;
  for (let i = 1; i <= text.length; i++) assert.doesNotThrow(() => render(text.slice(0, i)));
  assert.match(render(text.slice(0, -1)), /\\\[/);
  assert.match(render(text), /data-testid="math-display"/);
});

test("malformed LaTeX leaves the rest of the answer readable", () => {
  const html = render(String.raw`Before \(\frac{1}\) after.`);
  assert.match(html, /class="katex-error"/);
  assert.match(html, /Before/);
  assert.match(html, /after\./);
});

test("model HTML and untrusted TeX cannot create executable markup or links", () => {
  const html = render(String.raw`<img src=x onerror=alert(1)> \(\href{javascript:alert(1)}{click}\) \(\htmlClass{injected}{x}\)`);
  assert.match(html, /&lt;img/);
  assert.doesNotMatch(html, /<(?:img|script)\b|href="javascript:|class="injected"/);
});
