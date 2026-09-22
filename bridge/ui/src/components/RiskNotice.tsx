import { DOCS_URL } from '../config.ts';
import { formatAmount, formatBps } from '../lib/amounts.ts';
import type { BridgeConfig } from '../lib/bridge.ts';

/**
 * The honest risk statement. Always rendered, never behind a toggle, never
 * collapsed after the first visit: a validator-secured bridge is a trust
 * assumption the user is taking on every single time, so it is restated every
 * single time. The numbers are read from the live contract, not written here.
 */
export function RiskNotice({
  srcConfig,
  srcChainName,
  cap,
  capSymbol,
  capDecimals,
}: {
  srcConfig: BridgeConfig | null;
  srcChainName: string;
  cap: { maxPerTransfer: bigint; dailyCap: bigint } | null;
  capSymbol: string | null;
  capDecimals: number;
}) {
  const quorum = srcConfig ? `${srcConfig.threshold}-of-${srcConfig.validatorCount}` : 'M-of-N';
  return (
    <section className="risk" aria-labelledby="risk-heading">
      <h2 id="risk-heading">Read this before you bridge</h2>
      <p>
        This is a <strong>validator-secured</strong> bridge, not a trustless one. Your funds are locked (or burned) on
        the source chain, a set of independent validators attests to that, and the destination bridge releases (or
        mints) against their signatures.
      </p>
      <ul>
        <li>
          <strong>{quorum} validators</strong> must sign before anything is released on the far side. One compromised
          validator can do nothing on its own; a compromised <em>quorum</em> could sign transfers that never happened.
        </li>
        <li>
          <strong>Caps bound that risk.</strong>{' '}
          {cap && capSymbol ? (
            <>
              On {srcChainName}, {capSymbol} is limited to {formatAmount(cap.maxPerTransfer, capDecimals)} per transfer
              and {formatAmount(cap.dailyCap, capDecimals)} per rolling 24&nbsp;hours, in each direction.
            </>
          ) : (
            <>Every asset has a per-transfer cap and a rolling 24-hour volume cap, enforced in both directions.</>
          )}{' '}
          Raising a cap takes a 48-hour timelock; lowering one, or pausing, is immediate.
        </li>
        <li>
          <strong>The fee is taken at origin</strong>
          {srcConfig ? <> — currently {formatBps(srcConfig.feeBps)} of the amount you send</> : null}, so a round trip
          pays twice, once per leg.
        </li>
        <li>
          <strong>Delivery is not instant and not guaranteed by this page.</strong> Once the source transaction
          confirms, delivery depends on validators and a relayer. This app tracks the destination bridge directly and
          will tell you exactly where a transfer is stuck.
        </li>
        <li>
          <strong>Send only to an address you control on the destination chain.</strong> A bridge transfer cannot be
          reversed, recalled or refunded — no one, including the operators, can undo a delivered transfer.
        </li>
      </ul>
      <p className="risk-foot">
        Full security model, validator set and timelock rules:{' '}
        <a href={DOCS_URL} target="_blank" rel="noreferrer noopener">
          bridge documentation ↗
        </a>
      </p>
    </section>
  );
}
