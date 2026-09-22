// Solves Moltbook's "AI verification challenge" math word problems, per skill.md:
// an obfuscated (scattered symbols, alternating caps, broken words) lobster/physics
// word problem with two numbers and one operation. We try an LLM first (if
// configured — this is exactly the kind of task an LLM is good at and the
// obfuscation is meant to defeat non-language spam bots, not us), then fall back
// to a deterministic heuristic parser.

// These are scattered INSIDE words by the generator (e.g. "tW]eNn-Tyy" for
// "twenty") specifically to defeat naive parsers — delete them outright
// rather than replacing with a space, or "twenty" turns into three
// unrecognizable fragments. Real word boundaries are the original spaces in
// the text, which this leaves alone.
const OBFUSCATION_CHARS = /[\]\[\^~{}|/-]/g;

const ONES = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19,
};
const TENS = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70,
  eighty: 80, ninety: 90,
};
const SCALES = { hundred: 100, thousand: 1000 };

// "Shattered words" (skill.md) don't just scatter symbols — they also double
// letters inside a word (observed: "tW]eNn-Tyy" decodes to "twenntyy", not
// "twenty"). Comparing everything in "collapsed" space (runs of the same
// letter squashed to one) makes that harmless without a fragile blind
// collapse of the input alone, which would corrupt legitimately
// double-lettered words like "three" or "seventeen".
function collapseRuns(s) {
  return s.replace(/(.)\1+/g, "$1");
}
function buildCollapsedIndex(dict) {
  const idx = {};
  for (const [word, value] of Object.entries(dict)) idx[collapseRuns(word)] = value;
  return idx;
}
const ONES_COLLAPSED = buildCollapsedIndex(ONES);
const TENS_COLLAPSED = buildCollapsedIndex(TENS);
const SCALES_COLLAPSED = buildCollapsedIndex(SCALES);

/** Looks up a token against a dictionary, exact first then collapsed-run space. */
function lookupWord(token, dict, collapsedDict) {
  if (token in dict) return dict[token];
  const c = collapsedDict[collapseRuns(token)];
  return c === undefined ? null : c;
}

const ADD_WORDS = new Set([
  "plus", "add", "adds", "added", "gain", "gains", "gained", "increase",
  "increases", "increased", "more", "picks", "picked", "up", "and", "combined",
  "together", "total", "sum",
]);
const SUB_WORDS = new Set([
  "minus", "subtract", "subtracts", "subtracted", "less", "fewer", "slow", "difference", "subtracting", "remaining", "left",
  "slows", "slowed", "drop", "drops", "dropped", "lose", "loses", "lost",
  "decrease", "decreases", "decreased", "shed", "sheds", "behind",
]);
const MUL_WORDS = new Set(["times", "multiplied", "multiply", "multiplies", "doubled", "tripled", "product", "multiplying"]);
const DIV_WORDS = new Set(["divided", "divide", "divides", "split", "splits", "shared", "share", "among", "between", "each", "quotient", "dividing"]);

function stripObfuscation(text) {
  return text
    // Operator symbols are sometimes literal ("fourteen * three"); turn them into
    // words BEFORE the symbol strip so they survive as operator tokens. A dash
    // is also an obfuscation char, so only a spaced " - " counts as minus.
    .replace(/\s\*\s/g, " times ")
    .replace(/\s\+\s/g, " plus ")
    .replace(/\s-\s/g, " minus ")
    .replace(/\s\/\s/g, " divided by ")
    .replace(/\s[x×]\s/g, " times ")
    .replace(OBFUSCATION_CHARS, "") // delete scattered symbols — see comment above
    .toLowerCase()
    .replace(/[^a-z0-9.\s]/g, " ") // remaining punctuation (commas, "?", ":") -> space, at real word boundaries
    .replace(/\s+/g, " ")
    .trim();
}

function splitCompound(token) {
  for (const [tens, tv] of Object.entries(TENS)) {
    const tc = collapseRuns(tens);
    const ct = collapseRuns(token);
    if (ct.startsWith(tc) && ct.length > tc.length) {
      const rest = ct.slice(tc.length);
      for (const [ones, ov] of Object.entries(ONES)) {
        if (ov < 10 && collapseRuns(ones) === rest) return tv + ov;
      }
    }
  }
  return null;
}

// Parses a run of number words (e.g. "twenty five", "one hundred and three")
// starting at index i in tokens. Returns { value, nextIndex } or null.
function parseNumberWords(tokens, i) {
  let value = 0;
  let current = 0;
  let matched = false;
  let j = i;
  while (j < tokens.length) {
    const t = tokens[j];
    if (t === "and" && matched) {
      j++;
      continue;
    }
    const onesVal = lookupWord(t, ONES, ONES_COLLAPSED);
    const tensVal = lookupWord(t, TENS, TENS_COLLAPSED);
    const scaleVal = lookupWord(t, SCALES, SCALES_COLLAPSED);
    // "twenty-five" loses its hyphen to the obfuscation strip → "twentyfive".
    if (onesVal === null && tensVal === null && scaleVal === null) {
      const compound = splitCompound(t);
      if (compound !== null) {
        current += compound;
        matched = true;
        j++;
        continue;
      }
    }
    if (onesVal !== null) {
      current += onesVal;
      matched = true;
      j++;
    } else if (tensVal !== null) {
      current += tensVal;
      matched = true;
      j++;
    } else if (scaleVal !== null) {
      current = (current || 1) * scaleVal;
      matched = true;
      j++;
      if (scaleVal === 1000) {
        value += current;
        current = 0;
      }
    } else {
      break;
    }
  }
  if (!matched) return null;
  value += current;
  return { value, nextIndex: j };
}

