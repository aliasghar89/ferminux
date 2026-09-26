/* ABI data for the address pages (surfaces/explorer.md §5.6 Events, §5.7 Contract tab).
   - The contract book: ./book/<address>.json per Ferminux contract (ABI, compiler, sources, the keccak256 of
     the normalised deployed bytecode), one lazy chunk each, written by scripts/contract-book.mjs from the repo's Foundry
     artifacts. ./book/tpl-*.json are templates for factory-made contracts (agent tokens).
   - ./book/selectors.json names a method or an event without loading a contract's JSON or ethers.
   - ethers loads lazily (its own chunk), only for ABI encoding/decoding and the bytecode hash.
   Also used by the contracts list (codes.json, matchesBuild). The tx page decodes with src/enrich/decode.ts. */
import { lc } from "../../util";

export type AbiParam = { name: string; type: string; internalType?: string; indexed?: boolean; components?: AbiParam[] };
export type AbiItem = { type: string; name?: string; inputs?: AbiParam[]; outputs?: AbiParam[]; stateMutability?: string; anonymous?: boolean };

export interface BookData {
  name: string;
  address?: string;
  template?: boolean;
  contract: string;
  project: string;
  compiler: { solc: string; optimizer: boolean; runs: number | null; evm: string | null };
  abi: AbiItem[];
  code: { keccak: string; bytes: number; immutables: [number, number][] };
  sources: Record<string, string>;
}

const files = import.meta.glob<BookData>(["./book/0x*.json", "./book/tpl-*.json"], { import: "default" });
const key = (a: string) => `./book/${lc(a)}.json`;

/** True when the repository build of this address is in the book (no request). */
export const inBook = (addr: string) => key(addr) in files;
/** The book entry for an address (a lazy chunk), or null. */
export const bookData = (addr: string): Promise<BookData | null> => (files[key(addr)] ? files[key(addr)]() : Promise.resolve(null));
/** A template (factory-made contracts): "agenttoken". */
export const templateData = (name: string): Promise<BookData | null> => (files[`./book/tpl-${name}.json`] ? files[`./book/tpl-${name}.json`]() : Promise.resolve(null));

/* ---------------------------------------------------------------- names without ethers */

type Sel = { fn: Record<string, string>; ev: Record<string, string> };
let selP: Promise<Sel> | null = null;
/** The selector map (a ~8 KB gz chunk), loaded after first paint. */
export const selectors = () => (selP ??= import("./book/selectors.json").then((m) => (m.default ?? m) as Sel));

/* ---------------------------------------------------------------- ethers, lazily */

type Ethers = typeof import("./eth");
let eth: Promise<Ethers> | null = null;
export const ethers = () => (eth ??= import("./eth"));

/** Zero the immutable ranges and drop the CBOR metadata tail (its length is the last two bytes): the same
 *  normalisation scripts/contract-book.mjs applied to the repository build. */
export function normaliseCode(hex: string, ranges: [number, number][]): string {
  const h = hex.replace(/^0x/, "").toLowerCase().split("");
  for (const [start, len] of ranges) for (let i = start * 2; i < (start + len) * 2 && i < h.length; i++) h[i] = "0";
  const s = h.join("");
  const n = parseInt(s.slice(-4), 16);
  const cut = s.length - (n + 2) * 2;
  return "0x" + (Number.isFinite(n) && cut > 0 ? s.slice(0, cut) : s);
}
/** Does the deployed code equal the repository build (modulo immutables and the metadata hash)? */
export async function codeMatches(book: BookData, code: string): Promise<boolean> {
  if (!code || code === "0x") return false;
  if ((code.length - 2) / 2 !== book.code.bytes) return false;
  const { keccak256 } = await ethers();
  return keccak256(normaliseCode(code, book.code.immutables)) === book.code.keccak;
}

/** The bytecode fingerprints of every book contract (./book/codes.json, ~2 KB gz), for list pages. */
type Fingerprint = { name: string; keccak: string; bytes: number; immutables: [number, number][] };
let fpP: Promise<Record<string, Fingerprint>> | null = null;
const fingerprints = () => (fpP ??= import("./book/codes.json").then((m) => (m.default ?? m) as unknown as Record<string, Fingerprint>));
/**
 * "Matches build" for a list: true / false when the book has this address, null when it doesn't. Hashes with the
 * small keccak in enrich/checksum.ts (≈ 3 ms per 11 KB), so no ethers chunk is loaded.
 */
export async function matchesBuild(addr: string, code: string | null): Promise<boolean | null> {
  const fp = (await fingerprints())[lc(addr)];
  if (!fp) return null;
  if (!code || code === "0x" || (code.length - 2) / 2 !== fp.bytes) return false;
  const { keccak256 } = await import("../../enrich/checksum");
  const hex = normaliseCode(code, fp.immutables).slice(2);
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return "0x" + keccak256(bytes) === fp.keccak.toLowerCase();
}

/** EIP-1167 minimal proxy: the implementation address, or null. */
export function cloneTarget(code: string | null | undefined): string | null {
  const m = (code ?? "").toLowerCase().match(/^0x363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3$/);
  return m ? "0x" + m[1] : null;
}

/* ---------------------------------------------------------------- the generic sets (unknown contracts) */

/** FRC-20 reads and events, for a token contract that isn't in the book. */
export const FRC20: string[] = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "event Approval(address indexed owner, address indexed spender, uint256 value)",
];
/** FRC-721 reads and events. */
export const FRC721: string[] = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function tokenURI(uint256 tokenId) view returns (string)",
  "function getApproved(uint256 tokenId) view returns (address)",
  "function isApprovedForAll(address owner, address operator) view returns (bool)",
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
  "event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId)",
  "event ApprovalForAll(address indexed owner, address indexed operator, bool approved)",
];
/** WFMX and DEX pair events, the other half of the generic event set (§6.4 rules). */
export const EXTRA_EVENTS: string[] = [
  "event Deposit(address indexed dst, uint256 wad)",
  "event Withdrawal(address indexed src, uint256 wad)",
  "event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)",
  "event Sync(uint112 reserve0, uint112 reserve1)",
  "event Mint(address indexed sender, uint256 amount0, uint256 amount1)",
  "event Burn(address indexed sender, uint256 amount0, uint256 amount1, address indexed to)",
];
