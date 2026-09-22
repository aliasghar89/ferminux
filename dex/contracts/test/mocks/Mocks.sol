// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IFerminuxPair, IFerminuxCallee} from "../../src/interfaces/IFerminuxDex.sol";

/// @dev Plain, well-behaved ERC-20 with an open mint. The baseline token for
///      every test that is not specifically about token misbehaviour.
contract MockERC20 {
    string public name;
    string public symbol;
    uint8 public decimals;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory _name, string memory _symbol, uint8 _decimals) {
        name = _name;
        symbol = _symbol;
        decimals = _decimals;
    }

    function mint(address to, uint256 amount) public virtual {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external virtual returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external virtual returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= amount, "MOCK: allowance");
            allowance[from][msg.sender] = allowed - amount;
        }
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) internal virtual {
        require(balanceOf[from] >= amount, "MOCK: balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}

/// @dev Burns `feeBps` of every transfer — the "fee on transfer" family
///      (reflection/tax tokens). Only the SupportingFeeOnTransferTokens router
///      paths can trade these.
contract FeeOnTransferERC20 is MockERC20 {
    uint256 public feeBps;

    constructor(uint256 _feeBps) MockERC20("Fee Token", "FEE", 18) {
        require(_feeBps < 10_000, "MOCK: fee too high");
        feeBps = _feeBps;
    }

    function setFeeBps(uint256 _feeBps) external {
        require(_feeBps < 10_000, "MOCK: fee too high");
        feeBps = _feeBps;
    }

    function _transfer(address from, address to, uint256 amount) internal override {
        require(balanceOf[from] >= amount, "MOCK: balance");
        uint256 fee = amount * feeBps / 10_000;
        uint256 net = amount - fee;
        balanceOf[from] -= amount;
        balanceOf[to] += net;
        if (fee > 0) {
            totalSupply -= fee; // burned
            emit Transfer(from, address(0), fee);
        }
        emit Transfer(from, to, net);
    }
}

/// @dev Returns no data from transfer/transferFrom/approve (USDT-style).
contract NoReturnERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint256 public totalSupply;

    event Transfer(address indexed from, address indexed to, uint256 value);

    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external {
        allowance[msg.sender][spender] = amount;
    }

    function transfer(address to, uint256 amount) external {
        require(balanceOf[msg.sender] >= amount, "NR: balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
    }

    function transferFrom(address from, address to, uint256 amount) external {
        require(balanceOf[from] >= amount, "NR: balance");
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= amount, "NR: allowance");
        allowance[from][msg.sender] = allowed - amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}

/// @dev Returns `false` instead of reverting — must be rejected, never ignored.
contract FalseReturnERC20 is MockERC20 {
    constructor() MockERC20("False Token", "FALSE", 18) {}

    function transfer(address, uint256) external pure override returns (bool) {
        return false;
    }

    function transferFrom(address, address, uint256) external pure override returns (bool) {
        return false;
    }
}

/// @dev Attempts to reenter the pair from inside its own `transfer`, i.e. while
///      the pair is mid-`burn` or mid-`swap`. Records the revert reason so a
///      test can assert the guard fired; set `bubble` to make the whole outer
///      call revert instead.
contract ReentrantERC20 is MockERC20 {
    enum Mode {
        None,
        Mint,
        Burn,
        Swap,
        Sync,
        Skim
    }

    address public pair;
    Mode public mode;
    bool public bubble;
    string public lastRevertReason;
    uint256 public reentryAttempts;

    constructor() MockERC20("Reentrant Token", "RENT", 18) {}

    function arm(address _pair, Mode _mode, bool _bubble) external {
        pair = _pair;
        mode = _mode;
        bubble = _bubble;
    }

    function _transfer(address from, address to, uint256 amount) internal override {
        super._transfer(from, to, amount);
        if (mode != Mode.None && pair != address(0)) {
            reentryAttempts++;
            Mode m = mode;
            mode = Mode.None; // only try once per arming, so we do not loop
            try this.reenter(m) {
                lastRevertReason = "";
            } catch Error(string memory reason) {
                lastRevertReason = reason;
                if (bubble) revert(reason);
            }
        }
    }

    /// @dev External so the try/catch can capture the revert reason. Called by
    ///      this contract, so the pair still sees a call arriving mid-transfer.
    function reenter(Mode m) external {
        require(msg.sender == address(this), "RENT: self only");
        if (m == Mode.Mint) IFerminuxPair(pair).mint(address(this));
        else if (m == Mode.Burn) IFerminuxPair(pair).burn(address(this));
        else if (m == Mode.Swap) IFerminuxPair(pair).swap(1, 0, address(this), new bytes(0));
        else if (m == Mode.Sync) IFerminuxPair(pair).sync();
        else if (m == Mode.Skim) IFerminuxPair(pair).skim(address(this));
    }
}

/// @dev Flash-swap counterparty. `Repay` behaves; `Steal` keeps the tokens and
///      must be rejected by the k check; the Reenter* modes prove the pair's
///      lock holds while control is handed to an untrusted contract.
contract FlashBorrower is IFerminuxCallee {
    enum Mode {
        Repay,
        RepayWithoutFee,
        Steal,
        ReenterMint,
        ReenterBurn,
        ReenterSwap
    }

    address public immutable pair;
    address public immutable token0;
    address public immutable token1;
    Mode public mode;
    string public lastRevertReason;
    bool public reentryAttempted;

    constructor(address _pair) {
        pair = _pair;
        token0 = IFerminuxPair(_pair).token0();
        token1 = IFerminuxPair(_pair).token1();
    }

    function setMode(Mode _mode) external {
        mode = _mode;
    }

    function flash(uint256 amount0Out, uint256 amount1Out) external {
        IFerminuxPair(pair).swap(amount0Out, amount1Out, address(this), abi.encode("go"));
    }

    function ferminuxCall(address, uint256 amount0, uint256 amount1, bytes calldata) external override {
        require(msg.sender == pair, "FLASH: not pair");

        if (mode == Mode.Repay || mode == Mode.RepayWithoutFee) {
            // Repay the borrowed side in the SAME token, plus the 0.30% fee
            // (0.3009...% of the borrowed amount, rounded up) unless we are
            // deliberately underpaying.
            uint256 owed0 = amount0 == 0 ? 0 : amount0 * 1000 / 997 + 1;
            uint256 owed1 = amount1 == 0 ? 0 : amount1 * 1000 / 997 + 1;
            if (mode == Mode.RepayWithoutFee) {
                owed0 = amount0;
                owed1 = amount1;
            }
            if (owed0 > 0) MockERC20(token0).transfer(pair, owed0);
            if (owed1 > 0) MockERC20(token1).transfer(pair, owed1);
            return;
        }
        if (mode == Mode.Steal) return; // repay nothing

        reentryAttempted = true;
        try this.reenter(mode) {
            lastRevertReason = "";
        } catch Error(string memory reason) {
            lastRevertReason = reason;
        }
        // Still repay so the outer swap itself succeeds and the assertion is
        // specifically about the reentrancy having been blocked.
        uint256 repay0 = amount0 == 0 ? 0 : amount0 * 1000 / 997 + 1;
        uint256 repay1 = amount1 == 0 ? 0 : amount1 * 1000 / 997 + 1;
        if (repay0 > 0) MockERC20(token0).transfer(pair, repay0);
        if (repay1 > 0) MockERC20(token1).transfer(pair, repay1);
    }

    function reenter(Mode m) external {
        require(msg.sender == address(this), "FLASH: self only");
        if (m == Mode.ReenterMint) IFerminuxPair(pair).mint(address(this));
        else if (m == Mode.ReenterBurn) IFerminuxPair(pair).burn(address(this));
        else if (m == Mode.ReenterSwap) IFerminuxPair(pair).swap(1, 0, address(this), new bytes(0));
    }
}

/// @dev The add-liquidity theft PoC token. Behaves as an ordinary ERC-20 until
///      `armTheft` is called; after that, a transfer INTO the armed pair credits
///      the pool only `dust` no matter how much was sent — the rest silently
///      stays with the sender. A depositor's mint then sees almost no growth on
///      this token's reserve side, so `FerminuxPair.mint`'s `require(liquidity
///      > 0)` is satisfied with dust LP while the depositor's counter-asset
///      (an honest ERC-20, or real native FMX) is fully deposited and left in
///      the pool for the attacker — who already holds the LP — to withdraw.
///
///      This reproduces the confirmed H_AddLiquidityTheft finding: the token is
///      honest on the seeding call and hostile on the victim's later deposit.
contract LiquidityTheftToken is MockERC20 {
    bool public theftArmed;
    address public victimPair;
    uint256 public dust = 2; // the 2 wei that defeats require(liquidity > 0)

    constructor() MockERC20("Theft Token", "THEFT", 18) {}

    /// @notice Arm the skim against `pair`. Called by the attacker after seeding
    ///         an honest pool, so the pool exists and the token already looks
    ///         legitimate to anyone who checked it before this point.
    function armTheft(address pair) external {
        theftArmed = true;
        victimPair = pair;
    }

    function _transfer(address from, address to, uint256 amount) internal override {
        if (theftArmed && to == victimPair && amount > dust) {
            // Credit the pool only `dust`; the remaining `amount - dust` never
            // leaves `from`. The depositor keeps most of their THEFT tokens, so
            // the loss under test is specifically the counter-asset they paired.
            super._transfer(from, to, dust);
        } else {
            super._transfer(from, to, amount);
        }
    }
}

/// @dev Has no `receive`, so any native FMX sent to it fails. Used to prove the
///      router surfaces a failed FMX payout instead of swallowing it.
contract FMXRejector {
    uint256 public dummy;

    function poke() external {
        dummy++;
    }
}

/// @dev Calls an arbitrary target from inside its own `transfer`, recording the
///      outcome. Used to prove the locker's reentrancy guard fires while a
///      token transfer is in flight.
contract CallbackERC20 is MockERC20 {
    address public target;
    bytes public payload;
    bool public called;
    bool public lastSuccess;
    string public lastRevertReason;

    constructor() MockERC20("Callback Token", "CB", 18) {}

    function arm(address _target, bytes calldata _payload) external {
        target = _target;
        payload = _payload;
        called = false;
    }

    function _transfer(address from, address to, uint256 amount) internal override {
        super._transfer(from, to, amount);
        if (target != address(0)) {
            address t = target;
            bytes memory p = payload;
            target = address(0); // one shot, so we never loop
            called = true;
            (bool ok, bytes memory ret) = t.call(p);
            lastSuccess = ok;
            lastRevertReason = ok ? "" : _reason(ret);
        }
    }

    function _reason(bytes memory ret) private pure returns (string memory) {
        if (ret.length < 68) return "";
        bytes memory trimmed = new bytes(ret.length - 4);
        for (uint256 i = 4; i < ret.length; i++) {
            trimmed[i - 4] = ret[i];
        }
        return abi.decode(trimmed, (string));
    }
}
