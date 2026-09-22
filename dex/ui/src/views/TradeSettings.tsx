import { useState } from 'react';
import {
  DEFAULT_DEADLINE_MINUTES,
  DEFAULT_SLIPPAGE_BPS,
  MAX_DEADLINE_MINUTES,
  MAX_SLIPPAGE_BPS,
  SLIPPAGE_PRESETS_BPS,
  SLIPPAGE_WARN_BPS,
} from '../config.ts';
import { formatBpsPercent, percentToBps } from '../lib/amounts.ts';

export interface TradeSettingsValue {
  slippageBps: number;
  deadlineMinutes: number;
}

export const DEFAULT_TRADE_SETTINGS: TradeSettingsValue = {
  slippageBps: DEFAULT_SLIPPAGE_BPS,
  deadlineMinutes: DEFAULT_DEADLINE_MINUTES,
};

/**
 * Slippage tolerance and deadline.
 *
 * Both are protections, and both are explained rather than just offered:
 * slippage is the worst fill the router may settle, the deadline is how long
 * a signed transaction may sit in the mempool before it is refused. Setting
 * either badly is how people get sandwiched, so the extremes are called out.
 */
export function TradeSettings({
  value,
  onChange,
  idPrefix,
}: {
  value: TradeSettingsValue;
  onChange: (next: TradeSettingsValue) => void;
  idPrefix: string;
}) {
  const isPreset = (SLIPPAGE_PRESETS_BPS as readonly number[]).includes(value.slippageBps);
  const [customText, setCustomText] = useState(isPreset ? '' : (value.slippageBps / 100).toString());
  const [customError, setCustomError] = useState<string | null>(null);

  const setSlippage = (bps: number) => onChange({ ...value, slippageBps: bps });

  return (
    <div className="settings-box">
      <div className="settings-group">
        <label className="settings-label" htmlFor={`${idPrefix}-slippage-custom`}>
          Slippage tolerance
        </label>
        <div className="seg-row">
          {SLIPPAGE_PRESETS_BPS.map((bps) => (
            <button
              key={bps}
              type="button"
              className={'seg' + (value.slippageBps === bps && customText === '' ? ' is-on' : '')}
              onClick={() => {
                setCustomText('');
                setCustomError(null);
                setSlippage(bps);
              }}
            >
              {formatBpsPercent(bps)}
            </button>
          ))}
          <span className="seg-custom">
            <input
              id={`${idPrefix}-slippage-custom`}
              className="input input-sm num"
              inputMode="decimal"
              placeholder="Custom"
              value={customText}
              onChange={(e) => {
                const text = e.target.value;
                setCustomText(text);
                if (text.trim() === '') {
                  setCustomError(null);
                  setSlippage(DEFAULT_SLIPPAGE_BPS);
                  return;
                }
                const bps = percentToBps(text);
                if (bps === null || bps < 0 || bps > MAX_SLIPPAGE_BPS) {
                  setCustomError(`Enter a percentage between 0 and ${MAX_SLIPPAGE_BPS / 100}.`);
                  return;
                }
                setCustomError(null);
                setSlippage(bps);
              }}
            />
            <span className="seg-suffix">%</span>
          </span>
        </div>
        {customError && <p className="field-error">{customError}</p>}
        {!customError && value.slippageBps === 0 && (
          <p className="field-hint">
            Zero tolerance means the fill must be exact to the wei. Almost every swap will revert.
          </p>
        )}
        {!customError && value.slippageBps >= SLIPPAGE_WARN_BPS && (
          <p className="field-error">
            {formatBpsPercent(value.slippageBps)} is a wide bound — you are authorising the router to settle up to that
            much worse than quoted, which is what a sandwich attack takes.
          </p>
        )}
      </div>

      <div className="settings-group">
        <label className="settings-label" htmlFor={`${idPrefix}-deadline`}>
          Transaction deadline
        </label>
        <div className="seg-custom">
          <input
            id={`${idPrefix}-deadline`}
            className="input input-sm num"
            inputMode="numeric"
            value={String(value.deadlineMinutes)}
            onChange={(e) => {
              const minutes = Number(e.target.value.replace(/[^\d]/g, ''));
              if (!Number.isFinite(minutes)) return;
              onChange({ ...value, deadlineMinutes: Math.min(Math.max(minutes, 1), MAX_DEADLINE_MINUTES) });
            }}
          />
          <span className="seg-suffix">minutes</span>
        </div>
        <p className="field-hint">
          After this long the router refuses the transaction rather than execute it at a price that has moved on.
        </p>
      </div>
    </div>
  );
}
