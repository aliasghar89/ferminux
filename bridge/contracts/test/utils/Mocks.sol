// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FerminuxBridge} from "../../src/FerminuxBridge.sol";

/// @dev Plain, well-behaved ERC-20 used as the CANONICAL asset in tests.
contract MockERC20 {
    string public name;
    string public symbol;
    uint8 public immutable decimals;
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

    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= amount, "MOCK: allowance");
            allowance[from][msg.sender] = allowed - amount;
        }
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) internal {
        require(balanceOf[from] >= amount, "MOCK: balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}

/// @dev Takes 1% out of every transfer: the payer's balance falls by the full
///      amount and the recipient is credited less. The bridge must refuse it on
///      both legs — a deposit that credits the measured arrival is a short-pay,
///      and a release that delivers less than the signed amount is a silent loss.
///
///      `setTax(false)` makes it behave exactly, so a fixture can lock collateral
///      through a token that only turns hostile afterwards — the strand scenario
///      the short-delivery escape exists for.
contract FeeOnTransferToken {
    string public name = "FeeOnTransfer";
    string public symbol = "FOT";
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
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
            require(allowed >= amount, "FOT: allowance");
            allowance[from][msg.sender] = allowed - amount;
        }
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) internal {
        require(balanceOf[from] >= amount, "FOT: balance");
        uint256 burned = taxOn ? amount / 100 : 0;
        balanceOf[from] -= amount;
        balanceOf[to] += amount - burned;
        totalSupply -= burned;
        emit Transfer(from, to, amount - burned);
    }
}

/// @dev USDT-style: mutates state but returns NO value. _safeTransfer must accept it.
contract NoReturnToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external {
        allowance[msg.sender][spender] = amount;
    }

    function transfer(address to, uint256 amount) external {
        require(balanceOf[msg.sender] >= amount, "NRT: balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
    }

    function transferFrom(address from, address to, uint256 amount) external {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= amount, "NRT: allowance");
        allowance[from][msg.sender] = allowed - amount;
        require(balanceOf[from] >= amount, "NRT: balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }
}

/// @dev Returns false instead of reverting. _safeTransfer must reject it.
contract FalseReturnToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address, uint256) external pure returns (bool) {
        return false;
    }

    function transferFrom(address, address, uint256) external pure returns (bool) {
        return false;
    }
}

/// @dev Refuses native coin — makes _safeTransferNative fail.
contract RejectingReceiver {
    receive() external payable {
        revert("REJECT: no thanks");
    }
}

/// @dev Tries to re-enter the bridge while being paid out a native release.
contract ReentrantReceiver {
    FerminuxBridge public immutable bridge;
    FerminuxBridge.BridgeTransfer internal _replay;
    FerminuxBridge.Signature[] internal _sigs;
    bool public armed;

    constructor(FerminuxBridge _bridge) {
        bridge = _bridge;
    }

    function arm(FerminuxBridge.BridgeTransfer calldata t, FerminuxBridge.Signature[] calldata sigs) external {
        _replay = t;
        delete _sigs;
        for (uint256 i = 0; i < sigs.length; i++) {
            _sigs.push(sigs[i]);
        }
        armed = true;
    }

    receive() external payable {
        if (armed) {
            armed = false;
            bridge.execute(_replay, _sigs);
        }
    }
}
