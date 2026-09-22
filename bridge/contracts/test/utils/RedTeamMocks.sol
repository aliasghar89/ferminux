// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FerminuxBridge} from "../../src/FerminuxBridge.sol";

/**
 * @dev Adversarial token shapes from the 2026-08-20 red-team review. Each one
 *      reproduces a specific proof-of-concept, so the regression tests exercise
 *      the real attack rather than an approximation of it.
 */

/// @dev Canonical-shaped ERC-20 whose issuer can confiscate — the USDT/USDC
///      blacklist-with-burn and clawback shape. Used to drive the bridge
///      under-collateralised so the fee sweep has principal to eat.
contract SeizableToken {
    string public name = "Seizable";
    string public symbol = "SEIZ";
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);

    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    /// @notice The issuer takes tokens back out of any holder.
    function seize(address from, uint256 amount) external {
        balanceOf[from] -= amount;
        totalSupply -= amount;
        emit Transfer(from, address(0), amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= amount, "SEIZ: allowance");
            allowance[from][msg.sender] = allowed - amount;
        }
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) internal {
        require(balanceOf[from] >= amount, "SEIZ: balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}

/// @dev A token that reports balances honestly but whose transfer() can be
///      switched into a silent no-op: it moves nothing and returns NO data, which
///      is byte-for-byte what a `.call` into a dead proxy looks like. This is the
///      shape a code-existence check alone cannot catch.
contract SilentNoopToken {
    string public name = "Silent";
    string public symbol = "SLNT";
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    bool public silent;

    event Transfer(address indexed from, address indexed to, uint256 value);

    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    /// @notice Go dark: from here on transfer() succeeds and does nothing.
    function goSilent() external {
        silent = true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external {
        if (silent) return; // succeeds, returns no data, moves nothing
        _transfer(msg.sender, to, amount);
    }

    function transferFrom(address from, address to, uint256 amount) external {
        if (silent) return;
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= amount, "SLNT: allowance");
            allowance[from][msg.sender] = allowed - amount;
        }
        _transfer(from, to, amount);
    }

    function _transfer(address from, address to, uint256 amount) internal {
        require(balanceOf[from] >= amount, "SLNT: balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}

/// @dev The red team's ProxyWrapper: an ordinary upgradeable-token shape that
///      answers `bridge()` correctly from its own code and forwards everything
///      else to a mutable implementation. Point `impl` at address(0) and every
///      zero-return call (mint/burn) succeeds having done nothing, because
///      delegatecall to a code-less address returns success.
contract ProxyWrapper {
    address public impl;
    address internal _bridge;

    constructor(address impl_, address bridge_) {
        impl = impl_;
        _bridge = bridge_;
    }

    function setImpl(address a) external {
        impl = a;
    }

    function bridge() external view returns (address) {
        return _bridge;
    }

    fallback() external payable {
        address t = impl;
        assembly {
            calldatacopy(0, 0, calldatasize())
            let ok := delegatecall(gas(), t, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            switch ok
            case 0 { revert(0, returndatasize()) }
            default { return(0, returndatasize()) }
        }
    }
}

/// @dev A wrapper with working views and a switchable lie on the supply calls —
///      the exposure the audit identified as the real one: not a code-less token
///      (the compiler's extcodesize guard already stops that) but a contract that
///      HAS code and returns success without acting.
contract LyingWrapper {
    string public name = "Lying Wrapper";
    string public symbol = "LIE";
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    address internal _bridge;
    bool public lying;

    event Transfer(address indexed from, address indexed to, uint256 value);

    constructor(address bridge_) {
        _bridge = bridge_;
    }

    function bridge() external view returns (address) {
        return _bridge;
    }

    /// @notice From here on mint() and burn() succeed and change nothing.
    function startLying() external {
        lying = true;
    }

    function mint(address to, uint256 amount) external {
        require(msg.sender == _bridge, "LIE: not bridge");
        if (lying) return;
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function burn(address from, uint256 amount) external {
        require(msg.sender == _bridge, "LIE: not bridge");
        if (lying) return;
        balanceOf[from] -= amount;
        totalSupply -= amount;
        emit Transfer(from, address(0), amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= amount, "LIE: allowance");
            allowance[from][msg.sender] = allowed - amount;
        }
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
        return true;
    }

    // Unused by the bridge, present so the shape is a plausible wrapper.
    function proposeBridge(address) external pure {}
    function cancelBridgeRotation() external pure {}
    function acceptBridge() external pure {}
}

/**
 * @dev The token class the round-1 settlement fix bricked, and the reason the
 *      round-2 fix measures BOTH sides.
 *
 *      A redistributing / "reflection" token takes a tax out of every transfer
 *      and pays it back to holders pro rata — and the bridge is a holder, so part
 *      of the tax comes straight back to it. The bridge's balance therefore falls
 *      by LESS than `amount`, which the old `balBefore >= balAfter + amount` check
 *      read as "the transfer did not settle". Every release reverted, forever, and
 *      the collateral was permanently stranded: a silent-loss bug traded for a
 *      permanent-lock bug.
 *
 *      Modelled concretely: TAX_BPS comes out of the transferred amount, half of
 *      it reflects back to the sender (the bridge's own share of the pool) and
 *      half goes to a treasury standing in for everyone else.
 */
contract ReflectionToken {
    string public name = "Reflection";
    string public symbol = "RFLX";
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    uint256 public constant TAX_BPS = 400; // 4%
    address public constant TREASURY = address(0x7EA5);
    /// @dev Off, this token settles exactly. A fixture can therefore lock
    ///      collateral through it and only then switch the reflection on — which
    ///      is how this incident actually arrives in the wild, and the only way to
    ///      reach the strand case now that the deposit leg is exact-or-revert.
    bool public taxOn = true;

    event Transfer(address indexed from, address indexed to, uint256 value);

    function setTax(bool on) external {
        taxOn = on;
    }

    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= amount, "RFLX: allowance");
            allowance[from][msg.sender] = allowed - amount;
        }
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) internal {
        require(balanceOf[from] >= amount, "RFLX: balance");
        uint256 tax = taxOn ? (amount * TAX_BPS) / 10_000 : 0;
        uint256 reflectedToSender = tax / 2;
        balanceOf[from] -= amount;
        balanceOf[to] += amount - tax;
        // The redistribution: the sender is a holder too, so it gets some back.
        balanceOf[from] += reflectedToSender;
        balanceOf[TREASURY] += tax - reflectedToSender;
        emit Transfer(from, to, amount - tax);
    }
}

/// @dev Debits the payer and credits NOBODY — a 100% burn-on-transfer, or a
///      blacklist that swallows the transfer instead of reverting. The bridge-side
///      balance read alone cannot tell this apart from a real delivery, which is
///      why the recipient's delta is measured as well.
contract BurnOnTransferToken {
    string public name = "BurnOnTransfer";
    string public symbol = "BURN";
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);

    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "BURN: balance");
        balanceOf[msg.sender] -= amount;
        totalSupply -= amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= amount, "BURN: allowance");
            allowance[from][msg.sender] = allowed - amount;
        }
        require(balanceOf[from] >= amount, "BURN: balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
        return true;
    }
}

