// src/md.ts renders forum posts, messages and the knowledge base. Bold and italic must never reach inside a URL:
// "_x_" or "*x*" in a link used to put <em> into the href, breaking the link (and the attribute it sits in).
import test from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown } from "../src/md.ts";

const hrefs = (html) => [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);

test("a [text](url) link keeps its URL intact when it contains _x_ or *x*", () => {
  const html = renderMarkdown("see [the docs](https://example.com/a_b_c/*d*/e_f_?q=_x_) now");
  assert.deepEqual(hrefs(html), ["https://example.com/a_b_c/*d*/e_f_?q=_x_"]);
  assert.doesNotMatch(html, /<em>|<strong>/);
  assert.match(html, />the docs<\/a>/);
});

test("a bare URL keeps both its href and its visible text intact", () => {
  const url = "https://example.com/path_with_underscores_/and/**stars**/x";
  const html = renderMarkdown(`go to ${url} please`);
  assert.deepEqual(hrefs(html), [url]);
  assert.ok(html.includes(`>${url}</a>`), html);
  assert.doesNotMatch(html, /<em>|<strong>/);
});

test("formatting outside links still works, including around one", () => {
  assert.equal(renderMarkdown("**bold** and _it_ and *also*"), "<p><strong>bold</strong> and <em>it</em> and <em>also</em></p>");
  const html = renderMarkdown("_read [this](https://x.example/a_b_c)_ and **see https://y.example/a_b_c_ now**");
  assert.deepEqual(hrefs(html), ["https://x.example/a_b_c", "https://y.example/a_b_c_"]);
  assert.match(html, /^<p><em>read <a href="https:\/\/x\.example\/a_b_c"[^>]*>this<\/a><\/em> and <strong>see <a [^>]*>https:\/\/y\.example\/a_b_c_<\/a> now<\/strong><\/p>$/);
  assert.match(renderMarkdown("[kb](/kb/?slug=a_b_c)"), /<a href="\/kb\/\?slug=a_b_c">kb<\/a>/);
});

test("inline code and unsafe URLs are unchanged; a stray placeholder byte in the text is dropped", () => {
  assert.equal(renderMarkdown("`a_b_c` *x*"), "<p><code>a_b_c</code> <em>x</em></p>");
  assert.doesNotMatch(renderMarkdown("[x](javascript:alert(1))"), /href=/);
  assert.equal(renderMarkdown("a\u00000\u0000b"), "<p>a0b</p>");
});
