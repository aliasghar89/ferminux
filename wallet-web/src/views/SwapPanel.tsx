// Swap: trade any two tokens on the Ferminux Network through the Ferminux DEX,
// from the active account, without leaving the wallet (no WalletConnect, no
// browser, no dApp origin — the wallet builds every call itself).
//
// A swap is an ordinary transaction through the wallet's own pipeline
// (lib/tx.ts prepareTransaction → confirm screen → signAndBroadcast), on chain
// 3961 only. The route is chosen from the pools read just before Review; the
// amount shown and signed for is the router's own getAmountsOut; the router
// enforces the minimum received and the deadline. A token being sold for the
// first time is approved first — to the router only, for exactly this amount
// unless the user chose otherwise — as its own confirmed step. Everything the
// swap depends on (balances, allowance, the quote, the deadline) is read again
// right before signing, and a swap that would now fail is not signed.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChainState } from '../App.tsx';
import type { AccountsApi } from '../state/useAccounts.ts';
import type { PortfolioApi } from '../state/usePortfolio.ts';
import { useSwapPools } from '../state/useSwapPools.ts';
import { usePayinAssets, usePayinTracking, type PayinRecordsApi } from '../state/usePayin.ts';
import { payinCoin, payinCoinKey, quoteFromRecord, recordsFrom, type PayinQuote } from '../lib/payin.ts';
import type { LocalTx, LocalTxStatus } from '../lib/localActivity.ts';
import { BuyPanel } from './BuyPanel.tsx';
import { PayinTracker, PurchasesList, useNowS } from './PayinParts.tsx';
import { loadSwapSettings, saveSwapSettings } from '../state/storage.ts';
import { CHAIN_ID } from '../config.ts';
import { FERMINUX_CHAIN } from '../lib/chains.ts';
import { httpBatchTransport } from '../lib/balances.ts';
import { balanceFor, type AssetRef } from '../lib/portfolio.ts';
import { checkAmount, formatAmountExact } from '../lib/validate.ts';
import { getFeeInfo, prepareTransaction, signAndBroadcast, type PreparedTx } from '../lib/tx.ts';
import {
  FEE_BPS,
  SWAP_CHAIN_ID,
  allowanceShortfall,
  bestRoute,
  buildApproveCall,
  buildSwapCall,
  buildWrapCall,
  deadlineFrom,
  formatImpactPpm,
  formatPercentBps,
  formatRate,
  impactLevel,
  midOutput,
  minimumReceived,
  offeredTokens,
  poolAddress,
  pooledTokens,
  priceImpactPpm,
  readSwapPreflight,
  receivedFromLogs,
  swapKind,
  swapProblem,
  tokenKey,
  type Route,
  type SwapPreflight,
  type SwapProblem,
  type SwapSettings,
} from '../lib/swap.ts';
import { Spinner } from '../components/ui.tsx';
import { ChainBadge } from '../components/ChainBadge.tsx';
import { IconCheck, IconChevronDown, IconClose, IconReceive, IconRefresh, IconSettings, IconSwap } from '../components/icons.tsx';
import { HashLine, shortenError } from './SendPanel.tsx';
import {
  ApproveConfirm,
  Glyph,
  ImpactText,
  PoolsList,
  RouteLine,
  SwapConfirm,
  SwapSettingsSheet,
  TokenPicker,
  fmt,
  routeSymbols,
  type SwapPlanView,
} from './SwapParts.tsx';

/** A quote from pools read this recently is shown as it is; an older one is read again when typing pauses. */
const POOL_FRESH_MS = 3_000;

/** Gas the Max button keeps back for an FMX swap (a three-pool swap uses about 250,000). */
export const SWAP_GAS_RESERVE = 400_000n;

type Step = 'checking' | 'signing' | null;

type Phase =
  | { kind: 'edit' }
  | { kind: 'checking'; label: string }
  | { kind: 'problem'; problem: SwapProblem | { code: 'error'; message: string }; hash?: string }
  | { kind: 'approve'; plan: SwapPlanView; prepared: PreparedTx; amount: bigint; step: Step }
  | { kind: 'approving'; plan: SwapPlanView; hash: string }
  | { kind: 'confirm'; plan: SwapPlanView; prepared: PreparedTx; pf: SwapPreflight; note: string | null; twoStep: boolean; step: Step }
  | { kind: 'pending'; plan: SwapPlanView; hash: string }
  | { kind: 'done'; plan: SwapPlanView; hash: string; received: bigint | null }
  | { kind: 'failed'; message: string; hash?: string };

/** The quote the form shows as the user types, priced locally from the pools last read. */
type Quote =
  | { kind: 'empty' }
  | { kind: 'invalid'; error: string }
  | { kind: 'loading' }
  | { kind: 'no-route' }
  | { kind: 'wrap'; amountIn: bigint }
  | { kind: 'swap'; amountIn: bigint; route: Route; minOut: bigint; impactPpm: bigint };

