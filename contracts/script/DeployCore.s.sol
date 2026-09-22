// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {MinimalMultisig} from "../src/MinimalMultisig.sol";
import {AZNT} from "../src/AZNT.sol";
import {TokenFactory} from "../src/TokenFactory.sol";
import {Faucet} from "../src/Faucet.sol";
import {FMXVesting} from "../src/FMXVesting.sol";

/**
 * @title DeployCore
 * @notice Deploys the Ferminux core contract stack in dependency order:
 *           1. MinimalMultisig (2-of-3 treasury)
 *           2. AZNT            (admin = multisig)
 *           3. TokenFactory    (feeCollector = multisig)
 *           4. Faucet          (owner = deployer; transfer to multisig when ready)
 *           5. FMXVesting      (beneficiary, 6-month cliff, 36-month duration)
 *
 * Env vars (all optional — defaults target a local anvil devnet):
 *   DEPLOYER_KEY        private key that broadcasts (default: anvil account #0)
 *   MSIG_OWNER1..3      multisig owners            (default: anvil accounts #0-#2)
 *   VESTING_BENEFICIARY team vesting beneficiary   (default: MSIG_OWNER1)
 *
 * Devnet run (own anvil, NOT the live docker devnet):
 *   anvil --port 8547 --chain-id 3961
 *   forge script script/DeployCore.s.sol --rpc-url http://127.0.0.1:8547 --broadcast
 */
contract DeployCore is Script {
    // anvil's deterministic dev accounts — devnet defaults only, NEVER production
    address internal constant DEV_OWNER1 = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266; // anvil #0
    address internal constant DEV_OWNER2 = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8; // anvil #1
    address internal constant DEV_OWNER3 = 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC; // anvil #2
    uint256 internal constant DEV_DEPLOYER_KEY =
        0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80; // anvil #0

    uint64 internal constant CLIFF_SECONDS = 180 days; // ~6 months
    uint64 internal constant DURATION_SECONDS = 1080 days; // ~36 months
    uint256 internal constant THRESHOLD = 2; // 2-of-3

    function run() external {
        uint256 deployerKey = vm.envOr("DEPLOYER_KEY", DEV_DEPLOYER_KEY);
        address owner1 = vm.envOr("MSIG_OWNER1", DEV_OWNER1);
        address owner2 = vm.envOr("MSIG_OWNER2", DEV_OWNER2);
        address owner3 = vm.envOr("MSIG_OWNER3", DEV_OWNER3);
        address beneficiary = vm.envOr("VESTING_BENEFICIARY", owner1);

        address[] memory owners = new address[](3);
        owners[0] = owner1;
        owners[1] = owner2;
        owners[2] = owner3;

        vm.startBroadcast(deployerKey);

        MinimalMultisig msig = new MinimalMultisig(owners, THRESHOLD);
        AZNT aznt = new AZNT(address(msig));
        TokenFactory factory = new TokenFactory(address(msig));
        Faucet faucet = new Faucet();
        FMXVesting vesting = new FMXVesting(beneficiary, uint64(block.timestamp), CLIFF_SECONDS, DURATION_SECONDS);

        vm.stopBroadcast();

        console2.log("MinimalMultisig (2-of-3):", address(msig));
        console2.log("AZNT (admin = multisig): ", address(aznt));
        console2.log("TokenFactory (collector = multisig):", address(factory));
        console2.log("Faucet (owner = deployer):", address(faucet));
        console2.log("FMXVesting (beneficiary):", address(vesting));
        console2.log("  vesting start:", vesting.start());
        console2.log("  vesting cliff (s):", vesting.cliff());
        console2.log("  vesting duration (s):", vesting.duration());
    }
}