/// @dev Charges its fee ON TOP of the amount instead of out of it, so the payer
///      parts with more than it asked to move. Left unchecked that would let a
///      release eat into other users' collateral one transfer at a time.
contract SurchargeToken {
    string public name = "Surcharge";
    string public symbol = "SURC";
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    address public constant TREASURY = address(0xFEE5);

    event Transfer(address indexed from, address indexed to, uint256 value);

    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        uint256 surcharge = amount / 100;
        require(balanceOf[msg.sender] >= amount + surcharge, "SURC: balance");
        balanceOf[msg.sender] -= amount + surcharge;
        balanceOf[to] += amount;
        balanceOf[TREASURY] += surcharge;
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= amount, "SURC: allowance");
            allowance[from][msg.sender] = allowed - amount;
        }
        require(balanceOf[from] >= amount, "SURC: balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
        return true;
    }
}

/**
 * @dev A wrapper-shaped contract that seizes the thread the moment the bridge
 *      calls into it. Both owner-controlled rotation callbacks — adoptWrapper()
 *      and cancelWrapperBridgeRotation() — hand control to an address the owner
 *      names, which is exactly the shape a reentrancy guard exists for.
 *
 *      `armed` makes the test two-sided: disarmed, the callback path is proven
 *      genuinely reachable and the bridge call succeeds; armed, the reentrant
 *      variant must be stopped by the guard rather than by anything incidental.
 */
contract ReentrantWrapper {
    address public immutable bridgeAddr;
    address internal _bridge;
    bool public armed;

    constructor(address bridge_) {
        bridgeAddr = bridge_;
        _bridge = bridge_;
    }

    function arm(bool on) external {
        armed = on;
    }

    function bridge() external view returns (address) {
        return _bridge;
    }

    function _reenter() internal {
        if (!armed) return;
        // send() is nonReentrant, and a modifier runs BEFORE the body, so a live
        // guard rejects this on the guard itself and not on any argument check.
        FerminuxBridge(payable(bridgeAddr)).send(address(0), 1 ether, 1, address(0xDEAD));
    }

    function acceptBridge() external {
        _reenter();
    }

    function cancelBridgeRotation() external {
        _reenter();
    }

    function proposeBridge(address) external {
        _reenter();
    }
}

/// @dev Has code, but cannot answer BRIDGE_INTERFACE_ID(). Stands in for every
///      contract that is not a Ferminux bridge — and, with no code at all, for
///      the plain EOA the owner must not be able to name as a wrapper's minter.
contract NotABridge {
    uint256 public x;

    function poke() external {
        x++;
    }
}

/// @dev Answers the identity question, but with the wrong value. A contract that
///      merely HAS the function is not enough; it has to answer correctly.
contract WrongIdentityBridge {
    function BRIDGE_INTERFACE_ID() external pure returns (bytes32) {
        return keccak256("SomeOtherBridge.v1");
    }
}

/// @dev Answers with something that is not 32 bytes wide. Guards the decode.
contract ShortAnswerBridge {
    fallback() external {
        assembly {
            mstore(0, 1)
            return(0, 4)
        }
    }
}