export function SwapPanel({
  api,
  chain,
  portfolio,
  from,
  onSent,
  onAddFunds,
  purchases,
  onRecord,
  onStatus,
}: {
  api: AccountsApi;
  chain: ChainState;
  portfolio: PortfolioApi;
  /** A token to sell, picked on an asset screen (tokenKey form). */
  from: string | null;
  /** A transaction confirmed: refresh balances and history. */
  onSent: (chainId: number) => void;
  /** The account needs FMX: take the user to Receive. */
  onAddFunds: () => void;
  /** FMX bought through the pay-in on this device (WalletHome keeps them across screens). */
  purchases: PayinRecordsApi;
  /** A transfer sent on another network, for that network's Activity list. */
  onRecord: (tx: LocalTx) => void;
  onStatus: (chainId: number, hash: string, status: LocalTxStatus) => void;
}) {
  const wallet = api.active;
  const assets = portfolio.assetsByChain.get(CHAIN_ID) ?? [];
  const poolTokens = useMemo(() => assets.filter((a) => a.address !== null).map((a) => a.address as string), [assets]);
  const pools = useSwapPools(chain.rpcUrl, poolTokens);
  const pooled = useMemo(() => (pools.index ? pooledTokens(pools.index) : null), [pools.index]);

  // FMX, WFMX and the listed tokens always; a token the user added only once it has a pool.
  const offered = useMemo(() => offeredTokens(assets, pooled), [assets, pooled]);
  const hiddenCount = assets.filter((a) => a.source === 'custom').length - offered.filter((a) => a.source === 'custom').length;
  const find = (key: string) => assets.find((a) => tokenKey(a) === key);
  const usdf = assets.find((a) => a.symbol === 'USDF' && a.source === 'listed');

  const [inKey, setInKey] = useState<string>(() => (from && find(from) ? from : 'native'));
  const [outKey, setOutKey] = useState<string>(() => (from && from !== 'native' && find(from) ? 'native' : usdf ? tokenKey(usdf) : 'native'));
  const [amount, setAmount] = useState('');
  const [settings, setSettingsState] = useState<SwapSettings>(() => loadSwapSettings());
  const [picker, setPicker] = useState<'in' | 'out' | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [inverted, setInverted] = useState(false);
  const [ack, setAck] = useState(false);
  const [maxBusy, setMaxBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [phase, setPhaseState] = useState<Phase>({ kind: 'edit' });
  // Buying FMX with a coin on another network (the pay-in): the coin in use, a purchase being tracked,
  // and a stored quote to pay.
  const [buyKey, setBuyKey] = useState<string | null>(null);
  const [track, setTrack] = useState<string | null>(null);
  const [resume, setResume] = useState<PayinQuote | null>(null);
  // A new mount of the buy form per "Review and pay"; consuming the quote never remounts it.
  const [resumeSeq, setResumeSeq] = useState(0);
  const payin = usePayinAssets();
  usePayinTracking(purchases, wallet.address, () => onSent(CHAIN_ID));
  const myPurchases = recordsFrom(purchases.list, wallet.address);
  const listNow = useNowS(5_000);
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  const setPhase = (p: Phase) => {
    if (alive.current) setPhaseState(p);
  };

  const tokenIn = find(inKey) ?? assets[0]!;
  const tokenOut = find(outKey) ?? (assets.find((a) => tokenKey(a) !== tokenKey(tokenIn)) as AssetRef);
  const kind = swapKind(tokenIn, tokenOut);
  const balIn = balanceFor(portfolio.lastGood, CHAIN_ID, tokenIn.address);
  const balOut = balanceFor(portfolio.lastGood, CHAIN_ID, tokenOut.address);
  const balFmx = balanceFor(portfolio.lastGood, CHAIN_ID, null);
  const connected = chain.provider !== null && chain.rpcUrl !== null;

  const setSettings = (s: SwapSettings) => {
    setSettingsState(s);
    saveSwapSettings(s);
  };

  /* ---------------- the live quote ---------------- */

  const quote: Quote = useMemo(() => {
    if (amount.trim() === '') return { kind: 'empty' };
    const amt = checkAmount(amount, tokenIn.decimals);
    if (!amt.ok) return { kind: 'invalid', error: amt.error };
    if (kind === 'wrap' || kind === 'unwrap') return { kind: 'wrap', amountIn: amt.wei };
    if (!pools.index) return { kind: 'loading' };
    const route = bestRoute(pools.index, poolAddress(tokenIn), poolAddress(tokenOut), amt.wei);
    if (!route) return { kind: 'no-route' };
    return { kind: 'swap', amountIn: amt.wei, route, minOut: minimumReceived(route.amountOut, settings.slippageBps), impactPpm: route.priceImpactPpm };
  }, [amount, tokenIn, tokenOut, kind, pools.index, settings.slippageBps]);

  // Before an amount is typed: the pools' mid price for one unit, for the rate line.
  const preview = useMemo(() => {
    if (kind !== 'swap' || !pools.index) return null;
    const one = 10n ** BigInt(tokenIn.decimals);
    const r = bestRoute(pools.index, poolAddress(tokenIn), poolAddress(tokenOut), one);
    return r ? { route: r, mid: midOutput(one, r.hops), one } : null;
  }, [kind, pools.index, tokenIn, tokenOut]);

  const outAmount = quote.kind === 'swap' ? quote.route.amountOut : quote.kind === 'wrap' ? quote.amountIn : null;
  const level = quote.kind === 'swap' ? impactLevel(Number(quote.impactPpm / 100n)) : 'ok';
  const symbolsFor = (r: Route) => routeSymbols(r, tokenIn, tokenOut, assets);

  // A new pair, amount or tolerance needs its own acknowledgement.
  useEffect(() => setAck(false), [inKey, outKey, amount, settings.slippageBps]);

  // A new amount or pair re-reads the pools once typing pauses, unless they were read a moment ago:
  // the quote on screen is never older than the last pause.
  const poolsRef = useRef(pools);
  poolsRef.current = pools;
  useEffect(() => {
    if (amount.trim() === '') return;
    const id = setTimeout(() => {
      const p = poolsRef.current;
      if (!p.loading && (p.updatedAt === null || Date.now() - p.updatedAt > POOL_FRESH_MS)) void p.reload();
    }, 350);
    return () => clearTimeout(id);
  }, [amount, inKey, outKey]);

  /* ---------------- form actions ---------------- */

  function pick(side: 'in' | 'out', key: string) {
    setPicker(null);
    setFormError(null);
    if (side === 'in' && buyKey !== null) {
      // Back from buying to a Ferminux DEX swap.
      setBuyKey(null);
      setAmount('');
      setInKey(key);
      if (key === outKey) setOutKey(key === 'native' ? (usdf ? tokenKey(usdf) : 'native') : 'native');
      return;
    }
    const other = side === 'in' ? outKey : inKey;
    if (key === other) {
      // Picking the other side's token swaps the two.
      setInKey(outKey);
      setOutKey(inKey);
      return;
    }
    if (side === 'in') {
      if (key !== inKey) setAmount('');
      setInKey(key);
    } else setOutKey(key);
  }

  function flip() {
    setFormError(null);
    // The amount received becomes the amount paid, so the form keeps its meaning.
    if (outAmount !== null && outAmount > 0n) setAmount(formatAmountExact(outAmount, tokenOut.decimals).replace(/\.0$/, ''));
    setInKey(outKey);
    setOutKey(inKey);
  }

  async function useMax() {
    setFormError(null);
    if (balIn === null) return setFormError(`${tokenIn.symbol} balance unknown — cannot compute Max.`);
    if (tokenIn.address !== null) {
      setAmount(formatAmountExact(balIn, tokenIn.decimals).replace(/\.0$/, ''));
      return;
    }
    setMaxBusy(true);
    try {
      if (!chain.provider) throw new Error('offline');
      const fees = await getFeeInfo(chain.provider);
      const reserve = SWAP_GAS_RESERVE * fees.maxFeePerGas;
      if (balIn <= reserve) return setFormError('This FMX balance does not cover the network fee of a swap.');
      setAmount(formatAmountExact(balIn - reserve, 18).replace(/\.0$/, ''));
    } catch {
      setFormError('Could not read the network fee to compute Max.');
    } finally {
      setMaxBusy(false);
    }
  }

  /* ---------------- review → approve → confirm → sign ---------------- */

  interface Input {
    tokenIn: AssetRef;
    tokenOut: AssetRef;
    amountIn: bigint;
    settings: SwapSettings;
  }

  const transport = () => {
    if (!chain.provider || !chain.rpcUrl) throw new Error('Not connected to the Ferminux Network.');
    return httpBatchTransport(chain.rpcUrl, 12_000);
  };

  /** Fresh pools → best route → one pre-check batch → approval or the swap, prepared → the confirm screen. */
  async function review(input: Input, note: string | null = null, afterApproval = false) {
    const k = swapKind(input.tokenIn, input.tokenOut);
    if (!k) return;
    setFormError(null);
    setPhase({ kind: 'checking', label: afterApproval ? 'Preparing the swap…' : 'Checking…' });
    try {
      let route: Route | null = null;
      if (k === 'swap') {
        const index = await pools.reload();
        if (!index) throw new Error(pools.error ?? 'The Ferminux DEX could not be read. Try again in a moment.');
        route = bestRoute(index, poolAddress(input.tokenIn), poolAddress(input.tokenOut), input.amountIn);
        if (!route) {
          return setPhase({
            kind: 'problem',
            problem: { code: 'no-route', message: `No Ferminux DEX pool route pays out ${input.tokenOut.symbol} for this much ${input.tokenIn.symbol} right now.` },
          });
        }
      }
      const pf = await readSwapPreflight(transport(), {
        holder: wallet.address,
        tokenIn: input.tokenIn,
        amountIn: input.amountIn,
        path: route?.path ?? null,
        wrap: k !== 'swap',
      });
      const early = swapProblem(input.tokenIn, input.tokenOut, input.amountIn, pf, { wrap: k !== 'swap' });
      if (early) return setPhase({ kind: 'problem', problem: early });

      const expectedOut = k === 'swap' ? pf.amounts![pf.amounts!.length - 1]! : input.amountIn;
      const minOut = k === 'swap' ? minimumReceived(expectedOut, input.settings.slippageBps) : input.amountIn;
      if (minOut <= 0n) {
        return setPhase({ kind: 'problem', problem: { code: 'no-route', message: 'This amount is too small to pay out anything after slippage. Enter a larger amount.' } });
      }
      const impactPpm = route ? priceImpactPpm(input.amountIn, expectedOut, route.hops) : 0n;
      if (k === 'swap' && impactLevel(Number(impactPpm / 100n)) === 'severe' && !ack) {
        setPhase({ kind: 'edit' });
        return setFormError(`Price impact is now ${formatImpactPpm(impactPpm)}. Confirm below that you accept it, or swap less.`);
      }
      const deadline = k === 'swap' ? deadlineFrom(pf.blockTime, input.settings.deadlineMin) : null;
      const call =
        k === 'swap'
          ? buildSwapCall({
              tokenIn: input.tokenIn,
              tokenOut: input.tokenOut,
              amountIn: input.amountIn,
              amountOutMin: minOut,
              path: route!.path,
              recipient: wallet.address,
              deadline: deadline!,
              chainId: CHAIN_ID,
            })
          : buildWrapCall(k, input.amountIn, CHAIN_ID);
      const plan: SwapPlanView = {
        kind: k,
        method: call.method,
        tokenIn: input.tokenIn,
        tokenOut: input.tokenOut,
        amountIn: input.amountIn,
        expectedOut,
        minOut,
        route,
        routeSymbols: route ? routeSymbols(route, input.tokenIn, input.tokenOut, assets) : [],
        impactPpm,
        slippageBps: input.settings.slippageBps,
        deadline,
      };

      // Step 1 of 2: the router may not take this token yet.
      if (k === 'swap' && input.tokenIn.address !== null && allowanceShortfall(pf, input.amountIn) > 0n) {
        const approve = buildApproveCall(input.tokenIn, input.amountIn, input.settings.approval, CHAIN_ID);
        const prepared = await prepareTransaction(chain.provider!, CHAIN_ID, wallet.address, approve.to, 0n, approve.data);
        const gas = swapProblem(input.tokenIn, input.tokenOut, input.amountIn, pf, { feeWei: prepared.maxFeeWei, wrap: true });
        if (gas) return setPhase({ kind: 'problem', problem: gas });
        return setPhase({ kind: 'approve', plan, prepared, amount: approve.amount, step: null });
      }

      let prepared: PreparedTx;
      try {
        prepared = await prepareTransaction(chain.provider!, CHAIN_ID, wallet.address, call.to, call.value, call.data);
      } catch (e) {
        return setPhase({ kind: 'failed', message: e instanceof Error ? shortenError(e.message) : 'Could not prepare the swap.' });
      }
      const withFee = swapProblem(input.tokenIn, input.tokenOut, input.amountIn, pf, { feeWei: prepared.maxFeeWei, wrap: k !== 'swap' });
      if (withFee) return setPhase({ kind: 'problem', problem: withFee });
      setPhase({ kind: 'confirm', plan, prepared, pf, note, twoStep: afterApproval, step: null });
    } catch (e) {
      setPhase({ kind: 'failed', message: e instanceof Error ? shortenError(e.message) : 'Could not check the swap.' });
    }
  }

  function startReview() {
    const amt = checkAmount(amount, tokenIn.decimals);
    if (!amt.ok) return setFormError(amt.error);
    if (balIn !== null && amt.wei > balIn) return setFormError(`Exceeds your ${tokenIn.symbol} balance (${fmt(balIn, tokenIn)}).`);
    void review({ tokenIn, tokenOut, amountIn: amt.wei, settings });
  }

  const inputOf = (plan: SwapPlanView): Input => ({ tokenIn: plan.tokenIn, tokenOut: plan.tokenOut, amountIn: plan.amountIn, settings });

  async function signApproval(ph: Extract<Phase, { kind: 'approve' }>) {
    setPhase({ ...ph, step: 'signing' });
    let hash: string;
    try {
      hash = (await signAndBroadcast(wallet.privateKey, chain.provider!, ph.prepared)).hash;
    } catch (e) {
      return setPhase({ kind: 'failed', message: e instanceof Error ? shortenError(e.message) : 'The approval could not be sent.' });
    }
    setPhase({ kind: 'approving', plan: ph.plan, hash });
    const receipt = await chain.provider!.waitForTransaction(hash, 1, 180_000).catch(() => null);
    if (receipt?.status !== 1) {
      return setPhase({
        kind: 'failed',
        hash,
        message:
          receipt?.status === 0
            ? 'The approval was included in a block but reverted. Nothing was swapped; only the network fee was spent.'
            : 'The approval was sent but its confirmation could not be read. Check it on the explorer, then review the swap again.',
      });
    }
    onSent(CHAIN_ID);
    const t = ph.plan.tokenIn;
    const what = settings.approval === 'unlimited' && ph.amount > ph.plan.amountIn ? 'without limit' : `for exactly ${fmt(ph.amount, t)} ${t.symbol}`;
    await review(inputOf(ph.plan), `${t.symbol} approved to the Ferminux DEX router ${what}. Now review the swap.`, true);
  }

  async function signSwap(ph: Extract<Phase, { kind: 'confirm' }>) {
    const { plan, prepared } = ph;
    setPhase({ ...ph, step: 'checking' });
    // Everything the router will check, once more: nothing is signed that is already known to fail.
    let fresh: SwapPreflight;
    try {
      fresh = await readSwapPreflight(transport(), {
        holder: wallet.address,
        tokenIn: plan.tokenIn,
        amountIn: plan.amountIn,
        path: plan.route?.path ?? null,
        wrap: plan.kind !== 'swap',
      });
    } catch (e) {
      return setPhase({ kind: 'failed', message: `${e instanceof Error ? shortenError(e.message) : 'The swap could not be checked again.'} Nothing was signed.` });
    }
    const late = swapProblem(plan.tokenIn, plan.tokenOut, plan.amountIn, fresh, {
      feeWei: prepared.maxFeeWei,
      amountOutMin: plan.kind === 'swap' ? plan.minOut : undefined,
      deadline: plan.deadline ?? undefined,
      wrap: plan.kind !== 'swap',
    });
    if (late) return setPhase({ kind: 'problem', problem: late });
    if (plan.kind === 'swap' && allowanceShortfall(fresh, plan.amountIn) > 0n) {
      return setPhase({
        kind: 'problem',
        problem: { code: 'no-route', message: `The router may no longer take this much ${plan.tokenIn.symbol} (the allowance changed). Review the swap again. Nothing was signed.` },
      });
    }
    setPhase({ ...ph, pf: fresh, step: 'signing' });
    let hash: string;
    try {
      hash = (await signAndBroadcast(wallet.privateKey, chain.provider!, prepared)).hash;
    } catch (e) {
      return setPhase({ kind: 'failed', message: e instanceof Error ? shortenError(e.message) : 'Broadcast failed.' });
    }
    setPhase({ kind: 'pending', plan, hash });
    // waitForTransaction hands back a reverted receipt as it is (TransactionResponse.wait() throws on one).
    const receipt = await chain.provider!.waitForTransaction(hash, 1, 180_000).catch(() => null);
    onSent(CHAIN_ID);
    void pools.reload(); // this swap moved the pools it went through
    if (receipt?.status === 1) {
      const lastPair = plan.route?.hops[plan.route.hops.length - 1]?.pair;
      const received = plan.kind === 'swap' ? (lastPair ? receivedFromLogs(receipt.logs, lastPair) : null) : plan.amountIn;
      return setPhase({ kind: 'done', plan, hash, received });
    }
    setPhase({
      kind: 'failed',
      hash,
      message:
        receipt?.status === 0
          ? plan.kind === 'swap'
            ? `The swap was included in a block but reverted: the price moved past your ${formatPercentBps(plan.slippageBps)} tolerance, or the deadline passed, before it ran. Nothing was swapped; only the network fee was spent.`
            : 'The transaction was included in a block but reverted. Only the network fee was spent.'
          : 'The swap was sent but its confirmation could not be read. Check it on the explorer before trying again.',
    });
  }

  function backToEdit(keep = true) {
    setPhase({ kind: 'edit' });
    if (!keep) setAmount('');
  }

  /* ---------------- render: after Review ---------------- */

  // The confirm and result screens keep the width of the wallet's other confirm screens.
  const flow = (el: JSX.Element) => <div className="swap-flow">{el}</div>;

  const balances = new Map<string, bigint | null>(offered.map((a) => [tokenKey(a), balanceFor(portfolio.lastGood, CHAIN_ID, a.address)]));
  const purchaseList = <PurchasesList records={myPurchases} nowS={listNow} onOpen={(id) => setTrack(id)} />;
  const tokenPicker = picker && (
    <TokenPicker
      side={picker}
      tokens={offered}
      balances={balances}
      selected={picker === 'in' ? (buyKey ? '' : inKey) : outKey}
      other={picker === 'in' ? (buyKey ? '' : outKey) : inKey}
      hiddenCount={hiddenCount}
      onPick={(k) => pick(picker, k)}
      onClose={() => setPicker(null)}
      payin={{
        assets: payin.assets,
        state: payin.state,
        balanceOf: (chainId, address) => balanceFor(portfolio.lastGood, chainId, address),
        selected: buyKey,
        onPick: (k) => {
          setPicker(null);
          setFormError(null);
          setTrack(null);
          setResume(null);
          setBuyKey(k);
        },
      }}
    />
  );

  /* ---------------- render: buying FMX on another network ---------------- */

  const tracked = track ? myPurchases.find((r) => r.quoteId === track) ?? null : null;
  if (tracked) {
    const coin = payinCoin(tracked.chain, tracked.asset);
    return (
      <PayinTracker
        record={tracked}
        onBack={() => setTrack(null)}
        onPay={() => {
          setResume(quoteFromRecord(tracked));
          setResumeSeq((n) => n + 1);
          if (coin) setBuyKey(payinCoinKey(coin));
          setTrack(null);
        }}
        onBuyAgain={() => {
          setResume(null);
          if (coin) setBuyKey(payinCoinKey(coin));
          setTrack(null);
        }}
      />
    );
  }
  const buyCoin = buyKey ? payinCoin(buyKey.split(':')[0]!, buyKey.split(':')[1]!) : null;
  if (buyCoin) {
    return (
      <>
        <BuyPanel
          key={`${wallet.id}:${buyKey}:${resumeSeq}`}
          api={api}
          portfolio={portfolio}
          coin={buyCoin}
          payin={payin}
          records={purchases}
          resume={resume}
          onResumeUsed={() => setResume(null)}
          onOpenPicker={() => setPicker('in')}
          onTrack={(id) => setTrack(id)}
          onSent={onSent}
          onRecord={onRecord}
          onStatus={onStatus}
          purchases={purchaseList}
          rail={<BuyHowTo coinSymbol={buyCoin.symbol} chainName={buyCoin.chain.name} />}
        />
        {tokenPicker}
      </>
    );
  }

  if (phase.kind === 'approve') {
    return flow(
      <ApproveConfirm
        token={phase.plan.tokenIn}
        amount={phase.amount}
        mode={settings.approval}
        wallet={wallet}
        prepared={phase.prepared}
        step={phase.step}
        onBack={() => backToEdit()}
        onSign={() => void signApproval(phase)}
      />
    );
  }
  if (phase.kind === 'confirm') {
    return flow(
      <SwapConfirm
        plan={phase.plan}
        wallet={wallet}
        prepared={phase.prepared}
        pf={phase.pf}
        note={phase.note}
        twoStep={phase.twoStep}
        step={phase.step}
        onBack={() => backToEdit()}
        onSign={() => void signSwap(phase)}
      />
    );
  }
  if (phase.kind === 'approving' || phase.kind === 'pending') {
    const approving = phase.kind === 'approving';
    return flow(
      <div className="panel send-card" data-testid={approving ? 'swap-approving' : 'swap-pending'}>
        <div className="tx-state">
          <div className="state-ic">
            <Spinner />
          </div>
          <h3>{approving ? `Approving ${phase.plan.tokenIn.symbol}` : phase.plan.kind === 'swap' ? 'Swap submitted' : 'Submitted'}</h3>
          <p>
            Waiting for a block on the Ferminux Network (about 7 s)…
            {approving && ' The swap is prepared as soon as the approval is in.'}
          </p>
          <HashLine chain={FERMINUX_CHAIN} hash={phase.hash} />
        </div>
      </div>
    );
  }
  if (phase.kind === 'done') {
    const p = phase.plan;
    const got = phase.received ?? p.expectedOut;
    return flow(
      <div data-testid="swap-done">
        <div className="panel send-card">
          <div className="tx-state">
            <div className="state-ic ok">
              <IconCheck />
            </div>
            <h3>{p.kind === 'swap' ? 'Swapped' : p.kind === 'wrap' ? 'Wrapped' : 'Unwrapped'}</h3>
            <p data-testid="swap-done-text">
              {fmt(p.amountIn, p.tokenIn)} {p.tokenIn.symbol} → <strong data-testid="swap-done-received">{fmt(got, p.tokenOut)}</strong> {p.tokenOut.symbol}
              {phase.received === null && p.kind === 'swap' ? ' (expected)' : ''}
            </p>
            <div data-testid="swap-tx">
              <HashLine chain={FERMINUX_CHAIN} hash={phase.hash} />
            </div>
          </div>
        </div>
        <div className="cta-bar">
          <button className="btn btn-primary btn-block" data-testid="swap-again" onClick={() => backToEdit(false)}>
            Swap again
          </button>
        </div>
      </div>
    );
  }
  if (phase.kind === 'failed') {
    return flow(
      <div data-testid="swap-failed">
        <div className="panel send-card">
          <div className="tx-state">
            <div className="state-ic bad">
              <IconClose />
            </div>
            <h3>Not swapped</h3>
            <p style={{ overflowWrap: 'anywhere' }}>{phase.message}</p>
            {phase.hash && <HashLine chain={FERMINUX_CHAIN} hash={phase.hash} />}
          </div>
        </div>
        <div className="cta-bar">
          <button className="btn btn-block" onClick={() => backToEdit()}>
            Back to the swap
          </button>
        </div>
      </div>
    );
  }
  if (phase.kind === 'problem') {
    const pr = phase.problem;
    return flow(
      <div data-testid="swap-problem-card">
        <div className="panel send-card">
          <div className={'notice ' + (pr.code === 'error' ? 'notice-danger' : 'notice-warn')} data-testid="swap-problem" data-code={pr.code} style={{ marginBottom: 0 }}>
            {pr.message}
          </div>
          {phase.hash && <HashLine chain={FERMINUX_CHAIN} hash={phase.hash} />}
        </div>
        <div className="cta-bar">
          <div className="actions-split">
            <button className="btn" data-testid="swap-problem-back" onClick={() => backToEdit()}>
              Back
            </button>
            {pr.code === 'gas' && tokenIn.address !== null ? (
              <button className="btn btn-primary" data-testid="swap-add-fmx" onClick={onAddFunds}>
                <IconReceive /> Add FMX
              </button>
            ) : (
              <button className="btn btn-primary" data-testid="swap-retry" onClick={startReview}>
                {pr.code === 'moved' || pr.code === 'expired' ? 'Review the new quote' : 'Check again'}
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  /* ---------------- render: the form ---------------- */

  const checking = phase.kind === 'checking';
  const amt = quote.kind === 'swap' || quote.kind === 'wrap' ? quote.amountIn : null;
  const overBalance = amt !== null && balIn !== null && amt > balIn;
  const severe = quote.kind === 'swap' && level === 'severe';
  let cta = kind === 'wrap' ? 'Review wrap' : kind === 'unwrap' ? 'Review unwrap' : 'Review swap';
  let ctaDisabled = checking || !connected;
  if (!connected) cta = 'Offline';
  else if (quote.kind === 'empty') {
    cta = 'Enter an amount';
    ctaDisabled = true;
  } else if (quote.kind === 'invalid') ctaDisabled = true;
  else if (quote.kind === 'no-route') {
    cta = 'No pool route';
    ctaDisabled = true;
  } else if (quote.kind === 'loading') ctaDisabled = true;
  else if (overBalance) {
    cta = `Not enough ${tokenIn.symbol}`;
    ctaDisabled = true;
  } else if (severe && !ack) ctaDisabled = true;

  const rate = (() => {
    if (kind !== 'swap' && kind !== null) return `1 ${tokenIn.symbol} = 1 ${tokenOut.symbol}`;
    if (quote.kind === 'swap') {
      return inverted
        ? `1 ${tokenOut.symbol} = ${formatRate(quote.route.amountOut, tokenOut.decimals, quote.amountIn, tokenIn.decimals)} ${tokenIn.symbol}`
        : `1 ${tokenIn.symbol} = ${formatRate(quote.amountIn, tokenIn.decimals, quote.route.amountOut, tokenOut.decimals)} ${tokenOut.symbol}`;
    }
    if (preview) {
      return inverted
        ? `1 ${tokenOut.symbol} ≈ ${formatRate(preview.mid, tokenOut.decimals, preview.one, tokenIn.decimals)} ${tokenIn.symbol}`
        : `1 ${tokenIn.symbol} ≈ ${formatRate(preview.one, tokenIn.decimals, preview.mid, tokenOut.decimals)} ${tokenOut.symbol}`;
    }
    return null;
  })();

  return (
    <div className="swap-grid">
      <div style={{ minWidth: 0 }}>
        <div className="panel swap-card" data-testid="swap-form" data-in={inKey} data-out={outKey}>
          <div className="swap-card-head">
            <ChainBadge chain={FERMINUX_CHAIN} />
            <span className="swap-venue">
              Ferminux DEX <span className="faint num">· chain {SWAP_CHAIN_ID}</span>
            </span>
            <span className="push" />
            <button className="btn btn-ghost btn-sm" data-testid="swap-settings-open" onClick={() => setSettingsOpen(true)} aria-label={`Swap settings: slippage ${formatPercentBps(settings.slippageBps)}`}>
              <IconSettings /> <span className="num">{formatPercentBps(settings.slippageBps)}</span>
            </button>
          </div>
          <div className="swap-leg">
            <div className="swap-leg-head">
              <span>You pay</span>
              <span className="push" />
              <span className="num" data-testid="swap-bal-in">
                {balIn === null ? 'Balance —' : `Balance ${fmt(balIn, tokenIn, 6)}`}
              </span>
              <button className="btn btn-ghost btn-sm swap-max" data-testid="swap-max" onClick={() => void useMax()} disabled={checking || maxBusy || balIn === null || balIn === 0n}>
                {maxBusy ? <Spinner /> : 'Max'}
              </button>
            </div>
            <div className="swap-leg-row">
              <input
                className="swap-amount"
                data-testid="swap-amount"
                placeholder="0"
                inputMode="decimal"
                autoComplete="off"
                aria-label={`Amount of ${tokenIn.symbol} to pay`}
                aria-invalid={quote.kind === 'invalid' || overBalance ? true : undefined}
                value={amount}
                disabled={checking}
                onChange={(e) => {
                  setAmount(e.target.value.replace(',', '.'));
                  setFormError(null);
                }}
              />
              <button className="token-btn" data-testid="swap-token-in" onClick={() => setPicker('in')} disabled={checking} aria-label={`Pay with ${tokenIn.symbol}. Change`}>
                <Glyph token={tokenIn} />
                <span>{tokenIn.symbol}</span>
                <IconChevronDown />
              </button>
            </div>
          </div>

          <div className="swap-flip-row">
            <button className="swap-flip hit-44" data-testid="swap-flip" onClick={flip} disabled={checking} aria-label="Switch the two tokens" title="Switch">
              <IconSwap />
            </button>
          </div>

          <div className="swap-leg">
            <div className="swap-leg-head">
              <span>You receive{quote.kind === 'swap' ? ' (expected)' : ''}</span>
              <span className="push" />
              <span className="num">{balOut === null ? 'Balance —' : `Balance ${fmt(balOut, tokenOut, 6)}`}</span>
            </div>
            <div className="swap-leg-row">
              <output className={'swap-amount swap-out' + (outAmount === null ? ' is-empty' : '')} data-testid="swap-out" aria-live="polite">
                {outAmount !== null ? fmt(outAmount, tokenOut, 8) : quote.kind === 'loading' ? '…' : '0'}
              </output>
              <button className="token-btn" data-testid="swap-token-out" onClick={() => setPicker('out')} disabled={checking} aria-label={`Receive ${tokenOut.symbol}. Change`}>
                <Glyph token={tokenOut} />
                <span>{tokenOut.symbol}</span>
                <IconChevronDown />
              </button>
            </div>
          </div>

          <div className="swap-rate">
            {rate ? (
              <button className="link-btn swap-rate-btn" data-testid="swap-rate" onClick={() => setInverted((v) => !v)} title="Show the other way round">
                {rate}
              </button>
            ) : (
              <span className="faint">{pools.index ? 'No pool route between these two yet' : 'Reading the pools…'}</span>
            )}
            <span className="push" />
            <button className="icon-btn icon-btn-sm" onClick={() => void pools.reload()} disabled={pools.loading} aria-label="Read the pools again" title="Read the pools again">
              {pools.loading ? <Spinner /> : <IconRefresh />}
            </button>
          </div>

          {quote.kind === 'swap' && (
            <dl className="swap-facts" data-testid="swap-facts">
              <div>
                <dt>Route</dt>
                <dd>
                  <RouteLine symbols={symbolsFor(quote.route)} testId="swap-route" />
                </dd>
              </div>
              <div>
                <dt>Price impact</dt>
                <dd data-testid="swap-impact">
                  <ImpactText ppm={quote.impactPpm} />
                </dd>
              </div>
              <div>
                <dt>Minimum received</dt>
                <dd className="num" data-testid="swap-min">
                  {fmt(quote.minOut, tokenOut, 8)} {tokenOut.symbol}
                </dd>
              </div>
              <div>
                <dt>Slippage tolerance</dt>
                <dd>
                  <button className="link-btn" data-testid="swap-slippage" onClick={() => setSettingsOpen(true)}>
                    {formatPercentBps(settings.slippageBps)}
                  </button>
                </dd>
              </div>
              <div>
                <dt>Pool fee</dt>
                <dd className="num">
                  {formatPercentBps(FEE_BPS * quote.route.hops.length)}
                  {quote.route.hops.length > 1 && <span className="faint"> · {quote.route.hops.length} pools</span>}
                </dd>
              </div>
            </dl>
          )}
          {quote.kind === 'wrap' && (
            <p className="small muted" style={{ margin: '4px 0 0' }} data-testid="swap-wrap-note">
              {kind === 'wrap' ? 'Wrapping' : 'Unwrapping'} goes through the WFMX contract at exactly 1 : 1: no pool, no fee beyond the
              network fee, no slippage.
            </p>
          )}

          {quote.kind === 'invalid' && <div className="field-error">{quote.error}</div>}
          {quote.kind === 'no-route' && (
            <div className="notice notice-warn" style={{ margin: '12px 0 0' }} data-testid="swap-no-route">
              No Ferminux DEX pool route from {tokenIn.symbol} to {tokenOut.symbol} holds liquidity yet. Routes run through at most three
              pools, with only WFMX and first-party tokens in between.
            </div>
          )}
          {quote.kind === 'swap' && level === 'warn' && (
            <div className="notice notice-warn" style={{ margin: '12px 0 0' }} data-testid="swap-impact-warn">
              Price impact {formatImpactPpm(quote.impactPpm)}: this size moves the pool price against you. A smaller amount loses less.
            </div>
          )}
          {severe && (
            <div className="notice notice-danger" style={{ margin: '12px 0 0' }} data-testid="swap-impact-severe">
              <strong>Price impact {formatImpactPpm(quote.impactPpm)}.</strong> The pool is too shallow for this size: you would receive
              far less than the current price.
              <label className="check-row" style={{ marginTop: 10 }}>
                <input type="checkbox" data-testid="swap-impact-ack" checked={ack} onChange={(e) => setAck(e.target.checked)} />
                <span>I accept losing about {formatImpactPpm(quote.impactPpm)} to price impact.</span>
              </label>
            </div>
          )}
          {balFmx === 0n && (
            <div className="notice notice-warn" style={{ margin: '12px 0 0' }} data-testid="swap-no-gas">
              This account has no FMX, so it cannot pay the network fee. Fees on the Ferminux Network are paid in FMX.
            </div>
          )}
          {formError && (
            <div className="field-error" data-testid="swap-form-error" style={{ marginTop: 12 }}>
              {formError}
            </div>
          )}
          {pools.error && pools.index === null && (
            <div className="field-error" style={{ marginTop: 12 }}>
              {pools.error}
            </div>
          )}
        </div>

        <p className="swap-scope small" data-testid="swap-scope">
          Swaps run on the Ferminux DEX, on the Ferminux Network (chain {SWAP_CHAIN_ID}) only, from {wallet.label}. To pay with USDT, USDC or
          another network’s own coin, pick it under You pay → Other networks: that buys FMX through the Ferminux pay-in.
        </p>

        {purchaseList}

        <div className="cta-bar">
          <button className="btn btn-primary btn-block" data-testid="swap-review" onClick={startReview} disabled={ctaDisabled}>
            {checking ? (
              <>
                <Spinner /> {phase.kind === 'checking' ? phase.label : 'Checking…'}
              </>
            ) : (
              cta
            )}
          </button>
        </div>
      </div>

      <aside className="swap-rail" aria-label="Ferminux DEX">
        <PoolsList pools={pools.pools} known={assets} error={pools.error} />
      </aside>

      {tokenPicker}
      {settingsOpen && <SwapSettingsSheet settings={settings} onChange={setSettings} onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}

/** The rail beside the buy form: what happens, in three steps. */
function BuyHowTo({ coinSymbol, chainName }: { coinSymbol: string; chainName: string }) {
  return (
    <section className="panel" aria-label="How buying works" data-testid="payin-howto">
      <div className="panel-head">
        <h2>How buying works</h2>
      </div>
      <ol className="howto-steps">
        <li>
          <span className="track-dot">1</span>
          <span>Get a quote: an exact amount of {coinSymbol} to send, valid for 15 minutes.</span>
        </li>
        <li>
          <span className="track-dot">2</span>
          <span>This wallet sends exactly that amount on {chainName} to the pay-in’s deposit address.</span>
        </li>
        <li>
          <span className="track-dot">3</span>
          <span>Once {chainName} has confirmed it, the pay-in sends FMX to your recipient on the Ferminux Network.</span>
        </li>
      </ol>
      <p className="small faint howto-foot">The price per FMX is set by the pay-in operator, not read from a pool; the quote shows it before you sign.</p>
    </section>
  );
}
