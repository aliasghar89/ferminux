// Human-readable calldata for the confirm screen. A short list of the calls
// Ferminux dApps actually make (tokens, the DEX router, WFMX, the launchpad,
// the agent registry, escrow and the NFT collection); anything else is shown
// as its 4-byte selector and size, never guessed at.
// No browser globals: the Node tests import this file directly.

import { Interface, MaxUint256, type Result } from 'ethers';

const FRAGMENTS = [
  // FRC-20 / FRC-721 (approve and transferFrom share selectors across the two;
  // the confirm screen asks the contract for decimals() to tell them apart)
  'function transfer(address to, uint256 amount)',
  'function approve(address spender, uint256 amount)',
  // increaseAllowance grants exactly what approve does; a drainer uses it to
  // dodge a wallet that only recognises approve() as an allowance grant.
  'function increaseAllowance(address spender, uint256 addedValue)',
  'function transferFrom(address from, address to, uint256 amount)',
  'function setApprovalForAll(address operator, bool approved)',
  'function safeTransferFrom(address from, address to, uint256 tokenId)',
  'function safeTransferFrom(address from, address to, uint256 tokenId, bytes data)',
  // WFMX
  'function deposit()',
  'function withdraw(uint256 amount)',
  // DEX router
  'function swapExactFMXForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline)',
  'function swapExactTokensForFMX(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)',
  'function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)',
  'function addLiquidity(address tokenA, address tokenB, uint256 amountADesired, uint256 amountBDesired, uint256 amountAMin, uint256 amountBMin, uint256 minLiquidity, address to, uint256 deadline)',
  'function addLiquidityFMX(address token, uint256 amountTokenDesired, uint256 amountTokenMin, uint256 amountFMXMin, uint256 minLiquidity, address to, uint256 deadline)',
  'function removeLiquidity(address tokenA, address tokenB, uint256 liquidity, uint256 amountAMin, uint256 amountBMin, address to, uint256 deadline)',
  'function removeLiquidityFMX(address token, uint256 liquidity, uint256 amountTokenMin, uint256 amountFMXMin, address to, uint256 deadline)',
  'function createPair(address tokenA, address tokenB)',
  // Launchpad
  'function launch(string name, string symbol, uint8 decimals, uint256 initialSupply, uint256 maxSupply, bool mintable)',
  // Agent registry / escrow / Ferminux Agents collection
  'function register(string name, string endpoint, string metadataURI, uint256 pricePerJob)',
  'function requestJob(uint256 agentId, bytes32 inputHash, string inputURI)',
  'function release(uint256 jobId, uint8 rating)',
  'function dispute(uint256 jobId)',
  'function mint(uint256 tokenId)',
];

const IFACE = new Interface(FRAGMENTS);

export interface DecodedArg {
  name: string;
  type: string;
  /** Display string: addresses checksummed, numbers in base 10, bytes as hex. */
  value: string;
  raw: unknown;
}

export interface DecodedCall {
  name: string;
  signature: string;
  selector: string;
  args: DecodedArg[];
}

function show(v: unknown): string {
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(show).join(', ');
  return String(v);
}

/** Decode known calldata; null when the selector is not in the table or the bytes do not fit it. */
export function decodeCalldata(data: string): DecodedCall | null {
  if (typeof data !== 'string' || data.length < 10) return null;
  let parsed: ReturnType<Interface['parseTransaction']>;
  try {
    parsed = IFACE.parseTransaction({ data });
  } catch {
    return null;
  }
  if (!parsed) return null;
  const args: DecodedArg[] = parsed.fragment.inputs.map((input, i) => {
    const raw = (parsed!.args as Result)[i];
    const plain = raw && typeof (raw as Result).toArray === 'function' ? (raw as Result).toArray() : raw;
    return { name: input.name, type: input.type, value: show(plain), raw: plain };
  });
  return { name: parsed.name, signature: parsed.signature, selector: parsed.selector, args };
}

export function selectorOf(data: string): string | null {
  return /^0x[0-9a-fA-F]{8}/.test(data) ? data.slice(0, 10).toLowerCase() : null;
}

/** An approval this large is effectively "everything, forever". */
export function isUnlimited(amount: bigint): boolean {
  return amount >= MaxUint256 / 2n;
}