// Extracts all numbers (digit or spelled-out) in reading order, each tagged
// with the token index right after it (so we can look at surrounding words
// for the operator).
function extractNumbers(tokens) {
  const found = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (/^\d+(\.\d+)?$/.test(t)) {
      found.push({ value: Number.parseFloat(t), start: i, end: i + 1 });
      continue;
    }
    const parsed = parseNumberWords(tokens, i);
    if (parsed) {
      found.push({ value: parsed.value, start: i, end: parsed.nextIndex });
      i = parsed.nextIndex - 1;
    }
  }
  return found;
}

function detectOperator(tokens, betweenStart, betweenEnd) {
  const words = tokens.slice(betweenStart, betweenEnd);
  for (const w of words) {
    if (MUL_WORDS.has(w)) return "*";
  }
  for (const w of words) {
    if (DIV_WORDS.has(w)) return "/";
  }
  for (const w of words) {
    if (SUB_WORDS.has(w)) return "-";
  }
  for (const w of words) {
    if (ADD_WORDS.has(w)) return "+";
  }
  return null;
}

const KNOWN = new Set([
  ...Object.keys(ONES), ...Object.keys(TENS), ...Object.keys(SCALES),
  ...ADD_WORDS, ...SUB_WORDS, ...MUL_WORDS, ...DIV_WORDS,
].map(collapseRuns));

function isKnown(t) {
  return KNOWN.has(collapseRuns(t)) || splitCompound(t) !== null;
}

// The generator also splits words with spaces ("tWeN tY ThReE" → "twen ty
// three"). Re-join runs of up to three unknown fragments when the join is a
// known number/operator word.
function rejoinFragments(tokens) {
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (isKnown(t) || /^\d/.test(t)) { out.push(t); continue; }
    let merged = null;
    for (let k = 1; k <= 2 && i + k < tokens.length; k++) {
      const cand = tokens.slice(i, i + k + 1).join("");
      if (isKnown(cand)) { merged = { cand, k }; }
    }
    if (merged) { out.push(merged.cand); i += merged.k; } else out.push(t);
  }
  return out;
}

/** Deterministic fallback parser. Returns a number or null if it can't be solved. */
export function heuristicSolve(challengeText) {
  const clean = stripObfuscation(challengeText);
  const tokens = rejoinFragments(clean.split(" ").filter(Boolean));
  const numbers = extractNumbers(tokens);
  if (numbers.length < 2) return null;
  // Challenges are two-number, one-operation, but counts sneak in ("two lobsters
  // have sixteen claws shared among four"). Prefer the pair that straddles the
  // operator word; otherwise the first two.
  let a = numbers[0];
  let b = numbers[1];
  if (numbers.length > 2) {
    let opIdx = -1;
    for (let i = 0; i < tokens.length; i++) {
      const w = tokens[i];
      if (MUL_WORDS.has(w) || DIV_WORDS.has(w) || SUB_WORDS.has(w) || (ADD_WORDS.has(w) && w !== "and")) { opIdx = i; break; }
    }
    if (opIdx >= 0) {
      const before = numbers.filter((n) => n.end <= opIdx);
      const after = numbers.filter((n) => n.start > opIdx);
      if (before.length && after.length) { a = before[before.length - 1]; b = after[0]; }
      else { a = numbers[numbers.length - 2]; b = numbers[numbers.length - 1]; }
    } else {
      a = numbers[numbers.length - 2];
      b = numbers[numbers.length - 1];
    }
  }
  // Whole-text operator detection with priority MUL > DIV > SUB > ADD: weak
  // words ("each", "and") appear in almost every sentence, strong ones don't.
  let op = detectOperator(tokens, 0, tokens.length);
  // No operator word → no answer. A wrong /verify submission counts toward the
  // 10-failure auto-suspension; letting the challenge expire does not appear to
  // (observed 2026-09-22: 11 expired challenges, account still active).
  if (!op) return null;
  let result;
  switch (op) {
    case "+": result = a.value + b.value; break;
    case "-": result = a.value - b.value; break;
    case "*": result = a.value * b.value; break;
    case "/": result = b.value !== 0 ? a.value / b.value : null; break;
    default: result = null;
  }
  if (result === null || !Number.isFinite(result)) return null;
  return Math.round(result * 100) / 100;
}

/** LLM-assisted solve. Returns a number or null. `llmComplete` is (system, user) => Promise<string>. */
export async function llmSolve(challengeText, llmComplete) {
  const system =
    "You solve short obfuscated math word problems (scattered symbols, alternating caps, " +
    "broken words, a lobster/physics theme). Read through the noise, find the two numbers and " +
    "the one operation (+, -, *, /), compute the result. Reply with ONLY the numeric answer, " +
    "formatted with exactly 2 decimal places (e.g. 15.00 or -3.50). No words, no explanation.";
  const user = challengeText;
  const raw = await llmComplete(system, user);
  const match = String(raw).match(/-?\d+(\.\d+)?/);
  if (!match) return null;
  return Math.round(Number.parseFloat(match[0]) * 100) / 100;
}

/** Formats a number as the API expects: string with exactly 2 decimals. */
export function formatAnswer(n) {
  return n.toFixed(2);
}
