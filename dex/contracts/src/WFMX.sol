// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title WFMX — Wrapped FMX
 * @notice The ERC-20 wrapper for the native coin of the Ferminux Network, so
 *         FMX can be routed through pools that only speak ERC-20. Functionally
 *         the WETH9 contract, ported to Solidity 0.8.24.
 *
 *           deposit()   — send FMX, receive the same number of WFMX (1:1)
 *           withdraw()  — burn WFMX, receive the same amount of FMX
 *           receive()   — a plain FMX transfer to this contract is a deposit
 *
 *         totalSupply() is the contract's FMX balance, so the wrapper is fully
 *         collateralised by construction: every WFMX in existence is one FMX
 *         held here.
 *
 * @dev One deliberate deviation from WETH9: `withdraw` pays out with a
 *      full-gas `call` instead of `transfer`'s 2300-gas stipend, so contracts
 *      with non-trivial `receive()` handlers (routers, multisigs, vaults) can
 *      unwrap. This is safe: the balance is debited before the call
 *      (checks-effects-interactions), so a reentrant `withdraw` sees the
 *      already-reduced balance and can never withdraw twice.
 *
 * Self-contained: no external imports.
 */
contract WFMX {
    string public constant name = "Wrapped FMX";
    string public constant symbol = "WFMX";
    uint8 public constant decimals = 18;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event Deposit(address indexed dst, uint256 wad);
    event Withdrawal(address indexed src, uint256 wad);

    /// @notice Wrap native FMX sent with a plain transfer.
    receive() external payable {
        deposit();
    }

    /// @notice Wrap `msg.value` FMX into WFMX.
    function deposit() public payable {
        balanceOf[msg.sender] += msg.value;
        emit Deposit(msg.sender, msg.value);
        emit Transfer(address(0), msg.sender, msg.value);
    }

    /// @notice Unwrap `wad` WFMX back into native FMX.
    function withdraw(uint256 wad) external {
        balanceOf[msg.sender] -= wad; // checked: reverts if the caller is short
        emit Withdrawal(msg.sender, wad);
        emit Transfer(msg.sender, address(0), wad);
        (bool ok,) = payable(msg.sender).call{value: wad}("");
        require(ok, "WFMX: FMX transfer failed");
    }

    /// @notice Always equals this contract's FMX balance — the wrapper is
    ///         1:1 collateralised at every point in time.
    function totalSupply() external view returns (uint256) {
        return address(this).balance;
    }

    function approve(address spender, uint256 wad) external returns (bool) {
        allowance[msg.sender][spender] = wad;
        emit Approval(msg.sender, spender, wad);
        return true;
    }

    function transfer(address dst, uint256 wad) external returns (bool) {
        return transferFrom(msg.sender, dst, wad);
    }

    function transferFrom(address src, address dst, uint256 wad) public returns (bool) {
        if (src != msg.sender) {
            uint256 allowed = allowance[src][msg.sender];
            if (allowed != type(uint256).max) {
                require(allowed >= wad, "WFMX: insufficient allowance");
                unchecked {
                    allowance[src][msg.sender] = allowed - wad;
                }
                emit Approval(src, msg.sender, allowed - wad);
            }
        }
        balanceOf[src] -= wad; // checked
        unchecked {
            // Safe: the sender's balance was just debited by the same amount,
            // and the sum of all balances equals this contract's FMX balance.
            balanceOf[dst] += wad;
        }
        emit Transfer(src, dst, wad);
        return true;
    }
}
