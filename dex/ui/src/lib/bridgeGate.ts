// Whether the Bridge panel may offer a send right now, and if not, why.
//
// quoteTransfer answers "is this amount inside the caps". It does not answer
// "will the validators sign it". A deposit the validators will not sign is
// locked on the source chain with nothing arriving on the other side, and the
// user has no way to tell from the form. So the panel asks two more things:
//
//   1. the contracts: is the bridge, or this token's rail, paused on-chain?
//   2. the relayer: is there a fresh report, and does it say the validators
//      are signing for the SOURCE chain?
//
// Unlike the bridge app, a missing or stale report CLOSES the gate. The bridge
// app shows its full transfer tracker and status page next to the form; this
// panel is a shortcut inside a swap app, and "we could not check" is not a
// reason to let someone lock funds from it.
//
// Pure, so tests/bridgegate.test.mjs drives it with the real assessLiveness.
import type { LivenessVerdict } from '@bridge/lib/liveness.ts';

export interface BridgeGateInput {
  /** Source chain as the user knows it ("Ferminux", "BSC"). */
  srcName: string;
  /** BridgeConfig.paused on the source bridge; null while not yet read. */
  bridgePaused: boolean | null;
  /** RailState.paused for the token being sent; null while not yet read. */
  tokenPaused: boolean | null;
  /** A report was fetched, parsed and is fresh enough to act on. */
  reportUsable: boolean;
  /** Why there is no usable report (network error, stale, bad JSON). */
  reportError: string | null;
  /** assessLiveness() for the source chain; null when there is no usable report. */
  srcVerdict: LivenessVerdict | null;
}

export interface BridgeGate {
  /** True only when a send may be offered. */
  open: boolean;
  /** One sentence for the user when closed; null when open. */
  reason: string | null;
  /** Non-blocking context when open (e.g. blocks are slow). */
  note: string | null;
}

export function bridgeGate(i: BridgeGateInput): BridgeGate {
  const closed = (reason: string): BridgeGate => ({ open: false, reason, note: null });

  if (i.bridgePaused === true) {
    return closed(`The bridge contract on ${i.srcName} is paused by its operators. Nothing can be sent until it is unpaused.`);
  }
  if (i.tokenPaused === true) {
    return closed(`This route is paused on the ${i.srcName} bridge. Nothing can be sent on it until it is unpaused.`);
  }
  if (!i.reportUsable || i.srcVerdict === null) {
    const why = i.reportError ? ` (${i.reportError})` : '';
    return closed(
      `Could not confirm that the bridge validators are signing${why}. Sending is disabled here so funds are not locked on a route that may not deliver.`,
    );
  }
  if (i.srcVerdict.state === 'unknown') {
    return closed(
      `The validators' report has no signing verdict for ${i.srcName}, so this panel cannot confirm a transfer from it would be signed. Sending is disabled here.`,
    );
  }
  if (i.srcVerdict.paused) {
    return closed(i.srcVerdict.message || `Transfers from ${i.srcName} are paused by the validators.`);
  }
  return { open: true, reason: null, note: i.srcVerdict.state === 'slow' ? i.srcVerdict.message : null };
}
