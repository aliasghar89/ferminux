// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FerminuxPair} from "./FerminuxPair.sol";
import {IFerminuxPair} from "./interfaces/IFerminuxDex.sol";

/**
 * @title FerminuxFactory
 * @notice Deploys and indexes every FerminuxPair on the Ferminux Network.
 *
 *         Pairs are deployed with CREATE2 using keccak256(token0, token1) as the
 *         salt, where token0 < token1 by address. Two consequences that matter:
 *
 *           1. A pair's address is a pure function of (factory, token0, token1)
 *              and the pair init code. The router, the wallet UI and the
 *              explorer can compute it off-chain with no RPC call — see
 *              `INIT_CODE_PAIR_HASH` and `predictPairAddress`.
 *           2. Each token pair can exist exactly once. Liquidity cannot be
 *              silently split across duplicate pools.
 *
 *         The protocol fee (`feeTo`) is OFF at deployment: 100% of the 0.30%
 *         swap fee goes to liquidity providers until `feeToSetter` turns it on.
 *
 * Self-contained: no external imports.
 */
contract FerminuxFactory {
    /// @notice keccak256(type(FerminuxPair).creationCode) — the CREATE2 init code
    ///         hash. Exposed as a constant so off-chain code (router, UI,
    ///         explorer) can derive pair addresses without an RPC round-trip.
    /// @dev    Verified against the compiled artifact by
    ///         `test_InitCodeHash_MatchesCompiledPairBytecode`. If the pair
    ///         source or the compiler settings change, that test fails and this
    ///         value must be regenerated:
    ///           cast keccak $(forge inspect FerminuxPair bytecode)
    bytes32 public constant INIT_CODE_PAIR_HASH = 0x53c974ba85f7f41b91b2d8ebcc43c9a7be77206235339c2f3e78dce304c32153;

    /// @notice Protocol fee recipient. address(0) = protocol fee off (default).
    address public feeTo;
    /// @notice The only address allowed to change `feeTo` / `feeToSetter`.
    address public feeToSetter;

    /// @notice getPair[tokenA][tokenB] — populated in BOTH directions.
    mapping(address => mapping(address => address)) public getPair;
    /// @notice Every pair ever created, in creation order.
    address[] public allPairs;

    event PairCreated(address indexed token0, address indexed token1, address pair, uint256 allPairsLength);
    event FeeToChanged(address indexed oldFeeTo, address indexed newFeeTo);
    event FeeToSetterChanged(address indexed oldSetter, address indexed newSetter);

    constructor(address _feeToSetter) {
        require(_feeToSetter != address(0), "FACTORY: zero setter");
        feeToSetter = _feeToSetter;
        emit FeeToSetterChanged(address(0), _feeToSetter);
    }

    // ------------------------------------------------------------ Creation
    /// @notice Deploy the pool for `tokenA`/`tokenB`. Permissionless, one per pair.
    /// @return pair the newly deployed pool
    function createPair(address tokenA, address tokenB) external returns (address pair) {
        require(tokenA != tokenB, "FACTORY: identical addresses");
        (address token0, address token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        require(token0 != address(0), "FACTORY: zero address");
        require(getPair[token0][token1] == address(0), "FACTORY: pair exists");

        bytes32 salt = keccak256(abi.encodePacked(token0, token1));
        pair = address(new FerminuxPair{salt: salt}());
        IFerminuxPair(pair).initialize(token0, token1);

        getPair[token0][token1] = pair;
        getPair[token1][token0] = pair; // both directions: callers need not sort
        allPairs.push(pair);
        emit PairCreated(token0, token1, pair, allPairs.length);
    }

    // --------------------------------------------------------------- Views
    function allPairsLength() external view returns (uint256) {
        return allPairs.length;
    }

    /// @notice The live init code hash, read straight out of this factory's own
    ///         bytecode. `INIT_CODE_PAIR_HASH` must equal this — asserted in the
    ///         test suite and cheap enough to check on-chain if you are paranoid.
    function pairInitCodeHash() external pure returns (bytes32) {
        return keccak256(type(FerminuxPair).creationCode);
    }

    /// @notice The address `createPair(tokenA, tokenB)` will produce (or already
    ///         did), computed from the CREATE2 formula — no storage read.
    function predictPairAddress(address tokenA, address tokenB) public view returns (address pair) {
        require(tokenA != tokenB, "FACTORY: identical addresses");
        (address token0, address token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        require(token0 != address(0), "FACTORY: zero address");
        pair = address(
            uint160(
                uint256(
                    keccak256(
                        abi.encodePacked(
                            hex"ff", address(this), keccak256(abi.encodePacked(token0, token1)), INIT_CODE_PAIR_HASH
                        )
                    )
                )
            )
        );
    }

    /// @notice Paginated pair list for the UI / explorer.
    function pairsPage(uint256 offset, uint256 limit) external view returns (address[] memory page) {
        uint256 n = allPairs.length;
        if (offset >= n) return new address[](0);
        uint256 end = offset + limit > n ? n : offset + limit;
        page = new address[](end - offset);
        for (uint256 i = offset; i < end; i++) {
            page[i - offset] = allPairs[i];
        }
    }

    // --------------------------------------------------------------- Admin
    /// @notice Turn the protocol fee on (non-zero recipient) or off (address(0)).
    ///         When on, 1/6 of the growth in sqrt(k) since the last liquidity
    ///         event is minted to `feeTo` as LP tokens.
    function setFeeTo(address _feeTo) external {
        require(msg.sender == feeToSetter, "FACTORY: forbidden");
        emit FeeToChanged(feeTo, _feeTo);
        feeTo = _feeTo;
    }

    function setFeeToSetter(address _feeToSetter) external {
        require(msg.sender == feeToSetter, "FACTORY: forbidden");
        require(_feeToSetter != address(0), "FACTORY: zero setter");
        emit FeeToSetterChanged(feeToSetter, _feeToSetter);
        feeToSetter = _feeToSetter;
    }
}
