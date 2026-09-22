// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title TransferHelper
 * @notice ERC-20 calls that tolerate the two ways real tokens misbehave:
 *         returning nothing at all (USDT and friends) and returning `false`
 *         instead of reverting. Success requires the call to succeed AND to
 *         either return nothing or return `true`.
 */
library TransferHelper {
    function safeApprove(address token, address to, uint256 value) internal {
        // bytes4(keccak256("approve(address,uint256)"))
        (bool success, bytes memory data) = token.call(abi.encodeWithSelector(0x095ea7b3, to, value));
        require(success && (data.length == 0 || abi.decode(data, (bool))), "TH: approve failed");
    }

    function safeTransfer(address token, address to, uint256 value) internal {
        // bytes4(keccak256("transfer(address,uint256)"))
        (bool success, bytes memory data) = token.call(abi.encodeWithSelector(0xa9059cbb, to, value));
        require(success && (data.length == 0 || abi.decode(data, (bool))), "TH: transfer failed");
    }

    function safeTransferFrom(address token, address from, address to, uint256 value) internal {
        // bytes4(keccak256("transferFrom(address,address,uint256)"))
        (bool success, bytes memory data) = token.call(abi.encodeWithSelector(0x23b872dd, from, to, value));
        require(success && (data.length == 0 || abi.decode(data, (bool))), "TH: transferFrom failed");
    }

    /// @notice Native FMX transfer with all remaining gas forwarded.
    function safeTransferFMX(address to, uint256 value) internal {
        (bool success,) = to.call{value: value}(new bytes(0));
        require(success, "TH: FMX transfer failed");
    }
}
