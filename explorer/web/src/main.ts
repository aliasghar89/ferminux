/* Boot: styles, motion tier, shared listeners, chrome, the head store, the name book, then the router.
   One CSS file ships (tokens → ported components → explorer classes → home stage). */
import "./styles/tokens.css";
import "./styles/components.css";
import "./styles/explorer.css";
import "./styles/stage.css";
import { initMotion } from "./motion";
import { initCopy } from "./ui/copy";
import { initHighlight } from "./ui/hash";
import { initKv } from "./ui/kv";
import { initTicker } from "./ui/time";
import { initChrome } from "./chrome";
import { startHead } from "./head";
import { startBook } from "./book";
import { refreshSignerNumbers } from "./signer";
import { initValidatorsNav } from "./validators/nav";
import { startRouter } from "./router";

initMotion();
initCopy();
initHighlight();
initKv();
initTicker();
initChrome();
initValidatorsNav();
startHead();
startBook();
startRouter();

const idle = (fn: () => void) => ("requestIdleCallback" in window ? requestIdleCallback(fn, { timeout: 4000 }) : setTimeout(fn, 1500));
idle(() => void refreshSignerNumbers());
