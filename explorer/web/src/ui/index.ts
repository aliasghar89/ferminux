/* Shared components. Pages import from here: `import { html, mount, addrChip, table, … } from "../ui";` */
export { html, raw, join, mount, el, $, $$, dash, Html, type Val } from "./html";
export { icon, type IconId } from "./icons";
export { copyBtn, toast } from "./copy";
export { addrChip, txChip, blockHashChip, blockLink, fullHash, signerLabel, type ChipOpts } from "./hash";
export { pill, tag, kindTag, txStatus, txDot, txPill, agentStatusPill, jobPill, prov, amt, amtExact, fee, gas, gasUsed, ago, when, methodChip, txKind, kindWord, type Prov, type Tone } from "./marks";
export { seal, seals, type SealOpts } from "./seal";
export { table, tableSkeleton, rowLink, sub, type Col, type TableOpts } from "./table";
export { tabsHtml, bindTabs, type TabDef, type TabsHandle } from "./tabs";
export { pagerHtml, bindPager, pageOf, PER_PAGE } from "./pager";
export { sk, skLine, kvSkeleton, statSkeleton, identSkeleton, slowWatch } from "./skeleton";
export { empty, note, errorBox, showError } from "./state";
export { kv, hintBtn, type Row, type Group } from "./kv";
export { omniboxHtml, bindOmnibox, TRY } from "./omnibox";
export { setFastTicker } from "./time";
export { txCols, txRowAttrs, hydrateMethods, type TxColOpts } from "./txcols";
export { xpanel, put, keyEl, whenVisible, limit, dayLabel } from "./kit";
export { transferCols, transferAmount, tokenCell, transferKind } from "./transfers";
