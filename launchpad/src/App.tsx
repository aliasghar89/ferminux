import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { JsonRpcProvider } from "ethers";
import {
  CHAIN_ID,
  EXPLORER_URL,
  FACTORY_ADDRESS,
  RPC_URL,
  RPC_URLS,
  explorerAddressUrl,
} from "./config.ts";
import { factoryContract, getFeeCollector, getLaunchFee, shortAddress } from "./lib/factory.ts";
import { pickRpc } from "./lib/rpc.ts";
import {
  addFerminuxNetwork,
  connectWallet,
  injected,
  switchToFerminux,
  type WalletState,
} from "./lib/wallet.ts";
import { connector } from "./lib/connector.ts";
import type { WalletChoice } from "../../shared/fxwallet/connector.ts";
import { ChainSetupError, type ChainSetupStep } from "../../shared/fxwallet/network.ts";
import LaunchForm from "./components/LaunchForm.tsx";
import TokenList from "./components/TokenList.tsx";
import ConnectChooser from "./components/ConnectChooser.tsx";

function describeWalletError(e: unknown): string {
  if (e instanceof ChainSetupError) return e.message;
  const err = e as { code?: number; message?: string };
  if (err?.code === 4001) return "You rejected the request in your wallet.";
  return e instanceof Error ? e.message : String(e);
}

const stepText = (step: ChainSetupStep) =>
  step === "add" ? "Approve adding Ferminux in your wallet." : "Approve switching to Ferminux in your wallet.";

type Tab = "launch" | "registry";

