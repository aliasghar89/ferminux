// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20, IFerminuxFactory, IFerminuxPair, IWFMX} from "./interfaces/IFerminuxDex.sol";
import {FerminuxLibrary} from "./libraries/FerminuxLibrary.sol";
import {TransferHelper} from "./libraries/TransferHelper.sol";

/**
 * @title FerminuxRouter
 * @notice The contract users actually call. The pair is deliberately dumb — it
 *         trusts whatever balance shows up — so all of the safety lives here:
 *
 *           deadline  — every function reverts after `deadline`, so a
 *                       transaction that sat in the mempool through a price
 *                       move cannot be executed at the stale price.
 *           slippage  — every function takes a bound (`amountOutMin`,
 *                       `amountInMax`, `amountAMin`/`amountBMin`) and reverts
 *                       rather than settle outside it.
 *
 *         Native FMX is handled by wrapping/unwrapping through WFMX; any FMX
 *         left over after an add-liquidity or exact-output swap is refunded in
 *         the same transaction.
 *
 *         A Solidity-0.8 port of the proven Uniswap-v2 router; the pricing math
 *         lives in FerminuxLibrary and is unchanged.
 *
 * @dev The router holds no funds between transactions. Anything sent to it
 *      outside a call is a donation and can be swept by anyone.
 */
