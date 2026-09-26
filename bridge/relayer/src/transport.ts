// Signature transport: how an attestation gets from a validator to a submitter.
//
// Deliberately boring. There is no gossip network, no consensus layer and no
// message bus, because none of those would add security — a signature is either
// valid against a locally computed digest or it is garbage, and no transport can
// change that. What the transport must do is be trivially auditable and run in a
// DMZ without a broker.
//
// Two modes, usable together:
//
//   http        each validator serves GET /signatures?transferId=… on its own
//               host, under its own control. The submitter polls the
//               validators it is configured for. This is the multi-party mode:
//               validator 1, 2 and 3 are three machines with three custodians,
//               and the submitter has no key material of theirs at all.
//               The relayer speaks PLAIN HTTP (http.ts is node:http only): it
//               does not terminate TLS itself. A peer across the public
//               internet must be reached over a tunnel (WireGuard) or through
//               a TLS terminator in front of its port — otherwise the peer
//               bearer token and every /status and /transfers answer cross
//               the wire in cleartext. A signature itself needs no secrecy.
//
//   shared-dir  each validator writes <dir>/<transferId>/<signer>.json. Fine for
//               a single-operator deployment (all roles, one host or one NFS
//               mount) and for local tests. NOT a substitute for separation of
//               control: if one operator can write every file in that directory,
//               M-of-N is theatre. Documented as such in the README.
//
// Whatever the mode, the submitter re-derives the digest and recovers the signer
// itself. `signer` in the payload is a hint for logging, never an authority.

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAddress } from 'ethers';
import type { PeerConfig } from './config.ts';
import type { Logger } from './logger.ts';
import { digestFor, parseTransfer, recoverSigner, serializeTransfer, transferIdOf, type BridgeTransfer } from './transfer.ts';

export interface SignaturePayload {
  transferId: string;
  signer: string;
  signature: string;
  digest: string;
  transfer: Record<string, string | number>;
  signedAt: number;
}

export function buildPayload(
  transfer: BridgeTransfer,
  transferId: string,
  digest: string,
  signer: string,
  signature: string,
): SignaturePayload {
  return {
    transferId,
    signer: getAddress(signer),
    signature,
    digest,
    transfer: serializeTransfer(transfer),
    signedAt: Date.now(),
  };
}

/**
 * Validate an untrusted signature payload against a transfer THIS node already
 * believes in, and against a bridge address from THIS node's config.
 *
 * Returns the recovered signer on success. Throws with a precise reason on any
 * mismatch — the caller turns that into a signature_mismatch alert.
 */
export function verifyPayload(
  payload: unknown,
  expected: { transferId: string; transfer: BridgeTransfer; dstBridgeAddress: string },
): { signer: string; signature: string } {
  if (!payload || typeof payload !== 'object') throw new Error('payload is not an object');
  const p = payload as Record<string, unknown>;

  if (typeof p.signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(p.signature)) {
    throw new Error('signature is not a 65-byte hex string');
  }
  if (typeof p.transferId !== 'string' || p.transferId.toLowerCase() !== expected.transferId.toLowerCase()) {
    throw new Error(`transferId ${String(p.transferId)} is not the one requested`);
  }

  // The peer's copy of the transfer must be byte-identical to ours. If a peer
  // sends a *different* transfer under the same id, the id itself is broken and
  // that is a critical finding, not a retry.
  const theirs = parseTransfer(p.transfer);
  const theirId = transferIdOf(theirs);
  if (theirId.toLowerCase() !== expected.transferId.toLowerCase()) {
    throw new Error(`peer's transfer hashes to ${theirId}, not ${expected.transferId}`);
  }
  for (const [k, v] of Object.entries(serializeTransfer(expected.transfer))) {
    const mine = String(v);
    const other = String((serializeTransfer(theirs) as Record<string, string | number>)[k]);
    if (mine !== other) throw new Error(`peer's transfer.${k} = ${other}, ours = ${mine}`);
  }

  // Recompute the digest locally. Never use p.digest for anything but a log.
  const digest = digestFor(expected.transfer, expected.dstBridgeAddress);
  if (typeof p.digest === 'string' && p.digest.toLowerCase() !== digest.toLowerCase()) {
    throw new Error(`peer signed digest ${p.digest}, we compute ${digest}`);
  }
  const signer = recoverSigner(digest, p.signature);
  if (typeof p.signer === 'string' && getAddress(p.signer) !== signer) {
    throw new Error(`payload claims signer ${p.signer}, signature recovers to ${signer}`);
  }
  return { signer, signature: p.signature };
}

