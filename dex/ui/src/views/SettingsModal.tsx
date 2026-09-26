import { useState } from 'react';
import { MAX_DEADLINE_MINUTES, MAX_HOPS, MAX_SLIPPAGE_BPS, SLIPPAGE_PRESETS_BPS, SLIPPAGE_WARN_BPS } from '../config.ts';
import { Modal, Notice } from '../components/ui.tsx';
import { formatBpsPercent, percentToBps } from '../lib/amounts.ts';
import type { TradeSettings } from '../state/useSettings.ts';

/**
 * Slippage tolerance, deadline, route length and approval size. Each is a
 * protection, and each says what it protects against; the settings that make
 * a trade easier to sandwich or an approval larger than the trade are called
 * out where they are chosen.
 */
export function SettingsModal({
  value,
  onChange,
  onClose,
  showRouting = true,
}: {
  value: TradeSettings;
  onChange: (next: TradeSettings) => void;
  onClose: () => void;
  showRouting?: boolean;
}) {
  const isPreset = (SLIPPAGE_PRESETS_BPS as readonly number[]).includes(value.slippageBps);
  const [customText, setCustomText] = useState(isPreset ? '' : (value.slippageBps / 100).toString());
  const [customError, setCustomError] = useState<string | null>(null);
  const [deadlineText, setDeadlineText] = useState(String(value.deadlineMinutes));

  return (
    <Modal title="Trade settings" onClose={onClose}>
      <section className="setting">
        <div className="setting-head">
          <label className="setting-label" htmlFor="set-slippage">
            Slippage tolerance
          </label>
          <span className="mono muted">{formatBpsPercent(value.slippageBps)}</span>
        </div>
        <div className="setting-row">
          <div className="seg" role="group" aria-label="Slippage presets">
            {SLIPPAGE_PRESETS_BPS.map((bps) => (
              <button
                key={bps}
                type="button"
                aria-pressed={value.slippageBps === bps && customText === ''}
                onClick={() => {
                  setCustomText('');
                  setCustomError(null);
                  onChange({ ...value, slippageBps: bps });
                }}
              >
                {formatBpsPercent(bps)}
              </button>
            ))}
          </div>
          <span className="input-suffix-wrap">
            <input
              id="set-slippage"
              className="input input-compact mono"
              inputMode="decimal"
              placeholder="Custom"
              value={customText}
              onChange={(e) => {
                const text = e.target.value;
                setCustomText(text);
                if (text.trim() === '') {
                  setCustomError(null);
                  return;
                }
                const bps = percentToBps(text);
                if (bps === null || bps < 0 || bps > MAX_SLIPPAGE_BPS) {
                  setCustomError(`Enter a percentage from 0 to ${MAX_SLIPPAGE_BPS / 100}.`);
                  return;
                }
                setCustomError(null);
                onChange({ ...value, slippageBps: bps });
              }}
            />
            <span className="input-suffix">%</span>
          </span>
        </div>
        <p className="field-hint">The worst fill the router may settle. Past it, the swap reverts instead.</p>
        {customError && <p className="field-error">{customError}</p>}
        {!customError && value.slippageBps === 0 && (
          <p className="field-error">Zero tolerance means the fill must match to the wei. Almost every swap will revert.</p>
        )}
        {!customError && value.slippageBps >= SLIPPAGE_WARN_BPS && (
          <p className="field-error">
            {formatBpsPercent(value.slippageBps)} lets the router settle that much worse than quoted, which is exactly
            what a sandwich attack takes.
          </p>
        )}
      </section>

      <section className="setting">
        <div className="setting-head">
          <label className="setting-label" htmlFor="set-deadline">
            Transaction deadline
          </label>
        </div>
        <div className="setting-row">
          <span className="input-suffix-wrap">
            <input
              id="set-deadline"
              className="input input-compact mono"
              inputMode="numeric"
              value={deadlineText}
              onChange={(e) => {
                const text = e.target.value.replace(/[^\d]/g, '');
                setDeadlineText(text);
                const minutes = Number(text);
                if (text !== '' && minutes >= 1) onChange({ ...value, deadlineMinutes: Math.min(minutes, MAX_DEADLINE_MINUTES) });
              }}
              onBlur={() => setDeadlineText(String(value.deadlineMinutes))}
            />
            <span className="input-suffix">minutes</span>
          </span>
        </div>
        <p className="field-hint">After this long the router refuses the transaction rather than fill it at a price that has moved on.</p>
      </section>

      {showRouting && (
        <section className="setting">
          <div className="setting-head">
            <span className="setting-label" id="set-hops">
              Routing
            </span>
          </div>
          <div className="seg" role="group" aria-labelledby="set-hops">
            {Array.from({ length: MAX_HOPS }, (_, i) => i + 1).map((h) => (
              <button key={h} type="button" aria-pressed={value.maxHops === h} onClick={() => onChange({ ...value, maxHops: h })}>
                {h === 1 ? 'Direct only' : `Up to ${h} pools`}
              </button>
            ))}
          </div>
          <p className="field-hint">
            The router searches every path across every pool up to this length and takes the one that pays the most.
            Each extra pool costs another 0.30% fee.
          </p>
        </section>
      )}

      <section className="setting">
        <div className="setting-head">
          <span className="setting-label" id="set-approval">
            Token approvals
          </span>
        </div>
        <div className="seg" role="group" aria-labelledby="set-approval">
          <button type="button" aria-pressed={!value.unlimitedApprovals} onClick={() => onChange({ ...value, unlimitedApprovals: false })}>
            Exact amount
          </button>
          <button type="button" aria-pressed={value.unlimitedApprovals} onClick={() => onChange({ ...value, unlimitedApprovals: true })} data-testid="approve-unlimited">
            Unlimited
          </button>
        </div>
        {value.unlimitedApprovals ? (
          <Notice kind="warn">
            An unlimited approval lets the router contract move every unit of that token your wallet will ever hold,
            without asking again. It saves one transaction per trade. Revoke it from your wallet if you stop using
            this DEX.
          </Notice>
        ) : (
          <p className="field-hint">Recommended. Each approval covers exactly one trade, so the router can never move more than you signed for.</p>
        )}
      </section>
    </Modal>
  );
}
