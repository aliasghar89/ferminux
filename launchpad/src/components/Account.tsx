// The connected wallet in the header, as the DEX shows it: a status dot and the
// short address; the menu holds the full address, an explorer link, copy and
// Disconnect. The dot turns coral while the wallet is on another network.

import { useEffect, useRef, useState } from "react";
import { explorerAddressUrl } from "../config.ts";
import { shortAddress } from "../lib/factory.ts";
import { IconCheck, IconChevronDown, IconExternal, IconPower } from "./icons.tsx";

export default function Account({
  address,
  wrongChain,
  walletName,
  onDisconnect,
}: {
  address: string;
  wrongChain: boolean;
  /** The connected wallet's name from the picker (Ferminux Wallet, MetaMask, WalletConnect). */
  walletName: string | null;
  onDisconnect: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard refused: the full address is on screen to select */
    }
  };

  return (
    <div className="acct" ref={ref}>
      <button
        className="acct-trigger"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((v) => !v)}
        data-testid="acct-trigger"
        title={wrongChain ? "Your wallet is on another network" : "Connected to Ferminux"}
      >
        <span className={"dot " + (wrongChain ? "dot-bad" : "dot-ok")} aria-hidden="true" />
        <span className="mono acct-addr">{shortAddress(address)}</span>
        <IconChevronDown />
      </button>
      {open && (
        <div className="acct-menu" role="menu">
          <div className="acct-menu-head">
            <span className="label">Connected{walletName ? ` · ${walletName}` : ""}</span>
            <div className="acct-menu-addr mono">{address}</div>
            <div className="acct-menu-row">
              <button className="btn btn-ghost btn-sm" onClick={() => void copy()}>
                {copied ? (
                  <span className="ok-text">
                    <IconCheck /> Copied
                  </span>
                ) : (
                  "Copy address"
                )}
              </button>
              <a className="btn btn-ghost btn-sm" href={explorerAddressUrl(address)} target="_blank" rel="noreferrer noopener">
                Explorer <IconExternal />
              </a>
            </div>
          </div>
          <button
            className="acct-menu-item acct-menu-danger"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onDisconnect();
            }}
          >
            <IconPower /> Disconnect
          </button>
        </div>
      )}
    </div>
  );
}
