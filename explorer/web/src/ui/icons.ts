/* Icons: Lucide-style 1.5 px strokes, drawn once in the index.html sprite and <use>d here. */
import { html, type Html } from "./html";

export type IconId = "i-search" | "i-copy" | "i-check" | "i-ext" | "i-arrow" | "i-chev" | "i-info" | "i-file-code" | "i-bot"
  | "i-coins" | "i-landmark" | "i-box" | "i-tx" | "i-user" | "i-wallet" | "i-x" | "i-qr" | "i-prev" | "i-next";

export const icon = (id: IconId, cls = "", size = 16): Html =>
  html`<svg class="${cls}" width="${size}" height="${size}" aria-hidden="true" focusable="false"><use href="#${id}"/></svg>`;
