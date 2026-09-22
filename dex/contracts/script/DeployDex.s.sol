// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {FerminuxFactory} from "../src/FerminuxFactory.sol";
import {FerminuxRouter} from "../src/FerminuxRouter.sol";
import {LiquidityLocker} from "../src/LiquidityLocker.sol";
import {WFMX} from "../src/WFMX.sol";

/**
 * @title DeployDex
 * @notice Deploys the Ferminux DEX stack in dependency order:
 *           1. WFMX            (wrapped native FMX)
 *           2. FerminuxFactory (feeToSetter = treasury/multisig)
 *           3. FerminuxRouter  (bound to the factory + WFMX, immutably)
 *           4. LiquidityLocker (no owner, no admin, nothing to configure)
 *
 *         The protocol fee starts OFF: `feeTo` is address(0) until the
 *         `feeToSetter` turns it on, so 100% of the 0.30% goes to LPs.
 *
 * Env vars (all optional — the defaults target a local anvil devnet):
 *   DEPLOYER_KEY   private key that broadcasts   (default: anvil account #0)
 *   FEE_TO_SETTER  owner of the protocol-fee switch (default: anvil account #0)
 *   WFMX_ADDRESS   reuse an already-deployed WFMX  (default: deploy a new one)
 *
 * Devnet run (your own anvil, never a live chain):
 *   anvil --port 8600 --chain-id 3961
 *   forge script script/DeployDex.s.sol --rpc-url http://127.0.0.1:8600 --broadcast
 */
contract DeployDex is Script {
    // anvil's deterministic dev accounts — devnet defaults only, NEVER production
    address internal constant DEV_ACCOUNT0 = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266;
    uint256 internal constant DEV_DEPLOYER_KEY = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;

    function run() external returns (address wfmx, address factory, address router, address locker) {
        uint256 deployerKey = vm.envOr("DEPLOYER_KEY", DEV_DEPLOYER_KEY);
        address feeToSetter = vm.envOr("FEE_TO_SETTER", DEV_ACCOUNT0);
        address existingWfmx = vm.envOr("WFMX_ADDRESS", address(0));

        vm.startBroadcast(deployerKey);

        wfmx = existingWfmx == address(0) ? address(new WFMX()) : existingWfmx;
        FerminuxFactory f = new FerminuxFactory(feeToSetter);
        FerminuxRouter r = new FerminuxRouter(address(f), wfmx);
        LiquidityLocker l = new LiquidityLocker();

        vm.stopBroadcast();

        factory = address(f);
        router = address(r);
        locker = address(l);

        console2.log("WFMX:            ", wfmx);
        console2.log("FerminuxFactory: ", factory);
        console2.log("  feeToSetter:   ", f.feeToSetter());
        console2.log("  feeTo (OFF):   ", f.feeTo());
        console2.log("FerminuxRouter:  ", router);
        console2.log("LiquidityLocker: ", locker);
        console2.log("INIT_CODE_PAIR_HASH:");
        console2.logBytes32(f.INIT_CODE_PAIR_HASH());

        require(f.INIT_CODE_PAIR_HASH() == f.pairInitCodeHash(), "DEPLOY: stale INIT_CODE_PAIR_HASH");
    }
}
