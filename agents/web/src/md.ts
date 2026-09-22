// Tiny safe-subset Markdown renderer for forum posts and messages. No raw HTML ever passes
// through: everything is escaped first, then a handful of constructs are re-introduced.
// Supported: paragraphs, **bold**, *italic* / _italic_, `inline code`, ``` fenced code ```,
// [text](https://…) links (http/https only, rel="nofollow noopener"), bare https:// URLs,
// "- " / "* " bullet lists, "> " quotes, and "# " headings (rendered as bold lines).
import { esc } from "./format";

// http(s) URLs, plus root-relative site paths ("/kb/?slug=x", never "//host") so pages can link each other.
const SAFE_URL = /^(https?:\/\/[^\s<>"'()]+|\/(?!\/)[^\s<>"'()]*)$/i;

function inline(text: string): string {
  let s = esc(text);
  // inline code first so nothing inside it is transformed
  const codes: string[] = [];
  s = s.replace(/`([^`\n]+)`/g, (_, c) => { codes.push(`<code>${c}</code>`); return `\u0000${codes.length - 1}\u0000`; });
  // [text](url)
  s = s.replace(/\[([^\]\n]{1,200})\]\(([^)\s]+)\)/g, (m, t, u) => SAFE_URL.test(u) ? (u.startsWith("/") ? `<a href="${u}">${t}</a>` : `<a href="${u}" rel="nofollow noopener" target="_blank">${t}</a>`) : m);
  // bare urls (not already inside an href)
  s = s.replace(/(^|[\s(])((?:https?:\/\/)[^\s<>"']+[^\s<>"'.,;:!?)])/g, (_, pre, u) => `${pre}<a href="${u}" rel="nofollow noopener" target="_blank">${u}</a>`);
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^\w*])\*([^*\n]+)\*(?!\w)/g, "$1<em>$2</em>");
  s = s.replace(/(^|[^\w_])_([^_\n]+)_(?!\w)/g, "$1<em>$2</em>");
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[Number(i)]);
  return s;
}

export interface MdOptions {
  /** Render "## " / "### " as real <h2>/<h3> with slug ids (knowledge base). Default: bold lines (forum). */
  headings?: boolean;
}

/** URL-safe id for a heading, stable across renders (used by the KB table of contents). */
export function slugify(text: string): string {
  return String(text).toLowerCase().replace(/`/g, "").replace(/[^a-z0-9\u00c0-\uffff]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "section";
}

/** Headings (levels 2–3) of a Markdown source in document order, ids matching renderMarkdown({headings:true}). */
export function headings(src: string): { level: number; text: string; id: string }[] {
  const out: { level: number; text: string; id: string }[] = []; const seen = new Map<string, number>();
  let fence = false;
  for (const line of String(src ?? "").replace(/\r\n?/g, "\n").split("\n")) {
    if (/^```/.test(line)) { fence = !fence; continue; }
    if (fence) continue;
    const m = line.match(/^(#{1,6})\s+(.*)$/); if (!m) continue;
    const level = m[1].length;
    const text = m[2].replace(/[`*_]+/g, "").trim();
    let id = slugify(text); const n = seen.get(id) || 0; seen.set(id, n + 1); if (n) id = `${id}-${n + 1}`; // same dedup as the renderer
    if (level >= 2 && level <= 3) out.push({ level, text, id });
  }
  return out;
}

export function renderMarkdown(src: string, opts: MdOptions = {}): string {
  const lines = String(src ?? "").replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let para: string[] = []; let list: string[] | null = null; let listTag = "ul"; let quote: string[] = [];
  const ids = new Map<string, number>();
  const flushPara = () => { if (para.length) { out.push(`<p>${inline(para.join("\n")).replace(/\n/g, "<br>")}</p>`); para = []; } };
  const flushList = () => { if (list) { out.push(`<${listTag}>${list.map((l) => `<li>${inline(l)}</li>`).join("")}</${listTag}>`); list = null; } };
  const flushQuote = () => { if (quote.length) { out.push(`<blockquote>${inline(quote.join("\n")).replace(/\n/g, "<br>")}</blockquote>`); quote = []; } };
  const flushAll = () => { flushPara(); flushList(); flushQuote(); };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^```/.test(line)) {
      flushAll();
      const buf: string[] = []; i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      out.push(`<pre class="light">${esc(buf.join("\n"))}</pre>`);
      continue;
    }
    if (!line.trim()) { flushAll(); continue; }
    const li = line.match(/^\s*[-*]\s+(.*)$/);
    if (li) { flushPara(); flushQuote(); if (list && listTag !== "ul") flushList(); listTag = "ul"; (list ??= []).push(li[1]); continue; }
    const oli = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (oli) { flushPara(); flushQuote(); if (list && listTag !== "ol") flushList(); listTag = "ol"; (list ??= []).push(oli[1]); continue; }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) { flushAll(); out.push("<hr>"); continue; }
    if (opts.headings) {
      const th = line.match(/^(#{1,6})\s+(.*)$/);
      if (th) {
        flushAll();
        const level = Math.min(4, Math.max(2, th[1].length)); // h1 is the page title; deeper levels collapse to h4
        const text = th[2].replace(/[`*_]+/g, "").trim();
        let id = slugify(text); const n = ids.get(id) || 0; ids.set(id, n + 1); if (n) id = `${id}-${n + 1}`;
        out.push(`<h${level} id="${id}">${inline(th[2])}</h${level}>`);
        continue;
      }
    }
    const q = line.match(/^>\s?(.*)$/);
    if (q) { flushPara(); flushList(); quote.push(q[1]); continue; }
    const hd = line.match(/^#{1,6}\s+(.*)$/);
    if (hd) { flushAll(); out.push(`<p><strong>${inline(hd[1])}</strong></p>`); continue; }
    flushList(); flushQuote(); para.push(line);
  }
  flushAll();
  return out.join("");
}

/** One-line plain-text preview (for excerpts). */
export function plain(src: string, max = 160): string {
  const t = String(src ?? "").replace(/```[\s\S]*?```/g, " ").replace(/^\s*#{1,6}\s+/gm, "").replace(/^\s*>\s?/gm, "").replace(/[`*_\[\]]+/g, "").replace(/\(https?:\/\/[^)]+\)/g, "").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}
