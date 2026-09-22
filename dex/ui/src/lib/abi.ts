// ---------------------------------------------------------------------------
// Every contract surface the app touches, in one file.
//
// Copied from dex/contracts/src/interfaces/IFerminuxDex.sol, FerminuxRouter.sol,
// FerminuxFactory.sol and LiquidityLocker.sol. Only the methods the UI actually
// calls are listed — an ABI entry that is never used is an ABI entry that can
// silently rot.
//
// No browser globals: this module is imported unchanged by the e2e suite.
// ---------------------------------------------------------------------------

export const ERC20_ABI = [
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 value) returns (bool)',
] as const;

export const FACTORY_ABI = [
  'function INIT_CODE_PAIR_HASH() pure returns (bytes32)',
  'function feeTo() view returns (address)',
  'function feeToSetter() view returns (address)',
  'function getPair(address tokenA, address tokenB) view returns (address)',
  'function allPairs(uint256 index) view returns (address)',
  'function allPairsLength() view returns (uint256)',
  'function pairsPage(uint256 offset, uint256 limit) view returns (address[])',
  'function predictPairAddress(address tokenA, address tokenB) view returns (address)',
  'function createPair(address tokenA, address tokenB) returns (address)',
] as const;

export const PAIR_ABI = [
  'function factory() view returns (address)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 value) returns (bool)',
  'function MINIMUM_LIQUIDITY() pure returns (uint256)',
  'function decimals() pure returns (uint8)',
  'function symbol() pure returns (string)',
] as const;

export const ROUTER_ABI = [
  'function factory() view returns (address)',
  'function WFMX() view returns (address)',

  // pricing views
  'function quote(uint256 amountA, uint256 reserveA, uint256 reserveB) pure returns (uint256)',
  'function getAmountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut) pure returns (uint256)',
  'function getAmountIn(uint256 amountOut, uint256 reserveIn, uint256 reserveOut) pure returns (uint256)',
  'function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[])',
  'function getAmountsIn(uint256 amountOut, address[] path) view returns (uint256[])',
  'function pairFor(address tokenA, address tokenB) view returns (address)',
  'function getReserves(address tokenA, address tokenB) view returns (uint256 reserveA, uint256 reserveB)',

  // liquidity — the trailing `minLiquidity` is the fewest LP tokens the caller
  // will accept, enforced by the router against the LP actually delivered. It
  // stops a hostile token from handing over dust LP while pocketing the paired
  // asset; the UI sets it from the expected LP less the user's slippage.
  'function addLiquidity(address tokenA, address tokenB, uint256 amountADesired, uint256 amountBDesired, uint256 amountAMin, uint256 amountBMin, uint256 minLiquidity, address to, uint256 deadline) returns (uint256 amountA, uint256 amountB, uint256 liquidity)',
  'function addLiquidityFMX(address token, uint256 amountTokenDesired, uint256 amountTokenMin, uint256 amountFMXMin, uint256 minLiquidity, address to, uint256 deadline) payable returns (uint256 amountToken, uint256 amountFMX, uint256 liquidity)',
  // Fee-on-transfer variants. The UI's add-liquidity flow NEVER calls these —
  // they exist for tokens that tax their own transfers, and they are listed
  // here only so the ABI is complete. They measure what the pool actually
  // received and take a mandatory `maxFeeBps` (the largest transfer tax the
  // caller accepts, hard-capped at 20% by the contract): a token that credits
  // dust instead of the amount sent makes the whole deposit revert, and the
  // counter-asset leg is sized to the measured arrival so it cannot be donated.
  // Any future caller MUST still pass an honest `maxFeeBps` (the token's real
  // tax, not a generous guess) and a non-zero `minLiquidity` (expected LP net
  // of the tax, less slippage) — the declared fee is the most a hostile token
  // can cost the depositor.
  'function addLiquiditySupportingFeeOnTransferTokens(address tokenA, address tokenB, uint256 amountADesired, uint256 amountBDesired, uint256 amountAMin, uint256 amountBMin, uint256 maxFeeBps, uint256 minLiquidity, address to, uint256 deadline) returns (uint256 liquidity)',
  'function addLiquidityFMXSupportingFeeOnTransferTokens(address token, uint256 amountTokenDesired, uint256 amountTokenMin, uint256 amountFMXMin, uint256 maxFeeBps, uint256 minLiquidity, address to, uint256 deadline) payable returns (uint256 liquidity)',
  'function removeLiquidity(address tokenA, address tokenB, uint256 liquidity, uint256 amountAMin, uint256 amountBMin, address to, uint256 deadline) returns (uint256 amountA, uint256 amountB)',
  'function removeLiquidityFMX(address token, uint256 liquidity, uint256 amountTokenMin, uint256 amountFMXMin, address to, uint256 deadline) returns (uint256 amountToken, uint256 amountFMX)',

  // swaps (exact-input paths only — the UI never quotes an exact-output swap)
  'function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[])',
  'function swapExactFMXForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable returns (uint256[])',
  'function swapExactTokensForFMX(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[])',
] as const;

export const WFMX_ABI = [
  'function deposit() payable',
  'function withdraw(uint256 wad)',
  'function balanceOf(address owner) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
] as const;

export const LOCKER_ABI = [
  'function lockCount() view returns (uint256)',
  'function getLock(uint256 id) view returns (tuple(uint256 id, address token, address owner, uint256 amount, uint64 lockedAt, uint64 unlockAt, bool withdrawn))',
  'function isWithdrawable(uint256 id) view returns (bool)',
  'function locksForToken(address token) view returns (tuple(uint256 id, address token, address owner, uint256 amount, uint64 lockedAt, uint64 unlockAt, bool withdrawn)[])',
  'function lockCountForToken(address token) view returns (uint256)',
  'function locksForTokenPage(address token, uint256 offset, uint256 limit) view returns (tuple(uint256 id, address token, address owner, uint256 amount, uint64 lockedAt, uint64 unlockAt, bool withdrawn)[])',
  'function locksForOwner(address owner) view returns (tuple(uint256 id, address token, address owner, uint256 amount, uint64 lockedAt, uint64 unlockAt, bool withdrawn)[])',
  'function totalLockedForToken(address token) view returns (uint256)',
  'function totalLockedForTokenAt(address token, uint64 timestamp) view returns (uint256)',
] as const;
