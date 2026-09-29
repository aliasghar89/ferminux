import { useMemo, useState } from "react";
import { parseUnits } from "ethers";
import { FACTORY_ADDRESS, explorerAddressUrl, explorerTxUrl } from "../config.ts";
import {
  factoryContract,
  formatFmx,
  isBurnAddress,
  launchToken,
  shortAddress,
} from "../lib/factory.ts";
import { ferminuxSigner, type WalletState } from "../lib/wallet.ts";
import { IconCheck, IconExternal } from "./icons.tsx";

interface Props {
  wallet: WalletState | null;
  wrongChain: boolean;
  fee: bigint | null;
  /** feeCollector() read live from the factory; null while unknown. */
  feeCollector: string | null;
  feeError: string | null;
  onRetryFee: () => void;
  onConnect: () => void;
  onFixNetwork: () => void;
  /** Offered before a wallet connects when the browser has one: wallet_addEthereumChain. */
  onAddNetwork: (() => void) | null;
  /** A wallet request (connect, switch, add) is in flight. */
  busy: boolean;
  onLaunched: () => void;
}

/** What a person can act on, from the wallet's or ethers' error. */
function describeLaunchError(e: unknown): string {
  const err = e as {
    code?: unknown;
    reason?: string | null;
    shortMessage?: string;
    info?: { error?: { code?: unknown } };
  } | null;
  if (err?.code === "ACTION_REJECTED" || err?.code === 4001 || err?.info?.error?.code === 4001)
    return "You rejected the launch in your wallet. Nothing was sent.";
  if (err?.code === "INSUFFICIENT_FUNDS")
    return "Your wallet does not hold enough FMX for the launch fee plus gas.";
  if (err?.reason) return `The factory refused the launch: ${err.reason}`;
  const msg = err?.shortMessage || (e instanceof Error ? e.message : String(e));
  return msg.length > 300 ? `${msg.slice(0, 300)}…` : msg;
}

interface LaunchResult {
  token: string;
  txHash: string;
  name: string;
  symbol: string;
}