contract FerminuxRouter {
    address public immutable factory;
    address public immutable WFMX;

    /// @notice Hard cap on the transfer-tax allowance a caller may declare on
    ///         the SupportingFeeOnTransferTokens add-liquidity paths: 20%.
    ///         The declared allowance is the most a hostile token can cost the
    ///         depositor, so it is bounded in the contract — no caller-supplied
    ///         value can widen it back to a full skim. Honest tax tokens run
    ///         single-digit percentages; anything above 20% has no business on
    ///         a liquidity deposit.
    uint256 public constant MAX_DECLARED_FEE_BPS = 2000;
    uint256 private constant BPS = 10_000;

    modifier ensure(uint256 deadline) {
        require(deadline >= block.timestamp, "ROUTER: expired");
        _;
    }

    constructor(address _factory, address _WFMX) {
        require(_factory != address(0) && _WFMX != address(0), "ROUTER: zero address");
        factory = _factory;
        WFMX = _WFMX;
    }

    /// @dev Only accept native FMX from the wrapper (i.e. from `withdraw`).
    ///      Anything else would be an accidental transfer.
    receive() external payable {
        require(msg.sender == WFMX, "ROUTER: only WFMX");
    }

    // =====================================================================
    //                            ADD LIQUIDITY
    // =====================================================================
    //
    // Why every add-liquidity entry point takes an explicit `minLiquidity` and
    // measures the LP it actually delivered.
    //
    //   The pair is deliberately dumb: `mint` credits LP for whatever token
    //   balance shows up, and it only guards `require(liquidity > 0)`. A hostile
    //   token that is one side of a pair can satisfy that guard with 2 wei of
    //   dust while contributing almost nothing to its own reserve side, so a
    //   depositor's counter-asset — an honest ERC-20, or real native FMX — is
    //   fully deposited yet the depositor walks away with worthless dust LP.
    //   The value is left in the pool for the attacker, who already holds LP, to
    //   withdraw. This is inherited vanilla-Uniswap-v2 behaviour and it bites
    //   hardest on a permissionless launchpad, where anyone can deploy a token
    //   and invite people to pair it against FMX.
    //
    //   The router closes it in layers, none of which trusts a value the pair
    //   or the token returns:
    //
    //     1. minLiquidity — the caller states the fewest LP tokens they will
    //        accept, and the router enforces it against the RECIPIENT's LP
    //        balance measured across the mint (a delta, never the pair's return
    //        value, never a token-supplied balance). The UI sets this to the
    //        expected LP less the user's slippage. Complete on its own.
    //
    //     2. proportional floor (plain paths) — for a deposit into an existing
    //        pool the router also computes, from the honest stored reserves and
    //        supply taken BEFORE any token moves, the LP a fair deposit at the
    //        pool ratio must mint, and requires the delivered LP to reach it.
    //        This catches a caller who passes minLiquidity == 0. A token that
    //        under-delivers its side (a fee-on-transfer token, or one skimming
    //        the counter-asset) trips it; such tokens must use the
    //        SupportingFeeOnTransfer variants.
    //
    //     3. measured floors (SupportingFeeOnTransfer paths) — a floor computed
    //        from the amounts SENT would reject every honest fee-on-transfer
    //        deposit, but dropping the floor entirely would reopen the theft
    //        through these entry points for anyone who passes minLiquidity == 0.
    //        So these paths measure what the pair ACTUALLY RECEIVED (the pair's
    //        balance delta across each transfer) and enforce, with no trust in
    //        any caller-supplied zero:
    //
    //          a. maxFeeBps — the caller DECLARES the largest transfer tax the
    //             token is expected to take, hard-capped at MAX_DECLARED_FEE_BPS.
    //             Each side must deliver at least (1 - maxFeeBps) of what was
    //             sent, or the whole deposit reverts. A token that credits 2 wei
    //             of dust can never clear this, whatever the caller passed.
    //          b. sized counter-asset — the second side is re-quoted from the
    //             FIRST side's measured arrival, so the counter-asset sent can
    //             never exceed the pool-ratio value of what the first token
    //             actually credited. An under-delivering first token shrinks
    //             the deposit instead of donating the counter-asset.
    //          c. measured proportional floor — expected LP is computed from the
    //             measured arrivals against the honest pre-transfer reserves and
    //             supply, and enforced on the recipient's LP delta. A token that
    //             shows the router one balance and the pair's mint another is
    //             caught here and the deposit reverts.
    //
    //        Worst case by construction: a hostile token that stays inside the
    //        declared fee allowance can cost the depositor at most maxFeeBps of
    //        the deposit — the bound the caller explicitly signed — never the
    //        whole counter-asset.

    /// @dev Work out the two amounts that keep the pool ratio intact, creating
    ///      the pair if it does not exist yet. Returns those amounts and, for an
    ///      existing pool, `expectedLiquidity` — the LP a fair deposit of them
    ///      mints at the current ratio (0 for the first deposit into an empty
    ///      pool, where there is no ratio to be short of).
    function _addLiquidity(
        address tokenA,
        address tokenB,
        uint256 amountADesired,
        uint256 amountBDesired,
        uint256 amountAMin,
        uint256 amountBMin
    ) internal returns (uint256 amountA, uint256 amountB, uint256 expectedLiquidity) {
        if (IFerminuxFactory(factory).getPair(tokenA, tokenB) == address(0)) {
            IFerminuxFactory(factory).createPair(tokenA, tokenB);
        }
        (uint256 reserveA, uint256 reserveB) = FerminuxLibrary.getReserves(factory, tokenA, tokenB);
        if (reserveA == 0 && reserveB == 0) {
            // Empty pool: the depositor sets the price. expectedLiquidity stays
            // 0 — there is no pool ratio to fall short of, and the depositor
            // holds ~100% of the LP, so there is no counter-party to skim to.
            (amountA, amountB) = (amountADesired, amountBDesired);
        } else {
            uint256 amountBOptimal = FerminuxLibrary.quote(amountADesired, reserveA, reserveB);
            if (amountBOptimal <= amountBDesired) {
                require(amountBOptimal >= amountBMin, "ROUTER: insufficient B amount");
                (amountA, amountB) = (amountADesired, amountBOptimal);
            } else {
                uint256 amountAOptimal = FerminuxLibrary.quote(amountBDesired, reserveB, reserveA);
                require(amountAOptimal <= amountADesired, "ROUTER: excessive A amount");
                require(amountAOptimal >= amountAMin, "ROUTER: insufficient A amount");
                (amountA, amountB) = (amountAOptimal, amountBDesired);
            }
            // FerminuxPair.mint credits min(amountA·supply/reserveA,
            // amountB·supply/reserveB). Computed here from the honest stored
            // reserves and supply — a token cannot fake either (only _update, on
            // a settled pool op, moves them) — this is the LP a well-behaved
            // deposit at the ratio mints exactly. A protocol-fee mint inside
            // `mint` only raises the supply the depositor mints against, so the
            // delivered LP is never below this floor for an honest deposit.
            uint256 supply = IFerminuxPair(FerminuxLibrary.pairFor(factory, tokenA, tokenB)).totalSupply();
            uint256 fromA = amountA * supply / reserveA;
            uint256 fromB = amountB * supply / reserveB;
            expectedLiquidity = fromA < fromB ? fromA : fromB;
        }
    }

    /// @dev Pull both tokens into `pair`, mint, and enforce the floors. Split out
    ///      of the entry points to keep their stack shallow. `balanceBefore` is
    ///      captured before either transfer so the delivered-LP delta counts
    ///      every LP `to` gained during the whole operation — a reentrant mint
    ///      that credited `to` mid-transfer cannot be used to slip past the check.
    function _depositTokens(
        address tokenA,
        address tokenB,
        uint256 amountA,
        uint256 amountB,
        address to,
        uint256 minLiquidity,
        uint256 expected
    ) internal returns (uint256 liquidity) {
        address pair = FerminuxLibrary.pairFor(factory, tokenA, tokenB);
        uint256 balanceBefore = IFerminuxPair(pair).balanceOf(to);
        TransferHelper.safeTransferFrom(tokenA, msg.sender, pair, amountA);
        TransferHelper.safeTransferFrom(tokenB, msg.sender, pair, amountB);
        liquidity = _mintChecked(pair, to, balanceBefore, minLiquidity, expected);
    }

    /// @dev The native-FMX counterpart of `_depositTokens`: pull the token, wrap
    ///      `amountFMX` and forward the WFMX, then mint and enforce the floors.
    function _depositFMX(
        address token,
        uint256 amountToken,
        uint256 amountFMX,
        address to,
        uint256 minLiquidity,
        uint256 expected
    ) internal returns (uint256 liquidity) {
        address pair = FerminuxLibrary.pairFor(factory, token, WFMX);
        uint256 balanceBefore = IFerminuxPair(pair).balanceOf(to);
        TransferHelper.safeTransferFrom(token, msg.sender, pair, amountToken);
        IWFMX(WFMX).deposit{value: amountFMX}();
        require(IWFMX(WFMX).transfer(pair, amountFMX), "ROUTER: WFMX transfer failed");
        liquidity = _mintChecked(pair, to, balanceBefore, minLiquidity, expected);
    }

    /// @dev Enforce both floors against the LP the RECIPIENT actually received —
    ///      the balance delta across `mint`, which no token-supplied balance and
    ///      no pair return value can spoof.
    function _mintChecked(address pair, address to, uint256 balanceBefore, uint256 minLiquidity, uint256 expected)
        internal
        returns (uint256 liquidity)
    {
        IFerminuxPair(pair).mint(to);
        liquidity = IFerminuxPair(pair).balanceOf(to) - balanceBefore;
        require(liquidity >= minLiquidity, "ROUTER: insufficient liquidity");
        require(liquidity >= expected, "ROUTER: liquidity below pool ratio");
    }

    /// @notice Deposit both tokens and receive LP tokens.
    /// @param amountAMin/amountBMin slippage floor — revert if the pool ratio
    ///        moved enough that less than this would be deposited.
    /// @param minLiquidity the fewest LP tokens `to` will accept; the router
    ///        reverts unless the mint delivers at least this many. Set it to the
    ///        expected LP less slippage. Use 0 only if you accept any non-dust
    ///        amount — the proportional floor still applies to an existing pool.
    function addLiquidity(
        address tokenA,
        address tokenB,
        uint256 amountADesired,
        uint256 amountBDesired,
        uint256 amountAMin,
        uint256 amountBMin,
        uint256 minLiquidity,
        address to,
        uint256 deadline
    ) external ensure(deadline) returns (uint256 amountA, uint256 amountB, uint256 liquidity) {
        uint256 expected;
        (amountA, amountB, expected) =
            _addLiquidity(tokenA, tokenB, amountADesired, amountBDesired, amountAMin, amountBMin);
        liquidity = _depositTokens(tokenA, tokenB, amountA, amountB, to, minLiquidity, expected);
    }

    /// @notice Deposit a token and native FMX. Unused FMX is refunded.
    /// @param minLiquidity the fewest LP tokens `to` will accept (see addLiquidity).
    function addLiquidityFMX(
        address token,
        uint256 amountTokenDesired,
        uint256 amountTokenMin,
        uint256 amountFMXMin,
        uint256 minLiquidity,
        address to,
        uint256 deadline
    ) external payable ensure(deadline) returns (uint256 amountToken, uint256 amountFMX, uint256 liquidity) {
        uint256 expected;
        (amountToken, amountFMX, expected) =
            _addLiquidity(token, WFMX, amountTokenDesired, msg.value, amountTokenMin, amountFMXMin);
        liquidity = _depositFMX(token, amountToken, amountFMX, to, minLiquidity, expected);
        // Refund dust FMX — the pool ratio decides how much was actually used.
        // Last action, after every check has passed and all state is settled, so
        // the full-gas refund handing control to msg.sender cannot subvert it.
        if (msg.value > amountFMX) TransferHelper.safeTransferFMX(msg.sender, msg.value - amountFMX);
    }

    // ------------------------------- fee-on-transfer aware add -------------

    /// @dev Working state of a measured (fee-on-transfer aware) deposit, in a
    ///      struct to keep the entry points' stack shallow. `reserveA/B` and
    ///      `supply` are the HONEST pre-transfer values: only a settled pool op
    ///      can move them, so no token can fake either.
    struct MeasuredDeposit {
        address pair;
        uint256 reserveA;
        uint256 reserveB;
        uint256 supply;
        uint256 lpBefore;
        uint256 receivedA;
        uint256 amountBUsed;
        uint256 expected;
    }

    /// @dev Pull `amount` of `token` from the caller into `pair` and return how
    ///      much the pair's balance ACTUALLY grew — the same balance the pair's
    ///      own `mint` will read, so a token cannot overstate it here without
    ///      overstating it to the mint as well (and understating it later trips
    ///      the measured floor).
    function _transferMeasured(address token, address pair, uint256 amount) internal returns (uint256 received) {
        uint256 balanceBefore = IERC20(token).balanceOf(pair);
        TransferHelper.safeTransferFrom(token, msg.sender, pair, amount);
        received = IERC20(token).balanceOf(pair) - balanceBefore;
    }

    /// @dev Revert unless `received` is at least `sent` less the declared
    ///      transfer-tax allowance. This is the check a 2-wei-dust token can
    ///      never clear: it must actually fund at least (1 - maxFeeBps) of its
    ///      own reserve side to pass, whatever the caller's other params are.
    function _checkFee(uint256 received, uint256 sent, uint256 maxFeeBps) internal pure {
        require(received >= sent * (BPS - maxFeeBps) / BPS, "ROUTER: token fee above declared max");
    }

    /// @dev The measured two-token deposit: transfer A and measure the arrival,
    ///      size B from that measurement, transfer B and measure it too, then
    ///      mint and enforce the measured proportional floor plus minLiquidity.
    function _depositTokensMeasured(
        address tokenA,
        address tokenB,
        uint256 amountA,
        uint256 amountB,
        uint256 amountBMin,
        address to,
        uint256 minLiquidity,
        uint256 maxFeeBps
    ) internal returns (uint256 liquidity) {
        require(maxFeeBps <= MAX_DECLARED_FEE_BPS, "ROUTER: fee allowance too high");
        MeasuredDeposit memory d;
        d.pair = FerminuxLibrary.pairFor(factory, tokenA, tokenB);
        (d.reserveA, d.reserveB) = FerminuxLibrary.getReserves(factory, tokenA, tokenB);
        d.supply = IFerminuxPair(d.pair).totalSupply();
        d.lpBefore = IFerminuxPair(d.pair).balanceOf(to);

        d.receivedA = _transferMeasured(tokenA, d.pair, amountA);
        _checkFee(d.receivedA, amountA, maxFeeBps);
        if (d.reserveA == 0 && d.reserveB == 0) {
            // Empty pool: the depositor sets the price and holds ~100% of the
            // LP, so there is no counter-party to skim to. No ratio to size or
            // floor against; only the fee allowance is enforced per side.
            d.amountBUsed = amountB;
            _checkFee(_transferMeasured(tokenB, d.pair, amountB), amountB, maxFeeBps);
        } else {
            // Size the counter-asset to what ACTUALLY arrived, so an
            // under-delivering tokenA shrinks the deposit instead of donating
            // tokenB to the pool.
            d.amountBUsed = FerminuxLibrary.quote(d.receivedA, d.reserveA, d.reserveB);
            if (d.amountBUsed > amountB) d.amountBUsed = amountB;
            require(d.amountBUsed >= amountBMin, "ROUTER: insufficient B amount");
            uint256 receivedB = _transferMeasured(tokenB, d.pair, d.amountBUsed);
            _checkFee(receivedB, d.amountBUsed, maxFeeBps);
            // The LP the measured arrivals must mint at the honest pre-transfer
            // reserves and supply. A token that showed the router one balance
            // and shows the mint another lands below this and reverts.
            uint256 fromA = d.receivedA * d.supply / d.reserveA;
            uint256 fromB = receivedB * d.supply / d.reserveB;
            d.expected = fromA < fromB ? fromA : fromB;
        }
        liquidity = _mintChecked(d.pair, to, d.lpBefore, minLiquidity, d.expected);
    }

    /// @dev The measured native-FMX deposit: transfer the token and measure the
    ///      arrival, size the FMX leg from that measurement (WFMX is this
    ///      router's own wrap, so it always delivers in full), then mint and
    ///      enforce the measured floor. Returns the FMX actually used so the
    ///      caller can refund the rest.
    function _depositFMXMeasured(
        address token,
        uint256 amountToken,
        uint256 amountFMXMax,
        uint256 amountFMXMin,
        address to,
        uint256 minLiquidity,
        uint256 maxFeeBps
    ) internal returns (uint256 liquidity, uint256 amountFMXUsed) {
        require(maxFeeBps <= MAX_DECLARED_FEE_BPS, "ROUTER: fee allowance too high");
        MeasuredDeposit memory d;
        d.pair = FerminuxLibrary.pairFor(factory, token, WFMX);
        (d.reserveA, d.reserveB) = FerminuxLibrary.getReserves(factory, token, WFMX);
        d.supply = IFerminuxPair(d.pair).totalSupply();
        d.lpBefore = IFerminuxPair(d.pair).balanceOf(to);

        d.receivedA = _transferMeasured(token, d.pair, amountToken);
        _checkFee(d.receivedA, amountToken, maxFeeBps);
        if (d.reserveA == 0 && d.reserveB == 0) {
            amountFMXUsed = amountFMXMax;
        } else {
            amountFMXUsed = FerminuxLibrary.quote(d.receivedA, d.reserveA, d.reserveB);
            if (amountFMXUsed > amountFMXMax) amountFMXUsed = amountFMXMax;
            require(amountFMXUsed >= amountFMXMin, "ROUTER: insufficient B amount");
            uint256 fromToken = d.receivedA * d.supply / d.reserveA;
            uint256 fromFMX = amountFMXUsed * d.supply / d.reserveB;
            d.expected = fromToken < fromFMX ? fromToken : fromFMX;
        }
        IWFMX(WFMX).deposit{value: amountFMXUsed}();
        require(IWFMX(WFMX).transfer(d.pair, amountFMXUsed), "ROUTER: WFMX transfer failed");
        liquidity = _mintChecked(d.pair, to, d.lpBefore, minLiquidity, d.expected);
    }

    /// @notice `addLiquidity` for a token that taxes its own transfers. The
    ///         proportional floor cannot be computed from the amounts SENT (a
    ///         taxed token legitimately delivers less), so this path measures
    ///         what the pair actually received and enforces the floors on that:
    ///
    ///           - `maxFeeBps` — the largest transfer tax you accept, capped at
    ///             MAX_DECLARED_FEE_BPS (20%). Each side must deliver at least
    ///             (1 - maxFeeBps) of what was sent or the deposit reverts.
    ///             Declare the token's real fee, not a generous guess: it is
    ///             also the most a hostile token can cost you.
    ///           - the counter-asset (tokenB) is re-quoted from tokenA's
    ///             MEASURED arrival, so it can never be donated against tokens
    ///             that were not actually credited. Pass the fee-on-transfer
    ///             token as tokenA when only one side is taxed.
    ///           - `minLiquidity` — as on `addLiquidity`; set it from the LP
    ///             you expect NET of the token's fee, less slippage.
    ///
    ///         `amountBMin` is enforced against the re-quoted (post-fee) tokenB
    ///         amount, so set it net of tokenA's expected fee as well.
    function addLiquiditySupportingFeeOnTransferTokens(
        address tokenA,
        address tokenB,
        uint256 amountADesired,
        uint256 amountBDesired,
        uint256 amountAMin,
        uint256 amountBMin,
        uint256 maxFeeBps,
        uint256 minLiquidity,
        address to,
        uint256 deadline
    ) external ensure(deadline) returns (uint256 liquidity) {
        (uint256 amountA, uint256 amountB,) =
            _addLiquidity(tokenA, tokenB, amountADesired, amountBDesired, amountAMin, amountBMin);
        liquidity = _depositTokensMeasured(tokenA, tokenB, amountA, amountB, amountBMin, to, minLiquidity, maxFeeBps);
    }

    /// @notice `addLiquidityFMX` for a fee-on-transfer token. See the notes on
    ///         `addLiquiditySupportingFeeOnTransferTokens`; the FMX leg is sized
    ///         from the token's MEASURED arrival and the unused FMX is refunded,
    ///         so a token that credits the pool dust costs dust, not the value
    ///         sent. `amountFMXMin` is enforced against the re-quoted (post-fee)
    ///         FMX amount.
    function addLiquidityFMXSupportingFeeOnTransferTokens(
        address token,
        uint256 amountTokenDesired,
        uint256 amountTokenMin,
        uint256 amountFMXMin,
        uint256 maxFeeBps,
        uint256 minLiquidity,
        address to,
        uint256 deadline
    ) external payable ensure(deadline) returns (uint256 liquidity) {
        (uint256 amountToken, uint256 amountFMX,) =
            _addLiquidity(token, WFMX, amountTokenDesired, msg.value, amountTokenMin, amountFMXMin);
        uint256 amountFMXUsed;
        (liquidity, amountFMXUsed) =
            _depositFMXMeasured(token, amountToken, amountFMX, amountFMXMin, to, minLiquidity, maxFeeBps);
        // Refund every wei the measured deposit did not use. Last action, after
        // every check has passed and all state is settled.
        if (msg.value > amountFMXUsed) TransferHelper.safeTransferFMX(msg.sender, msg.value - amountFMXUsed);
    }

    // =====================================================================
    //                          REMOVE LIQUIDITY
    // =====================================================================

    /// @notice Burn LP tokens and receive both underlying tokens.
    function removeLiquidity(
        address tokenA,
        address tokenB,
        uint256 liquidity,
        uint256 amountAMin,
        uint256 amountBMin,
        address to,
        uint256 deadline
    ) public ensure(deadline) returns (uint256 amountA, uint256 amountB) {
        address pair = FerminuxLibrary.pairFor(factory, tokenA, tokenB);
        require(IFerminuxPair(pair).transferFrom(msg.sender, pair, liquidity), "ROUTER: LP transfer failed");
        (uint256 amount0, uint256 amount1) = IFerminuxPair(pair).burn(to);
        (address token0,) = FerminuxLibrary.sortTokens(tokenA, tokenB);
        (amountA, amountB) = tokenA == token0 ? (amount0, amount1) : (amount1, amount0);
        require(amountA >= amountAMin, "ROUTER: insufficient A amount");
        require(amountB >= amountBMin, "ROUTER: insufficient B amount");
    }

    /// @notice Burn LP tokens and receive the token plus native FMX.
    function removeLiquidityFMX(
        address token,
        uint256 liquidity,
        uint256 amountTokenMin,
        uint256 amountFMXMin,
        address to,
        uint256 deadline
    ) public ensure(deadline) returns (uint256 amountToken, uint256 amountFMX) {
        (amountToken, amountFMX) = removeLiquidity(
            token, WFMX, liquidity, amountTokenMin, amountFMXMin, address(this), deadline
        );
        TransferHelper.safeTransfer(token, to, amountToken);
        IWFMX(WFMX).withdraw(amountFMX);
        TransferHelper.safeTransferFMX(to, amountFMX);
    }

    /// @notice `removeLiquidity` with an EIP-2612 signature instead of a prior
    ///         `approve` — one transaction instead of two.
    function removeLiquidityWithPermit(
        address tokenA,
        address tokenB,
        uint256 liquidity,
        uint256 amountAMin,
        uint256 amountBMin,
        address to,
        uint256 deadline,
        bool approveMax,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external returns (uint256 amountA, uint256 amountB) {
        address pair = FerminuxLibrary.pairFor(factory, tokenA, tokenB);
        uint256 value = approveMax ? type(uint256).max : liquidity;
        IFerminuxPair(pair).permit(msg.sender, address(this), value, deadline, v, r, s);
        (amountA, amountB) = removeLiquidity(tokenA, tokenB, liquidity, amountAMin, amountBMin, to, deadline);
    }

    /// @notice `removeLiquidityFMX` with an EIP-2612 signature.
    function removeLiquidityFMXWithPermit(
        address token,
        uint256 liquidity,
        uint256 amountTokenMin,
        uint256 amountFMXMin,
        address to,
        uint256 deadline,
        bool approveMax,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external returns (uint256 amountToken, uint256 amountFMX) {
        address pair = FerminuxLibrary.pairFor(factory, token, WFMX);
        uint256 value = approveMax ? type(uint256).max : liquidity;
        IFerminuxPair(pair).permit(msg.sender, address(this), value, deadline, v, r, s);
        (amountToken, amountFMX) = removeLiquidityFMX(token, liquidity, amountTokenMin, amountFMXMin, to, deadline);
    }

    // ------------------------------- fee-on-transfer aware removal ---------
    /// @notice Same as `removeLiquidityFMX` but returns whatever actually
    ///         arrived, so tokens that tax their own transfers do not make the
    ///         call revert on the return-value check.
    function removeLiquidityFMXSupportingFeeOnTransferTokens(
        address token,
        uint256 liquidity,
        uint256 amountTokenMin,
        uint256 amountFMXMin,
        address to,
        uint256 deadline
    ) public ensure(deadline) returns (uint256 amountFMX) {
        (, amountFMX) = removeLiquidity(token, WFMX, liquidity, amountTokenMin, amountFMXMin, address(this), deadline);
        TransferHelper.safeTransfer(token, to, IERC20(token).balanceOf(address(this)));
        IWFMX(WFMX).withdraw(amountFMX);
        TransferHelper.safeTransferFMX(to, amountFMX);
    }

    function removeLiquidityFMXWithPermitSupportingFeeOnTransferTokens(
        address token,
        uint256 liquidity,
        uint256 amountTokenMin,
        uint256 amountFMXMin,
        address to,
        uint256 deadline,
        bool approveMax,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external returns (uint256 amountFMX) {
        address pair = FerminuxLibrary.pairFor(factory, token, WFMX);
        uint256 value = approveMax ? type(uint256).max : liquidity;
        IFerminuxPair(pair).permit(msg.sender, address(this), value, deadline, v, r, s);
        amountFMX = removeLiquidityFMXSupportingFeeOnTransferTokens(
            token, liquidity, amountTokenMin, amountFMXMin, to, deadline
        );
    }

    // =====================================================================
    //                                SWAPS
    // =====================================================================

    /// @dev Walk the path, sending each pool's output straight into the next
    ///      pool. `amounts` was priced by the library before the first hop.
    function _swap(uint256[] memory amounts, address[] memory path, address _to) internal {
        for (uint256 i; i < path.length - 1; i++) {
            (address input, address output) = (path[i], path[i + 1]);
            (address token0,) = FerminuxLibrary.sortTokens(input, output);
            uint256 amountOut = amounts[i + 1];
            (uint256 amount0Out, uint256 amount1Out) =
                input == token0 ? (uint256(0), amountOut) : (amountOut, uint256(0));
            address to = i < path.length - 2 ? FerminuxLibrary.pairFor(factory, output, path[i + 2]) : _to;
            IFerminuxPair(FerminuxLibrary.pairFor(factory, input, output))
                .swap(amount0Out, amount1Out, to, new bytes(0));
        }
    }

    /// @notice Sell exactly `amountIn`, requiring at least `amountOutMin` back.
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external ensure(deadline) returns (uint256[] memory amounts) {
        amounts = FerminuxLibrary.getAmountsOut(factory, amountIn, path);
        require(amounts[amounts.length - 1] >= amountOutMin, "ROUTER: insufficient output amount");
        TransferHelper.safeTransferFrom(
            path[0], msg.sender, FerminuxLibrary.pairFor(factory, path[0], path[1]), amounts[0]
        );
        _swap(amounts, path, to);
    }

    /// @notice Buy exactly `amountOut`, spending at most `amountInMax`.
    function swapTokensForExactTokens(
        uint256 amountOut,
        uint256 amountInMax,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external ensure(deadline) returns (uint256[] memory amounts) {
        amounts = FerminuxLibrary.getAmountsIn(factory, amountOut, path);
        require(amounts[0] <= amountInMax, "ROUTER: excessive input amount");
        TransferHelper.safeTransferFrom(
            path[0], msg.sender, FerminuxLibrary.pairFor(factory, path[0], path[1]), amounts[0]
        );
        _swap(amounts, path, to);
    }

    /// @notice Sell exactly `msg.value` FMX for tokens. Path must start at WFMX.
    function swapExactFMXForTokens(uint256 amountOutMin, address[] calldata path, address to, uint256 deadline)
        external
        payable
        ensure(deadline)
        returns (uint256[] memory amounts)
    {
        require(path[0] == WFMX, "ROUTER: invalid path");
        amounts = FerminuxLibrary.getAmountsOut(factory, msg.value, path);
        require(amounts[amounts.length - 1] >= amountOutMin, "ROUTER: insufficient output amount");
        IWFMX(WFMX).deposit{value: amounts[0]}();
        require(
            IWFMX(WFMX).transfer(FerminuxLibrary.pairFor(factory, path[0], path[1]), amounts[0]),
            "ROUTER: WFMX transfer failed"
        );
        _swap(amounts, path, to);
    }

    /// @notice Buy exactly `amountOut` FMX with tokens. Path must end at WFMX.
    function swapTokensForExactFMX(
        uint256 amountOut,
        uint256 amountInMax,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external ensure(deadline) returns (uint256[] memory amounts) {
        require(path[path.length - 1] == WFMX, "ROUTER: invalid path");
        amounts = FerminuxLibrary.getAmountsIn(factory, amountOut, path);
        require(amounts[0] <= amountInMax, "ROUTER: excessive input amount");
        TransferHelper.safeTransferFrom(
            path[0], msg.sender, FerminuxLibrary.pairFor(factory, path[0], path[1]), amounts[0]
        );
        _swap(amounts, path, address(this));
        IWFMX(WFMX).withdraw(amounts[amounts.length - 1]);
        TransferHelper.safeTransferFMX(to, amounts[amounts.length - 1]);
    }

    /// @notice Sell exactly `amountIn` tokens for FMX. Path must end at WFMX.
    function swapExactTokensForFMX(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external ensure(deadline) returns (uint256[] memory amounts) {
        require(path[path.length - 1] == WFMX, "ROUTER: invalid path");
        amounts = FerminuxLibrary.getAmountsOut(factory, amountIn, path);
        require(amounts[amounts.length - 1] >= amountOutMin, "ROUTER: insufficient output amount");
        TransferHelper.safeTransferFrom(
            path[0], msg.sender, FerminuxLibrary.pairFor(factory, path[0], path[1]), amounts[0]
        );
        _swap(amounts, path, address(this));
        IWFMX(WFMX).withdraw(amounts[amounts.length - 1]);
        TransferHelper.safeTransferFMX(to, amounts[amounts.length - 1]);
    }

    /// @notice Buy exactly `amountOut` tokens with FMX, refunding unused FMX.
    function swapFMXForExactTokens(uint256 amountOut, address[] calldata path, address to, uint256 deadline)
        external
        payable
        ensure(deadline)
        returns (uint256[] memory amounts)
    {
        require(path[0] == WFMX, "ROUTER: invalid path");
        amounts = FerminuxLibrary.getAmountsIn(factory, amountOut, path);
        require(amounts[0] <= msg.value, "ROUTER: excessive input amount");
        IWFMX(WFMX).deposit{value: amounts[0]}();
        require(
            IWFMX(WFMX).transfer(FerminuxLibrary.pairFor(factory, path[0], path[1]), amounts[0]),
            "ROUTER: WFMX transfer failed"
        );
        _swap(amounts, path, to);
        // Refund dust FMX.
        if (msg.value > amounts[0]) TransferHelper.safeTransferFMX(msg.sender, msg.value - amounts[0]);
    }

    // ------------------------------- fee-on-transfer aware swaps -----------
    /// @dev Prices each hop from the balance that ACTUALLY arrived rather than
    ///      from a pre-computed amount, which is what makes tokens that tax
    ///      their own transfers work.
    function _swapSupportingFeeOnTransferTokens(address[] memory path, address _to) internal {
        for (uint256 i; i < path.length - 1; i++) {
            (address input, address output) = (path[i], path[i + 1]);
            (address token0,) = FerminuxLibrary.sortTokens(input, output);
            IFerminuxPair pair = IFerminuxPair(FerminuxLibrary.pairFor(factory, input, output));
            uint256 amountInput;
            uint256 amountOutput;
            {
                (uint256 reserve0, uint256 reserve1,) = pair.getReserves();
                (uint256 reserveInput, uint256 reserveOutput) =
                    input == token0 ? (reserve0, reserve1) : (reserve1, reserve0);
                amountInput = IERC20(input).balanceOf(address(pair)) - reserveInput;
                amountOutput = FerminuxLibrary.getAmountOut(amountInput, reserveInput, reserveOutput);
            }
            (uint256 amount0Out, uint256 amount1Out) =
                input == token0 ? (uint256(0), amountOutput) : (amountOutput, uint256(0));
            address to = i < path.length - 2 ? FerminuxLibrary.pairFor(factory, output, path[i + 2]) : _to;
            pair.swap(amount0Out, amount1Out, to, new bytes(0));
        }
    }

    function swapExactTokensForTokensSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external ensure(deadline) {
        TransferHelper.safeTransferFrom(
            path[0], msg.sender, FerminuxLibrary.pairFor(factory, path[0], path[1]), amountIn
        );
        uint256 balanceBefore = IERC20(path[path.length - 1]).balanceOf(to);
        _swapSupportingFeeOnTransferTokens(path, to);
        require(
            IERC20(path[path.length - 1]).balanceOf(to) - balanceBefore >= amountOutMin,
            "ROUTER: insufficient output amount"
        );
    }

    function swapExactFMXForTokensSupportingFeeOnTransferTokens(
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external payable ensure(deadline) {
        require(path[0] == WFMX, "ROUTER: invalid path");
        uint256 amountIn = msg.value;
        IWFMX(WFMX).deposit{value: amountIn}();
        require(
            IWFMX(WFMX).transfer(FerminuxLibrary.pairFor(factory, path[0], path[1]), amountIn),
            "ROUTER: WFMX transfer failed"
        );
        uint256 balanceBefore = IERC20(path[path.length - 1]).balanceOf(to);
        _swapSupportingFeeOnTransferTokens(path, to);
        require(
            IERC20(path[path.length - 1]).balanceOf(to) - balanceBefore >= amountOutMin,
            "ROUTER: insufficient output amount"
        );
    }

    function swapExactTokensForFMXSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external ensure(deadline) {
        require(path[path.length - 1] == WFMX, "ROUTER: invalid path");
        TransferHelper.safeTransferFrom(
            path[0], msg.sender, FerminuxLibrary.pairFor(factory, path[0], path[1]), amountIn
        );
        _swapSupportingFeeOnTransferTokens(path, address(this));
        uint256 amountOut = IERC20(WFMX).balanceOf(address(this));
        require(amountOut >= amountOutMin, "ROUTER: insufficient output amount");
        IWFMX(WFMX).withdraw(amountOut);
        TransferHelper.safeTransferFMX(to, amountOut);
    }

    // =====================================================================
    //                          PRICING (views/pure)
    // =====================================================================

    function quote(uint256 amountA, uint256 reserveA, uint256 reserveB) external pure returns (uint256 amountB) {
        return FerminuxLibrary.quote(amountA, reserveA, reserveB);
    }

    function getAmountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut)
        external
        pure
        returns (uint256 amountOut)
    {
        return FerminuxLibrary.getAmountOut(amountIn, reserveIn, reserveOut);
    }

    function getAmountIn(uint256 amountOut, uint256 reserveIn, uint256 reserveOut)
        external
        pure
        returns (uint256 amountIn)
    {
        return FerminuxLibrary.getAmountIn(amountOut, reserveIn, reserveOut);
    }

    function getAmountsOut(uint256 amountIn, address[] memory path) external view returns (uint256[] memory amounts) {
        return FerminuxLibrary.getAmountsOut(factory, amountIn, path);
    }

    function getAmountsIn(uint256 amountOut, address[] memory path) external view returns (uint256[] memory amounts) {
        return FerminuxLibrary.getAmountsIn(factory, amountOut, path);
    }

    /// @notice The pool address for a pair, from the factory registry.
    function pairFor(address tokenA, address tokenB) external view returns (address) {
        return FerminuxLibrary.pairFor(factory, tokenA, tokenB);
    }

    /// @notice Reserves in the caller's token order.
    function getReserves(address tokenA, address tokenB) external view returns (uint256 reserveA, uint256 reserveB) {
        return FerminuxLibrary.getReserves(factory, tokenA, tokenB);
    }
}