// ------------------------------------------------------------------ shared dir

export class SharedDirTransport {
  private readonly dir: string;
  private readonly log: Logger;

  constructor(dir: string, log: Logger) {
    this.dir = dir;
    this.log = log.child({ component: 'transport', mode: 'shared-dir' });
    mkdirSync(dir, { recursive: true });
  }

  publish(payload: SignaturePayload): void {
    const dir = join(this.dir, payload.transferId);
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `.${payload.signer}.tmp`);
    const final = join(dir, `${payload.signer}.json`);
    writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o644 });
    // Rename is atomic on the same filesystem: a reader never sees half a file.
    renameSync(tmp, final);
    this.log.debug('signature published to shared dir', { transferId: payload.transferId, file: final });
  }

  collect(transferId: string): unknown[] {
    const dir = join(this.dir, transferId);
    if (!existsSync(dir)) return [];
    const out: unknown[] = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      try {
        out.push(JSON.parse(readFileSync(join(dir, name), 'utf8')));
      } catch (err) {
        this.log.warn('unreadable signature file', { file: join(dir, name), err: (err as Error).message });
      }
    }
    return out;
  }
}

// ----------------------------------------------------------------------- http

export class HttpTransport {
  private readonly peers: PeerConfig[];
  private readonly timeoutMs: number;
  private readonly log: Logger;

  constructor(peers: PeerConfig[], timeoutMs: number, log: Logger) {
    this.peers = peers;
    this.timeoutMs = timeoutMs;
    this.log = log.child({ component: 'transport', mode: 'http' });
  }

  get peerCount(): number {
    return this.peers.length;
  }

  /** Ask every peer for their signature over one transfer. Failures are logged, not thrown. */
  async collect(transferId: string): Promise<Array<{ peer: string; payload: unknown }>> {
    const results = await Promise.all(
      this.peers.map(async (peer) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
          const headers: Record<string, string> = { accept: 'application/json' };
          if (peer.token) headers.authorization = `Bearer ${peer.token}`;
          const res = await fetch(`${peer.url}/signatures?transferId=${encodeURIComponent(transferId)}`, {
            headers,
            signal: controller.signal,
          });
          if (res.status === 404) return null; // not signed yet, or refused — /status says which
          if (!res.ok) {
            this.log.warn('peer returned an error', { peer: peer.name, status: res.status });
            return null;
          }
          const body = (await res.json()) as { signatures?: unknown[] };
          const list = Array.isArray(body.signatures) ? body.signatures : [body];
          return list.map((payload) => ({ peer: peer.name, payload }));
        } catch (err) {
          this.log.warn('peer unreachable', { peer: peer.name, err: (err as Error).message });
          return null;
        } finally {
          clearTimeout(timer);
        }
      }),
    );
    return results.flatMap((r) => r ?? []);
  }

  /** Peer liveness for /health. */
  async ping(): Promise<Array<{ peer: string; ok: boolean; detail: string }>> {
    return Promise.all(
      this.peers.map(async (peer) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
          const res = await fetch(`${peer.url}/health`, { signal: controller.signal });
          return { peer: peer.name, ok: res.ok, detail: `HTTP ${res.status}` };
        } catch (err) {
          return { peer: peer.name, ok: false, detail: (err as Error).message };
        } finally {
          clearTimeout(timer);
        }
      }),
    );
  }
}
