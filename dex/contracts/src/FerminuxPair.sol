// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20, IFerminuxFactory, IFerminuxCallee} from "./interfaces/IFerminuxDex.sol";
import {FerminuxMath, UQ112x112} from "./libraries/FerminuxMath.sol";

/**
 * @title FerminuxLP
 * @notice The ERC-20 liquidity-provider token every pair issues. A share of the
 *         pool: burn it and you get back your fraction of both reserves.
 *
 *         Includes EIP-2612 `permit` so a liquidity provider can remove
 *         liquidity in a single transaction (no separate approve).
 *
 * Self-contained: no external imports.
 */
contract FerminuxLP {
    string public constant name = "Ferminux LP";
    string public constant symbol = "FMX-LP";
    uint8 public constant decimals = 18;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    // ------------------------------------------------------- EIP-2612 permit
    bytes32 public constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");
    mapping(address => uint256) public nonces;

    uint256 private immutable _cachedChainId;
    bytes32 private immutable _cachedDomainSeparator;

    constructor() {
        _cachedChainId = block.chainid;
        _cachedDomainSeparator = _buildDomainSeparator();
    }

    /// @notice EIP-712 domain. Rebuilt if the chain forks to a new chain id, so
    ///         signatures can never be replayed across chains.
    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return block.chainid == _cachedChainId ? _cachedDomainSeparator : _buildDomainSeparator();
    }

    function _buildDomainSeparator() private view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes(name)),
                keccak256(bytes("1")),
                block.chainid,
                address(this)
            )
        );
    }

    function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external
    {
        require(block.timestamp <= deadline, "LP: permit expired");
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                DOMAIN_SEPARATOR(),
                keccak256(abi.encode(PERMIT_TYPEHASH, owner, spender, value, nonces[owner]++, deadline))
            )
        );
        address recovered = ecrecover(digest, v, r, s);
        require(recovered != address(0) && recovered == owner, "LP: invalid signature");
        _approve(owner, spender, value);
    }

    // ------------------------------------------------------------- ERC-20
    function approve(address spender, uint256 value) external returns (bool) {
        _approve(msg.sender, spender, value);
        return true;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _transfer(msg.sender, to, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= value, "LP: insufficient allowance");
            unchecked {
                allowance[from][msg.sender] = allowed - value;
            }
            emit Approval(from, msg.sender, allowed - value);
        }
        _transfer(from, to, value);
        return true;
    }

    // ------------------------------------------------------------ Internals
    function _mint(address to, uint256 value) internal {
        totalSupply += value;
        unchecked {
            // Safe: a single balance can never exceed the total supply, which was
            // just incremented with checked arithmetic.
            balanceOf[to] += value;
        }
        emit Transfer(address(0), to, value);
    }

    function _burn(address from, uint256 value) internal {
        balanceOf[from] -= value; // checked: reverts if `from` holds less
        unchecked {
            totalSupply -= value;
        }
        emit Transfer(from, address(0), value);
    }

    function _approve(address owner, address spender, uint256 value) private {
        allowance[owner][spender] = value;
        emit Approval(owner, spender, value);
    }

    function _transfer(address from, address to, uint256 value) private {
        balanceOf[from] -= value; // checked
        unchecked {
            balanceOf[to] += value;
        }
        emit Transfer(from, to, value);
    }
}

/**
 * @title FerminuxPair
 * @notice Constant-product market maker for one token pair: `x * y >= k`.
 *         A faithful Solidity-0.8 port of the proven Uniswap-v2 core mechanics:
 *
 *           - 0.30% fee on the input amount of every swap, paid to LPs by being
 *             left in the reserves (the k check is balance-adjusted by 3/1000)
 *           - MINIMUM_LIQUIDITY (1000 wei of LP) burned on the very first mint,
 *             so the pool can never be fully drained and LP share prices cannot
 *             be inflated by a first-depositor donation
 *           - reserves packed into one storage slot as (uint112, uint112, uint32)
 *           - price accumulators for a manipulation-resistant TWAP oracle
 *           - `skim()` / `sync()` to recover from a token that transfers into
 *             the pair out-of-band or breaks the uint112 bound
 *           - a reentrancy `lock` on every state-changing entry point
 *
 *         Only the factory may `initialize()` it; users always go through the
 *         router, which does the accounting and slippage checks.
 *
 * @dev Overflow semantics. Solidity 0.8 reverts on overflow, while the original
 *      relies on wrapping in exactly two places. Every `unchecked` block below
 *      is annotated with why wrapping is the intended behaviour there; nothing
 *      else in this contract is unchecked.
 */
