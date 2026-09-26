/* A regex-light Solidity highlighter (§4.15): comments, strings, keywords and types, nothing else. The
   output is escaped markup for a <pre>; the line gutter is separate, so a multi-line comment never breaks it. */
import { esc } from "../../format";

const KW = "pragma|solidity|import|from|as|contract|interface|library|abstract|is|function|modifier|event|error|struct|enum|mapping|returns|return|if|else|for|while|do|break|continue|new|delete|emit|revert|require|assert|public|private|internal|external|view|pure|payable|constant|immutable|override|virtual|memory|storage|calldata|indexed|unchecked|using|try|catch|constructor|receive|fallback|this|super|true|false|type|assembly|let";
const TY = "address|bool|string|bytes\\d*|u?int\\d*|u?fixed\\d*x?\\d*";
const RE = new RegExp(`(//[^\\n]*|/\\*[\\s\\S]*?\\*/)|("(?:[^"\\\\\\n]|\\\\.)*"|'(?:[^'\\\\\\n]|\\\\.)*')|\\b(${KW})\\b|\\b(${TY})\\b|\\b(\\d[\\d_]*(?:\\.\\d+)?(?:e\\d+)?|0x[0-9a-fA-F]+)\\b`, "g");

export function highlight(src: string): string {
  let out = "", last = 0;
  for (const m of src.matchAll(RE)) {
    out += esc(src.slice(last, m.index));
    const [t, com, str, kw, ty, num] = m;
    const cls = com ? "c" : str ? "s" : kw ? "k" : ty ? "t" : num ? "n" : "";
    out += cls ? `<span class="${cls}">${esc(t)}</span>` : esc(t);
    last = (m.index ?? 0) + t.length;
  }
  return out + esc(src.slice(last));
}