export default function LaunchForm(props: Props) {
  const { wallet, wrongChain, fee, feeCollector, feeError } = props;

  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [decimals, setDecimals] = useState("18");
  const [initialSupply, setInitialSupply] = useState("");
  const [maxSupply, setMaxSupply] = useState("0");
  const [mintable, setMintable] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [result, setResult] = useState<LaunchResult | null>(null);

  // Mirror the contract's own require() checks so users never burn gas on a
  // predictable revert.
  const errors = useMemo(() => {
    const e: Record<string, string> = {};
    const nameLen = new TextEncoder().encode(name).length;
    const symLen = new TextEncoder().encode(symbol).length;
    if (name && (nameLen < 1 || nameLen > 64)) e.name = "1–64 bytes.";
    if (symbol && (symLen < 1 || symLen > 12)) e.symbol = "1–12 bytes.";
    const dec = Number(decimals);
    if (!Number.isInteger(dec) || dec < 0 || dec > 18)
      e.decimals = "Whole number between 0 and 18.";
    let init: bigint | null = null;
    let max: bigint | null = null;
    if (initialSupply !== "" && !e.decimals) {
      try {
        init = parseUnits(initialSupply, dec);
        if (init < 0n) throw new Error();
      } catch {
        e.initialSupply = "Not a valid amount.";
      }
    }
    if (maxSupply !== "" && !e.decimals) {
      try {
        max = parseUnits(maxSupply, dec);
        if (max < 0n) throw new Error();
      } catch {
        e.maxSupply = "Not a valid amount.";
      }
    }
    if (init !== null && init === 0n && !mintable)
      e.initialSupply = "Zero supply requires the mintable option.";
    if (init !== null && max !== null && max !== 0n && init > max)
      e.maxSupply = "Max supply is below the initial supply.";
    return e;
  }, [name, symbol, decimals, initialSupply, maxSupply, mintable]);

  const complete =
    name !== "" && symbol !== "" && decimals !== "" && initialSupply !== "" && maxSupply !== "";
  const valid = complete && Object.keys(errors).length === 0;
  const ready = valid && wallet !== null && !wrongChain && fee !== null && !submitting;

  async function submit() {
    if (!ready || !wallet || fee === null) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      // Asks the wallet for its chain right before signing: the fee must never
      // be sent on another network (see ferminuxSigner).
      const signer = await ferminuxSigner(wallet);
      const factory = factoryContract(FACTORY_ADDRESS, signer);
      const dec = Number(decimals);
      const { token, txHash } = await launchToken(
        factory,
        {
          name: name.trim(),
          symbol: symbol.trim(),
          decimals: dec,
          initialSupply: parseUnits(initialSupply, dec),
          maxSupply: parseUnits(maxSupply, dec),
          mintable,
        },
        fee,
      );
      setResult({ token, txHash, name: name.trim(), symbol: symbol.trim() });
      props.onLaunched();
    } catch (e: unknown) {
      setSubmitError(describeLaunchError(e));
    } finally {
      setSubmitting(false);
    }
  }

  if (result) {
    return (
      <section className="card" aria-labelledby="lp-done-title">
        <div className="card-pad">
          <div className="success-mark" aria-hidden="true">
            <IconCheck />
          </div>
          <h2 className="card-title" id="lp-done-title">
            {result.name} ({result.symbol}) is live on Ferminux
          </h2>
          <p className="card-sub">
            The token is recorded in the factory registry and carries the
            “Factory verified” badge.
          </p>
          <dl className="kv">
            <dt>Token address</dt>
            <dd className="mono">{result.token}</dd>
            <dt>Explorer</dt>
            <dd>
              <a className="ext" href={explorerAddressUrl(result.token)} target="_blank" rel="noreferrer">
                {explorerAddressUrl(result.token)} <IconExternal />
              </a>
            </dd>
            <dt>Transaction</dt>
            <dd>
              <a className="ext" href={explorerTxUrl(result.txHash)} target="_blank" rel="noreferrer">
                <span className="mono">{shortAddress(result.txHash)}</span> <IconExternal />
              </a>
            </dd>
          </dl>
          <div className="form-actions">
            <button
              className="btn btn-primary"
              onClick={() => {
                setResult(null);
                setName("");
                setSymbol("");
                setInitialSupply("");
                setMaxSupply("0");
                setDecimals("18");
                setMintable(false);
              }}
            >
              Launch another coin
            </button>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="card" aria-labelledby="lp-launch-title">
      <div className="card-head">
        <h2 className="card-title" id="lp-launch-title">
          Launch your coin
        </h2>
      </div>
      <div className="card-pad">
        <p className="card-sub">
          One transaction deploys a standard FRC-20 token through the official
          TokenFactory and lists it in the on-chain registry.
        </p>

        <div className="form-grid">
          <label className="field">
            <span className="field-label">Name</span>
            <input
              type="text"
              className={"input" + (errors.name ? " invalid" : "")}
              value={name}
              maxLength={64}
              placeholder="e.g. Caspian Credit"
              autoComplete="off"
              onChange={(e) => setName(e.target.value)}
            />
            {errors.name && <span className="field-error">{errors.name}</span>}
          </label>

          <label className="field">
            <span className="field-label">Symbol</span>
            <input
              type="text"
              className={"input input-mono" + (errors.symbol ? " invalid" : "")}
              value={symbol}
              maxLength={12}
              placeholder="e.g. CSP"
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              onChange={(e) => setSymbol(e.target.value.toUpperCase())}
            />
            {errors.symbol && <span className="field-error">{errors.symbol}</span>}
          </label>

          <label className="field">
            <span className="field-label">Decimals</span>
            <input
              type="number"
              className={"input input-mono" + (errors.decimals ? " invalid" : "")}
              min={0}
              max={18}
              step={1}
              value={decimals}
              onChange={(e) => setDecimals(e.target.value)}
            />
            <span className="field-hint">18 is standard.</span>
            {errors.decimals && <span className="field-error">{errors.decimals}</span>}
          </label>

          <label className="field">
            <span className="field-label">Initial supply</span>
            <input
              type="text"
              inputMode="decimal"
              className={"input input-mono" + (errors.initialSupply ? " invalid" : "")}
              value={initialSupply}
              placeholder="1000000"
              autoComplete="off"
              onChange={(e) => setInitialSupply(e.target.value.trim())}
            />
            <span className="field-hint">Minted to your address at launch.</span>
            {errors.initialSupply && <span className="field-error">{errors.initialSupply}</span>}
          </label>

          <label className="field">
            <span className="field-label">Max supply</span>
            <input
              type="text"
              inputMode="decimal"
              className={"input input-mono" + (errors.maxSupply ? " invalid" : "")}
              value={maxSupply}
              autoComplete="off"
              onChange={(e) => setMaxSupply(e.target.value.trim())}
            />
            <span className="field-hint">0 = uncapped (only relevant if mintable).</span>
            {errors.maxSupply && <span className="field-error">{errors.maxSupply}</span>}
          </label>

          <div className="field">
            <span className="field-label">Minting</span>
            <label className="check-row">
              <input type="checkbox" checked={mintable} onChange={(e) => setMintable(e.target.checked)} />
              <span>
                <span className="check-title">Mintable</span>
                <span className="check-hint">
                  You can mint more later (up to max supply). Leave off for a
                  fixed supply — buyers see a “Fixed supply” badge.
                </span>
              </span>
            </label>
          </div>
        </div>

        <div className="fee-row">
          <span className="fee-label">
            <span className="label">Launch fee</span>
            <span className="fee-src">Read live from the factory contract</span>
          </span>
          <span className="fee-value mono" data-testid="launch-fee">
            {fee !== null ? (
              formatFmx(fee)
            ) : feeError ? (
              <button className="btn btn-sm" onClick={props.onRetryFee}>
                Fee unavailable — retry
              </button>
            ) : (
              "…"
            )}
          </span>
        </div>
        {feeCollector && (
          <p className="fee-dest" data-testid="fee-destination">
            {isBurnAddress(feeCollector) ? (
              <>
                <strong>This fee is burned.</strong> The factory sends it to{" "}
                <a className="mono" href={explorerAddressUrl(feeCollector)} target="_blank" rel="noreferrer">
                  {shortAddress(feeCollector)}
                </a>
                , an address no one holds a key for, so it is gone for good and
                cannot be refunded.
              </>
            ) : (
              <>
                Paid to the factory&apos;s fee collector{" "}
                <a className="mono" href={explorerAddressUrl(feeCollector)} target="_blank" rel="noreferrer">
                  {shortAddress(feeCollector)}
                </a>
                .
              </>
            )}
          </p>
        )}

        {!wallet && (
          <div className="notice">
            Connect a wallet to launch: Ferminux Wallet works in this browser
            with nothing to install. Browsing the registry works without one.
            {props.onAddNetwork && (
              <>
                {" "}
                <button className="link-btn" onClick={props.onAddNetwork} disabled={props.busy}>
                  Add Ferminux Network to your browser wallet
                </button>
              </>
            )}
          </div>
        )}
        {wrongChain && (
          <div className="notice notice-warn">
            Your wallet is on the wrong network. Switch to Ferminux (chain 3961)
            to launch.
          </div>
        )}
        {submitError && (
          <div className="notice notice-warn" role="alert">
            {submitError}
          </div>
        )}

        <div className="form-actions">
          {!wallet ? (
            <button className="btn btn-primary btn-lg" onClick={props.onConnect} disabled={props.busy}>
              Connect wallet
            </button>
          ) : wrongChain ? (
            <button className="btn btn-primary btn-lg" onClick={props.onFixNetwork} disabled={props.busy}>
              Switch to Ferminux
            </button>
          ) : (
            <button className="btn btn-primary btn-lg" disabled={!ready} onClick={submit}>
              {submitting ? (
                <>
                  <span className="spinner" />
                  Waiting for confirmation…
                </>
              ) : fee !== null ? (
                `Launch — pay ${formatFmx(fee)}`
              ) : (
                "Launch"
              )}
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
