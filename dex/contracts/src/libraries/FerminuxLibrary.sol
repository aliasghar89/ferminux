// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IFerminuxFactory, IFerminuxPair} from "../interfaces/IFerminuxDex.sol";

/**
 * @title FerminuxLibrary
 * @notice The pricing math of the constant-product AMM, as pure functions, plus
 *         the two small lookups (sort, reserves) the router needs.
 *
 *         `quote` is the no-fee ratio used when ADDING liquidity: it answers
 *         "at the current pool ratio, how much B pairs with this much A?".
 *         `getAmountOut` / `getAmountIn` are the SWAP prices and include the
 *         0.30% fee (997/1000 of the input is what actually moves the curve).
 *
 *         Multi-hop routes are priced by chaining those two along `path`, which
 *         is why a 3-hop route costs ~0.90% in fees, not 0.30%.
 */
library FerminuxLibrary {
    /// @notice Canonical ordering: every pair stores its tokens sorted by address.
    function sortTokens(address tokenA, address tokenB) internal pure returns (address token0, address token1) {
        require(tokenA != tokenB, "LIB: identical addresses");
        (token0, token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        require(token0 != address(0), "LIB: zero address");
    }

    /// @notice The pool for `tokenA`/`tokenB`, read from the factory registry.
    /// @dev    Deliberately a registry lookup rather than the CREATE2 derivation
    ///         Uniswap v2's library uses. It costs one extra SLOAD-through-CALL
    ///         per hop and in exchange the router can never be pointed at a
    ///         phantom address by a stale hard-coded init code hash. Use
    ///         `pairForDeterministic` when you need the address without a call.
    function pairFor(address factory, address tokenA, address tokenB) internal view returns (address pair) {
        pair = IFerminuxFactory(factory).getPair(tokenA, tokenB);
        require(pair != address(0), "LIB: pair does not exist");
    }

    /// @notice The CREATE2-derived pair address — pure, no RPC/call needed.
    ///         `initCodeHash` is `FerminuxFactory.INIT_CODE_PAIR_HASH()`.
    function pairForDeterministic(address factory, bytes32 initCodeHash, address tokenA, address tokenB)
        internal
        pure
        returns (address pair)
    {
        (address token0, address token1) = sortTokens(tokenA, tokenB);
        pair = address(
            uint160(
                uint256(
                    keccak256(
                        abi.encodePacked(hex"ff", factory, keccak256(abi.encodePacked(token0, token1)), initCodeHash)
                    )
                )
            )
        );
    }

    /// @notice Reserves of `tokenA`/`tokenB`, returned in the caller's order.
    function getReserves(address factory, address tokenA, address tokenB)
        internal
        view
        returns (uint256 reserveA, uint256 reserveB)
    {
        (address token0,) = sortTokens(tokenA, tokenB);
        (uint256 reserve0, uint256 reserve1,) = IFerminuxPair(pairFor(factory, tokenA, tokenB)).getReserves();
        (reserveA, reserveB) = tokenA == token0 ? (reserve0, reserve1) : (reserve1, reserve0);
    }

    /// @notice Equivalent amount of B for `amountA` at the current pool ratio.
    ///         No fee: this is the ADD-LIQUIDITY ratio, not a swap price.
    function quote(uint256 amountA, uint256 reserveA, uint256 reserveB) internal pure returns (uint256 amountB) {
        require(amountA > 0, "LIB: insufficient amount");
        require(reserveA > 0 && reserveB > 0, "LIB: insufficient liquidity");
        amountB = amountA * reserveB / reserveA;
    }

    /// @notice Output of a swap of `amountIn`, after the 0.30% fee.
    ///         amountOut = (amountIn * 997 * reserveOut) / (reserveIn * 1000 + amountIn * 997)
    ///         Rounds DOWN, i.e. in favour of the pool.
    function getAmountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut)
        internal
        pure
        returns (uint256 amountOut)
    {
        require(amountIn > 0, "LIB: insufficient input amount");
        require(reserveIn > 0 && reserveOut > 0, "LIB: insufficient liquidity");
        uint256 amountInWithFee = amountIn * 997;
        uint256 numerator = amountInWithFee * reserveOut;
        uint256 denominator = reserveIn * 1000 + amountInWithFee;
        amountOut = numerator / denominator;
    }

    /// @notice Input required to receive exactly `amountOut`, including the fee.
    ///         amountIn = (reserveIn * amountOut * 1000) / ((reserveOut - amountOut) * 997) + 1
    ///         Rounds UP (the +1), i.e. in favour of the pool.
    function getAmountIn(uint256 amountOut, uint256 reserveIn, uint256 reserveOut)
        internal
        pure
        returns (uint256 amountIn)
    {
        require(amountOut > 0, "LIB: insufficient output amount");
        require(reserveIn > 0 && reserveOut > 0, "LIB: insufficient liquidity");
        require(amountOut < reserveOut, "LIB: insufficient liquidity");
        uint256 numerator = reserveIn * amountOut * 1000;
        uint256 denominator = (reserveOut - amountOut) * 997;
        amountIn = numerator / denominator + 1;
    }

    /// @notice Chained `getAmountOut` along `path`. amounts[0] is the input.
    function getAmountsOut(address factory, uint256 amountIn, address[] memory path)
        internal
        view
        returns (uint256[] memory amounts)
    {
        require(path.length >= 2, "LIB: invalid path");
        amounts = new uint256[](path.length);
        amounts[0] = amountIn;
        for (uint256 i; i < path.length - 1; i++) {
            (uint256 reserveIn, uint256 reserveOut) = getReserves(factory, path[i], path[i + 1]);
            amounts[i + 1] = getAmountOut(amounts[i], reserveIn, reserveOut);
        }
    }

    /// @notice Chained `getAmountIn` along `path`, walked backwards.
    ///         amounts[path.length - 1] is the exact output.
    function getAmountsIn(address factory, uint256 amountOut, address[] memory path)
        internal
        view
        returns (uint256[] memory amounts)
    {
        require(path.length >= 2, "LIB: invalid path");
        amounts = new uint256[](path.length);
        amounts[amounts.length - 1] = amountOut;
        for (uint256 i = path.length - 1; i > 0; i--) {
            (uint256 reserveIn, uint256 reserveOut) = getReserves(factory, path[i - 1], path[i]);
            amounts[i - 1] = getAmountIn(amounts[i], reserveIn, reserveOut);
        }
    }
}
