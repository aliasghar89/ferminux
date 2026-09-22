import { extractText, type Handler } from "./util.js";

/** Deterministic handler used for tests / smoke-checks. */
export const echoHandler: Handler = async (input) => {
  const text = extractText(input);
  return { ok: true, output: `echo: ${text}` };
};