contract FerminuxPair is FerminuxLP {
    using UQ112x112 for uint224;

    uint256 public constant MINIMUM_LIQUIDITY = 10 ** 3;
    bytes4 private constant SELECTOR = bytes4(keccak256(bytes("transfer(address,uint256)")));

    address public immutable factory;
    address public token0;
    address public token1;

    /// @dev reserve0, reserve1 and blockTimestampLast share a single storage
    ///      slot: one SLOAD serves every swap.
    uint112 private reserve0;
    uint112 private reserve1;
    uint32 private blockTimestampLast;

    uint256 public price0CumulativeLast;
    uint256 public price1CumulativeLast;
    /// @notice reserve0 * reserve1 as of the last liquidity event. Only tracked
    ///         while the protocol fee is on; 0 disables the growth accounting.
    uint256 public kLast;

    uint256 private unlocked = 1;

    event Mint(address indexed sender, uint256 amount0, uint256 amount1);
    event Burn(address indexed sender, uint256 amount0, uint256 amount1, address indexed to);
    event Swap(
        address indexed sender,
        uint256 amount0In,
        uint256 amount1In,
        uint256 amount0Out,
        uint256 amount1Out,
        address indexed to
    );
    event Sync(uint112 reserve0, uint112 reserve1);

    /// @dev Reentrancy guard on every state-changing entry point: mint, burn,
    ///      swap, skim, sync. Flash swaps hand control to an arbitrary callee
    ///      mid-`swap`, so this is load-bearing, not decoration.
    modifier lock() {
        require(unlocked == 1, "PAIR: locked");
        unlocked = 0;
        _;
        unlocked = 1;
    }

    constructor() {
        factory = msg.sender;
    }

    /// @notice Called once by the factory immediately after CREATE2 deployment.
    function initialize(address _token0, address _token1) external {
        require(msg.sender == factory, "PAIR: forbidden");
        require(token0 == address(0) && token1 == address(0), "PAIR: initialized");
        token0 = _token0;
        token1 = _token1;
    }

    // ---------------------------------------------------------------- Views
    function getReserves() public view returns (uint112 _reserve0, uint112 _reserve1, uint32 _blockTimestampLast) {
        _reserve0 = reserve0;
        _reserve1 = reserve1;
        _blockTimestampLast = blockTimestampLast;
    }

    // ------------------------------------------------------------ Internals
    /// @dev ERC-20 transfer that tolerates tokens which return nothing (USDT-style)
    ///      and reverts on tokens that return false.
    function _safeTransfer(address token, address to, uint256 value) private {
        (bool success, bytes memory data) = token.call(abi.encodeWithSelector(SELECTOR, to, value));
        require(success && (data.length == 0 || abi.decode(data, (bool))), "PAIR: transfer failed");
    }

    /// @dev Write the new reserves and advance the TWAP accumulators.
    function _update(uint256 balance0, uint256 balance1, uint112 _reserve0, uint112 _reserve1) private {
        require(balance0 <= type(uint112).max && balance1 <= type(uint112).max, "PAIR: overflow");

        uint32 blockTimestamp = uint32(block.timestamp % 2 ** 32);
        unchecked {
            // WRAPPING IS INTENDED (1/2): the oracle timestamp is uint32, so it
            // rolls over in 2106. `blockTimestamp - blockTimestampLast` computed
            // mod 2**32 still yields the correct elapsed seconds across the
            // rollover, exactly as in the original design.
            uint32 timeElapsed = blockTimestamp - blockTimestampLast;
            if (timeElapsed > 0 && _reserve0 != 0 && _reserve1 != 0) {
                // WRAPPING IS INTENDED (2/2): the price accumulators are allowed
                // to overflow uint256. Consumers only ever read the *difference*
                // between two observations, and modular subtraction recovers the
                // true delta as long as the accumulator wraps at most once
                // between them.
                price0CumulativeLast += uint256(UQ112x112.encode(_reserve1).uqdiv(_reserve0)) * timeElapsed;
                price1CumulativeLast += uint256(UQ112x112.encode(_reserve0).uqdiv(_reserve1)) * timeElapsed;
            }
        }

        // casting to 'uint112' is safe because the require at the top of this
        // function already rejected any balance above type(uint112).max
        // forge-lint: disable-next-line(unsafe-typecast)
        reserve0 = uint112(balance0);
        // forge-lint: disable-next-line(unsafe-typecast)
        reserve1 = uint112(balance1);
        blockTimestampLast = blockTimestamp;
        emit Sync(reserve0, reserve1);
    }

    /// @dev Protocol fee: when `feeTo` is set, mint LP worth 1/6 of the growth
    ///      in sqrt(k) since the last liquidity event. Off by default — `feeTo`
    ///      is address(0) at deployment, and then 100% of the 0.30% goes to LPs.
    function _mintFee(uint112 _reserve0, uint112 _reserve1) private returns (bool feeOn) {
        address feeTo = IFerminuxFactory(factory).feeTo();
        feeOn = feeTo != address(0);
        uint256 _kLast = kLast; // gas savings
        if (feeOn) {
            if (_kLast != 0) {
                uint256 rootK = FerminuxMath.sqrt(uint256(_reserve0) * uint256(_reserve1));
                uint256 rootKLast = FerminuxMath.sqrt(_kLast);
                if (rootK > rootKLast) {
                    uint256 numerator = totalSupply * (rootK - rootKLast);
                    uint256 denominator = rootK * 5 + rootKLast;
                    uint256 liquidity = numerator / denominator;
                    if (liquidity > 0) _mint(feeTo, liquidity);
                }
            }
        } else if (_kLast != 0) {
            kLast = 0;
        }
    }

    // ----------------------------------------------------------------- Mint
    /// @notice Mint LP tokens for whatever was transferred in since the last
    ///         reserve update. Low-level: call it from the router, which sends
    ///         the tokens and enforces the caller's slippage bounds.
    function mint(address to) external lock returns (uint256 liquidity) {
        (uint112 _reserve0, uint112 _reserve1,) = getReserves();
        uint256 balance0 = IERC20(token0).balanceOf(address(this));
        uint256 balance1 = IERC20(token1).balanceOf(address(this));
        uint256 amount0 = balance0 - _reserve0;
        uint256 amount1 = balance1 - _reserve1;

        bool feeOn = _mintFee(_reserve0, _reserve1);
        uint256 _totalSupply = totalSupply; // must be read after _mintFee, which can mint
        if (_totalSupply == 0) {
            // First deposit sets the price. MINIMUM_LIQUIDITY is minted to
            // address(0) — permanently unredeemable — which both keeps the pool
            // from ever reaching a zero total supply and makes the classic
            // first-depositor share-price inflation attack prohibitively
            // expensive (see test_Attack_FirstDepositorDonation*).
            liquidity = FerminuxMath.sqrt(amount0 * amount1) - MINIMUM_LIQUIDITY;
            _mint(address(0), MINIMUM_LIQUIDITY);
        } else {
            // Proportional to the smaller of the two contributions: any excess
            // of the other token is a donation to the pool.
            liquidity = FerminuxMath.min(amount0 * _totalSupply / _reserve0, amount1 * _totalSupply / _reserve1);
        }
        require(liquidity > 0, "PAIR: insufficient liquidity minted");
        _mint(to, liquidity);

        _update(balance0, balance1, _reserve0, _reserve1);
        if (feeOn) kLast = uint256(reserve0) * uint256(reserve1);
        emit Mint(msg.sender, amount0, amount1);
    }

    // ----------------------------------------------------------------- Burn
    /// @notice Burn the LP tokens this contract holds and pay out the
    ///         corresponding share of both reserves. Low-level: the router
    ///         transfers the LP in first.
    function burn(address to) external lock returns (uint256 amount0, uint256 amount1) {
        (uint112 _reserve0, uint112 _reserve1,) = getReserves();
        address _token0 = token0; // gas savings
        address _token1 = token1;
        uint256 balance0 = IERC20(_token0).balanceOf(address(this));
        uint256 balance1 = IERC20(_token1).balanceOf(address(this));
        uint256 liquidity = balanceOf[address(this)];

        bool feeOn = _mintFee(_reserve0, _reserve1);
        uint256 _totalSupply = totalSupply; // must be read after _mintFee, which can mint
        // Pro-rata on *balances*, not reserves, so donated tokens are shared out.
        amount0 = liquidity * balance0 / _totalSupply;
        amount1 = liquidity * balance1 / _totalSupply;
        require(amount0 > 0 && amount1 > 0, "PAIR: insufficient liquidity burned");
        _burn(address(this), liquidity);
        _safeTransfer(_token0, to, amount0);
        _safeTransfer(_token1, to, amount1);
        balance0 = IERC20(_token0).balanceOf(address(this));
        balance1 = IERC20(_token1).balanceOf(address(this));

        _update(balance0, balance1, _reserve0, _reserve1);
        if (feeOn) kLast = uint256(reserve0) * uint256(reserve1);
        emit Burn(msg.sender, amount0, amount1, to);
    }

    // ----------------------------------------------------------------- Swap
    /// @notice Send `amount0Out`/`amount1Out` to `to`, then require that the
    ///         constant product still holds after the 0.30% fee. Input tokens
    ///         must already have been transferred in (or be repaid inside the
    ///         `ferminuxCall` callback for a flash swap).
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external lock {
        require(amount0Out > 0 || amount1Out > 0, "PAIR: insufficient output amount");
        (uint112 _reserve0, uint112 _reserve1,) = getReserves();
        require(amount0Out < _reserve0 && amount1Out < _reserve1, "PAIR: insufficient liquidity");

        uint256 balance0;
        uint256 balance1;
        {
            address _token0 = token0;
            address _token1 = token1;
            require(to != _token0 && to != _token1, "PAIR: invalid to");
            if (amount0Out > 0) _safeTransfer(_token0, to, amount0Out); // optimistically transfer out
            if (amount1Out > 0) _safeTransfer(_token1, to, amount1Out);
            if (data.length > 0) IFerminuxCallee(to).ferminuxCall(msg.sender, amount0Out, amount1Out, data);
            balance0 = IERC20(_token0).balanceOf(address(this));
            balance1 = IERC20(_token1).balanceOf(address(this));
        }

        uint256 amount0In = balance0 > _reserve0 - amount0Out ? balance0 - (_reserve0 - amount0Out) : 0;
        uint256 amount1In = balance1 > _reserve1 - amount1Out ? balance1 - (_reserve1 - amount1Out) : 0;
        require(amount0In > 0 || amount1In > 0, "PAIR: insufficient input amount");
        {
            // The 0.30% fee, expressed exactly as in the original: charge 3/1000
            // of each *input* amount by requiring the fee-adjusted product to be
            // at least the old k, scaled by 1000**2. The fee stays in the
            // reserves, so it accrues to LPs.
            uint256 balance0Adjusted = balance0 * 1000 - amount0In * 3;
            uint256 balance1Adjusted = balance1 * 1000 - amount1In * 3;
            require(
                balance0Adjusted * balance1Adjusted >= uint256(_reserve0) * uint256(_reserve1) * (1000 ** 2), "PAIR: K"
            );
        }

        _update(balance0, balance1, _reserve0, _reserve1);
        emit Swap(msg.sender, amount0In, amount1In, amount0Out, amount1Out, to);
    }

    // -------------------------------------------------------- Skim and sync
    /// @notice Send any balance in excess of the recorded reserves to `to`.
    ///         The escape hatch when a token's balance and the reserves drift
    ///         apart (rebasing tokens, direct donations, uint112 overflow).
    function skim(address to) external lock {
        address _token0 = token0; // gas savings
        address _token1 = token1;
        _safeTransfer(_token0, to, IERC20(_token0).balanceOf(address(this)) - reserve0);
        _safeTransfer(_token1, to, IERC20(_token1).balanceOf(address(this)) - reserve1);
    }

    /// @notice Force the reserves to match the actual balances.
    function sync() external lock {
        _update(IERC20(token0).balanceOf(address(this)), IERC20(token1).balanceOf(address(this)), reserve0, reserve1);
    }
}