export default function App() {
  const [tab, setTab] = useState<Tab>("launch");
  const [wallet, setWallet] = useState<WalletState | null>(null);
  const [walletError, setWalletError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [fee, setFee] = useState<bigint | null>(null);
  const [feeError, setFeeError] = useState<string | null>(null);
  const [feeCollector, setFeeCollector] = useState<string | null>(null);
  const [listVersion, setListVersion] = useState(0);
  const [rpcUrl, setRpcUrl] = useState<string>(RPC_URL);

  // Start on the preferred endpoint at once; move to the first one that
  // actually answers for chain 3961 if that is a different one.
  useEffect(() => {
    if (RPC_URLS.length < 2) return;
    let alive = true;
    void pickRpc(RPC_URLS, CHAIN_ID).then((url) => {
      if (alive && url) setRpcUrl(url);
    });
    return () => {
      alive = false;
    };
  }, []);

  // Read-only provider — the token list and fee work without any wallet.
  const readProvider = useMemo(() => {
    return new JsonRpcProvider(rpcUrl, undefined, { staticNetwork: true });
  }, [rpcUrl]);
  const readFactory = useMemo(
    () => factoryContract(FACTORY_ADDRESS, readProvider),
    [readProvider],
  );

  const loadFee = useCallback(() => {
    setFeeError(null);
    getLaunchFee(readFactory)
      .then(setFee)
      .catch((e: unknown) => {
        setFee(null);
        setFeeError(e instanceof Error ? e.message : String(e));
      });
    // Where the fee goes is shown next to it; a failed read only hides that line.
    getFeeCollector(readFactory)
      .then(setFeeCollector)
      .catch(() => setFeeCollector(null));
  }, [readFactory]);

  useEffect(loadFee, [loadFee]);

  const [chooserOpen, setChooserOpen] = useState(false);
  /** What the wallet is being asked right now, while it is being asked. */
  const [chainStep, setChainStep] = useState<string | null>(null);
  const [choices, setChoices] = useState<WalletChoice[]>(() => connector.choices());
  // Account and chain switches can arrive back to back, each starting a rebuild: only the newest may land, or
  // a stale one resolving last would put back the previous account (and sign as it).
  const walletSeq = useRef(0);
  const land = useCallback(async (eth: Parameters<typeof connectWallet>[0]) => {
    const seq = ++walletSeq.current;
    const next = await connectWallet(eth);
    if (seq === walletSeq.current) setWallet(next);
  }, []);

  // One place follows the connected wallet, whichever kind it is: account and
  // chain switches rebuild the signer, a disconnect or revoke clears it.
  useEffect(() => {
    let last = connector.current();
    const rebuild = () => {
      const conn = connector.current();
      if (!conn) {
        ++walletSeq.current;
        setWallet(null);
        return;
      }
      const seq = walletSeq.current + 1;
      land(conn.provider).catch((e: unknown) => {
        if (seq !== walletSeq.current) return;
        setWallet(null);
        setWalletError(describeWalletError(e));
      });
    };
    const unsubscribe = connector.subscribe(() => {
      setChoices(connector.choices());
      const now = connector.current();
      if (now !== last) {
        last = now;
        rebuild();
      }
    });
    // A wallet this site used before reconnects without a prompt.
    void connector.restore().then((conn) => {
      if (conn) {
        last = conn;
        rebuild();
      }
    });
    return unsubscribe;
  }, [land]);

  const handleConnect = useCallback(() => {
    setWalletError(null);
    setChooserOpen(true);
  }, []);

  const connectWith = useCallback((id: string) => {
    setBusy(true);
    setWalletError(null);
    // Synchronous inside the click: this is what opens the Ferminux Wallet window.
    connector
      .connect(id)
      .then(async (conn) => {
        await land(conn.provider);
        setChooserOpen(false);
        // A phone wallet over WalletConnect rarely knows Ferminux yet: ask it
        // to switch (adding the network) now. A refusal keeps the wallet
        // connected, with the reason and the switch button.
        if (conn.choice.kind === "walletconnect" && conn.chainId !== CHAIN_ID) {
          try {
            await switchToFerminux(conn.provider, { onStep: (s) => setChainStep(stepText(s)) });
            await land(conn.provider);
          } catch (e: unknown) {
            setWalletError(describeWalletError(e));
          }
        }
      })
      .catch((e: unknown) => setWalletError(describeWalletError(e)))
      .finally(() => {
        setBusy(false);
        setChainStep(null);
      });
  }, [land]);

  const handleAddNetwork = useCallback(async () => {
    setBusy(true);
    setWalletError(null);
    try {
      if (wallet) {
        const eth = connector.current()?.provider;
        await switchToFerminux(eth, { onStep: (s) => setChainStep(stepText(s)) });
        if (eth) await land(eth);
      } else await addFerminuxNetwork();
    } catch (e: unknown) {
      setWalletError(describeWalletError(e));
    } finally {
      setBusy(false);
      setChainStep(null);
    }
  }, [wallet, land]);

  const wrongChain = wallet !== null && wallet.chainId !== CHAIN_ID;

  return (
    <>
      <header className="site-header">
        <div className="inner">
          <span className="wordmark">
            FERMINUX <span className="fx">LAUNCHPAD</span>
          </span>
          <span className="header-spacer" />
          {wallet ? (
            <span className={`net-pill ${wrongChain ? "warn" : "ok"}`}>
              <span className="dot" />
              {wrongChain
                ? `Wrong network (chain ${wallet.chainId})`
                : "Ferminux · 3961"}
              <span className="addr">{shortAddress(wallet.address)}</span>
            </span>
          ) : (
            <span className="net-pill">
              <span className="dot" />
              Not connected
            </span>
          )}
          {((wallet && wrongChain) || (!wallet && injected())) && (
            <button className="subtle" onClick={handleAddNetwork} disabled={busy}>
              {wrongChain ? "Switch to Ferminux" : "Add Ferminux Network"}
            </button>
          )}
          {!wallet && (
            <button className="primary" data-testid="header-connect" onClick={handleConnect} disabled={busy}>
              Connect wallet
            </button>
          )}
          {wallet && (
            <button className="subtle" onClick={() => void connector.disconnect()} title="Disconnect this wallet from the launchpad">
              Disconnect
            </button>
          )}
        </div>
      </header>

      {chooserOpen && (
        <ConnectChooser
          choices={choices}
          connecting={busy}
          error={walletError}
          onChoose={connectWith}
          onClose={() => setChooserOpen(false)}
        />
      )}

      <main className="container">
        {chainStep && (
          <div className="notice" role="status" style={{ marginTop: 16 }}>
            <span className="spinner" /> {chainStep}
          </div>
        )}
        {walletError && !chooserOpen && (
          <div className="notice error" style={{ marginTop: 16 }}>
            {walletError}
          </div>
        )}

        <div className="tabs" role="tablist">
          <button
            role="tab"
            aria-selected={tab === "launch"}
            className={tab === "launch" ? "active" : ""}
            onClick={() => setTab("launch")}
          >
            Launch a coin
          </button>
          <button
            role="tab"
            aria-selected={tab === "registry"}
            className={tab === "registry" ? "active" : ""}
            onClick={() => setTab("registry")}
          >
            Token registry
          </button>
        </div>

        {tab === "launch" ? (
          <LaunchForm
            wallet={wallet}
            wrongChain={wrongChain}
            fee={fee}
            feeCollector={feeCollector}
            feeError={feeError}
            onRetryFee={loadFee}
            onConnect={handleConnect}
            onFixNetwork={handleAddNetwork}
            onLaunched={() => setListVersion((v) => v + 1)}
          />
        ) : (
          <TokenList readProvider={readProvider} refreshKey={listVersion} />
        )}
      </main>

      <footer className="site-footer">
        <span>Ferminux Network · chain id 3961</span>
        <a href={explorerAddressUrl(FACTORY_ADDRESS)} target="_blank" rel="noreferrer">
          TokenFactory {shortAddress(FACTORY_ADDRESS)}
        </a>
        <a href={EXPLORER_URL} target="_blank" rel="noreferrer">
          Explorer
        </a>
        {/* Text, not a link: a JSON-RPC endpoint opened in a browser tab is a blank page. */}
        <span title={rpcUrl}>RPC {new URL(rpcUrl).host}</span>
      </footer>
    </>
  );
}
