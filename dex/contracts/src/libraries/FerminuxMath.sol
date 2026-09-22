// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title FerminuxMath
 * @notice The two numeric helpers the pool needs: `min` and an integer square
 *         root (Babylonian method). Ported unchanged in behaviour from the
 *         proven Uniswap-v2 `Math` library — `sqrt` returns floor(sqrt(y)).
 */
library FerminuxMath {
    function min(uint256 x, uint256 y) internal pure returns (uint256 z) {
        z = x < y ? x : y;
    }

    /// @return z floor(sqrt(y)). Babylonian iteration; converges in <= 256 steps
    ///         and is exact for perfect squares.
    function sqrt(uint256 y) internal pure returns (uint256 z) {
        if (y > 3) {
            z = y;
            uint256 x = y / 2 + 1;
            while (x < z) {
                z = x;
                x = (y / x + x) / 2;
            }
        } else if (y != 0) {
            z = 1;
        }
        // y == 0 -> z == 0 (default)
    }
}

/**
 * @title UQ112x112
 * @notice Binary fixed point with 112 integer bits and 112 fractional bits,
 *         carried in a uint224. This is the format of the TWAP price
 *         accumulators: `price0CumulativeLast` accrues `reserve1/reserve0`
 *         in UQ112x112 multiplied by seconds elapsed.
 *
 *         Range/precision: [0, 2**112 - 1] with a resolution of 1 / 2**112.
 */
library UQ112x112 {
    uint224 internal constant Q112 = 2 ** 112;

    /// @notice Lift a uint112 into UQ112x112. Never overflows: y <= 2**112 - 1
    ///         so y * 2**112 <= 2**224 - 2**112 < type(uint224).max.
    function encode(uint112 y) internal pure returns (uint224 z) {
        z = uint224(y) * Q112;
    }

    /// @notice Divide a UQ112x112 by a uint112, returning a UQ112x112.
    ///         Callers must ensure y != 0 (the pool only divides by non-zero
    ///         reserves).
    function uqdiv(uint224 x, uint112 y) internal pure returns (uint224 z) {
        z = x / uint224(y);
    }
}
