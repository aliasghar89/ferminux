/* A tiny safe templating layer. `html` escapes every interpolation unless it is itself Html (from `html`,
   `raw` or a component), so values from the index, the RPC or the gateway can never inject markup.
     root.replaceChildren(); mount(root, html`<h1>${name}</h1>${chip}`)
   Arrays are joined; null / undefined / false / true render nothing (so `${cond && html`…`}` works). */
import { esc } from "../format";

export class Html {
  constructor(readonly s: string) {}
  toString() { return this.s; }
}
export type Val = Html | string | number | bigint | boolean | null | undefined | Val[];

const part = (v: Val): string =>
  v === null || v === undefined || v === false || v === true ? ""
    : v instanceof Html ? v.s
      : Array.isArray(v) ? v.map(part).join("")
        : esc(String(v));

export function html(strings: TemplateStringsArray, ...vals: Val[]): Html {
  let s = strings[0];
  for (let i = 0; i < vals.length; i++) s += part(vals[i]) + strings[i + 1];
  return new Html(s);
}
/** Trusted markup (our own constants only; never data). */
export const raw = (s: string) => new Html(s);
export const join = (items: Val[], sep: Val = "") => new Html(items.map(part).filter(Boolean).join(part(sep)));

/** Replace an element's content. */
export function mount(el: Element | null, h: Html | string) {
  if (el) el.innerHTML = h instanceof Html ? h.s : esc(h);
}
/** Parse one element from markup (feed rows, popovers). */
export function el<T extends Element = HTMLElement>(h: Html): T {
  const t = document.createElement("template");
  t.innerHTML = h.s.trim();
  return t.content.firstElementChild as T;
}
export const $ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector<T>(sel);
export const $$ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => Array.from(root.querySelectorAll<T>(sel));

/** `—` with a reason in its title: a field we couldn't read (§0.2). */
export const dash = (why = "Not reported by the index") => html`<span class="dash" title="${why}">—</span>`;
