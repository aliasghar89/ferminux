// URIs written on chain (ArbiterPool.submitEvidence takes any string) reach the page as hrefs. Only http(s) and
// root-relative paths may become links; javascript: and the like render as text.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { safeHref, uriHtml } from "../src/format.ts";

test("safeHref: http(s) and site paths pass, script and data URLs do not", () => {
  assert.equal(safeHref("https://example.com/a?b=1&c=2"), "https://example.com/a?b=1&amp;c=2");
  assert.equal(safeHref("/kb/?slug=x"), "/kb/?slug=x");
  for (const bad of ["javascript:alert(1)", " JavaScript:alert(1)", "data:text/html,<script>alert(1)</script>", "//evil.example", "fmx://payload/0xab", 'https://x" onmouseover="alert(1)'])
    assert.equal(safeHref(bad), "#", bad);
});

test("uriHtml: a link for https, escaped text for anything else", () => {
  assert.equal(uriHtml("https://example.com/e", 'class="mono"'), '<a class="mono" href="https://example.com/e" rel="noopener nofollow">https://example.com/e</a>');
  const js = uriHtml("javascript:alert(document.cookie)");
  assert.doesNotMatch(js, /href=/);
  assert.match(js, /^<span [^>]*>javascript:alert\(document\.cookie\)<\/span>$/);
  assert.doesNotMatch(uriHtml('"><img src=x onerror=alert(1)>'), /<img/);
  assert.match(uriHtml("fmx://payload/0xab"), /^<span [^>]*>fmx:\/\/payload\/0xab<\/span>$/);
});

test("the disputes page renders evidence URIs through uriHtml, never a raw href", () => {
  const src = readFileSync(new URL("../src/pages/disputes.ts", import.meta.url), "utf8");
  assert.match(src, /uriHtml\(e\.uri\b/);
  assert.doesNotMatch(src, /href="\$\{esc\(e\.uri\)\}"/);
});
