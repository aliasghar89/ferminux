// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {FMXStaking} from "../src/FMXStaking.sol";

/**
 * @title FundRewards
 * @notice Moves a chosen amount of native FMX from a funder into the
 *         FMXStaking reward pool via fundRewards(). Funding does not bump the
 *         accumulator — it only extends the runway.
 *
 * Env vars:
 *   STAKING      address of the deployed FMXStaking          (required)
 *   AMOUNT_FMX   whole-FMX amount to move, e.g. 1500000      (one of these
 *   AMOUNT_WEI   exact wei amount                             two required;
 *                                                             WEI wins if both)
 *   FUNDER_KEY   private key of the funder (default: anvil account #0;
 *                mainnet: the ecosystem wallet holder signs, or the multisig
 *                submits a fundRewards() call with value)
 *
 * Devnet run (own anvil on the assigned port, NOT the live chain):
 *   STAKING=0x... AMOUNT_FMX=1500000 \
 *   forge script script/FundRewards.s.sol --rpc-url http://127.0.0.1:8610 --broadcast
 */
contract FundRewards is Script {
    uint256 internal constant DEV_FUNDER_KEY =
        0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80; // anvil #0

    function run() external {
        address stakingAddr = vm.envAddress("STAKING");
        uint256 amount = vm.envOr("AMOUNT_WEI", uint256(0));
        if (amount == 0) {
            amount = vm.envUint("AMOUNT_FMX") * 1 ether;
        }
        require(amount > 0, "FUND: zero amount");
        uint256 funderKey = vm.envOr("FUNDER_KEY", DEV_FUNDER_KEY);

        FMXStaking staking = FMXStaking(stakingAddr);
        uint256 before = staking.rewardPool();

        vm.startBroadcast(funderKey);
        staking.fundRewards{value: amount}();
        vm.stopBroadcast();

        console2.log("Funded (wei):     ", amount);
        console2.log("Pool before (wei):", before);
        console2.log("Pool after (wei): ", staking.rewardPool());
    }
}
