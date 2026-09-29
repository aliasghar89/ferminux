import { useCallback, useEffect, useMemo, useState } from "react";
import type { Provider } from "ethers";
import { FACTORY_ADDRESS, PAGE_SIZE, explorerAddressUrl } from "../config.ts";
import {
  factoryContract,
  formatAmount,
  getTokenDetails,
  getTokensNewestFirst,
  shortAddress,
  trustBadges,
  type TokenDetails,
} from "../lib/factory.ts";

interface Props {
  readProvider: Provider;
  refreshKey: number;
}

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; rows: TokenDetails[]; total: number };

export default function TokenList({ readProvider, refreshKey }: Props) {
  const [page, setPage] = useState(0);
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  const factory = useMemo(
    () => factoryContract(FACTORY_ADDRESS, readProvider),
    [readProvider],
  );

  const load = useCallback(
    async (p: number) => {
      setState({ kind: "loading" });
      try {
        const { entries, total } = await getTokensNewestFirst(factory, p, PAGE_SIZE);
        const rows = await Promise.all(
          entries.map((e) => getTokenDetails(readProvider, e)),
        );
        setState({ kind: "ready", rows, total });
      } catch (e: unknown) {
        setState({
          kind: "error",
          message: e instanceof Error ? e.message : String(e),
        });
      }
    },
    [factory, readProvider],
  );

  useEffect(() => {
    void load(page);
  }, [load, page, refreshKey]);

  const totalPages =
    state.kind === "ready" ? Math.max(1, Math.ceil(state.total / PAGE_SIZE)) : 1;

  return (
    <section className="card" aria-labelledby="lp-registry-title">
      <div className="card-head">
        <div className="card-head-main">
          <h2 className="card-title" id="lp-registry-title">
            Token registry
          </h2>
          <span className="card-head-sub">Every coin launched through the official factory, newest first.</span>
        </div>
        {state.kind === "ready" && (
          <span className="count mono">
            {state.total} token{state.total === 1 ? "" : "s"}
          </span>
        )}
      </div>

      {state.kind === "loading" && (
        <div className="state-block" role="status">
          <span className="spinner" />
          Reading the on-chain registry…
        </div>
      )}

      {state.kind === "error" && (
        <div className="state-block" role="alert">
          <div className="headline">Could not reach the network</div>
          <div className="state-detail">{state.message}</div>
          <button className="btn btn-sm" onClick={() => void load(page)}>
            Retry
          </button>
        </div>
      )}

      {state.kind === "ready" && state.rows.length === 0 && (
        <div className="state-block">
          <div className="headline">No tokens launched yet</div>
          <div>Be the first — launch a coin from the other tab.</div>
        </div>
      )}

      {state.kind === "ready" && state.rows.length > 0 && (
        <>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Token</th>
                  <th>Trust</th>
                  <th>Creator</th>
                  <th>Created</th>
                  <th className="num">Supply</th>
                </tr>
              </thead>
              <tbody>
                {state.rows.map((t) => {
                  const b = trustBadges(t);
                  return (
                    <tr key={t.token}>
                      <td>
                        <div className="token-name">
                          <a href={explorerAddressUrl(t.token)} target="_blank" rel="noreferrer">
                            {t.name}
                          </a>
                        </div>
                        <div className="token-symbol">
                          <span className="mono">{t.symbol}</span> · <span className="mono">{shortAddress(t.token)}</span>
                        </div>
                      </td>
                      <td>
                        <div className="badges">
                          {b.factoryVerified && <span className="badge verified">Factory verified</span>}
                          {b.renounced && <span className="badge renounced">Ownership renounced</span>}
                          {b.fixedSupply && <span className="badge fixed">Fixed supply</span>}
                        </div>
                      </td>
                      <td>
                        <a href={explorerAddressUrl(t.creator)} target="_blank" rel="noreferrer">
                          <span className="mono">{shortAddress(t.creator)}</span>
                        </a>
                      </td>
                      <td className="num mono">{new Date(t.createdAt * 1000).toISOString().slice(0, 10)}</td>
                      <td className="num mono">
                        {formatAmount(t.totalSupply, t.decimals)}
                        <div className="token-symbol">
                          {t.maxSupply === 0n
                            ? t.mintable
                              ? "uncapped"
                              : "fixed"
                            : `cap ${formatAmount(t.maxSupply, t.decimals)}`}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="pager">
            <button className="btn btn-sm" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
              ← Newer
            </button>
            <span className="page-ind mono">
              Page {page + 1} of {totalPages}
            </span>
            <button className="btn btn-sm" disabled={page + 1 >= totalPages} onClick={() => setPage((p) => p + 1)}>
              Older →
            </button>
          </div>
        </>
      )}
    </section>
  );
}
