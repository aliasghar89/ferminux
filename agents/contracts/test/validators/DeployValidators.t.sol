// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ValidatorHub} from "../../src/validators/ValidatorHub.sol";
import {SinkRouter} from "../../src/validators/SinkRouter.sol";
import {ValidatorHubLens} from "../../src/validators/ValidatorHubLens.sol";
import {DeployValidatorsTestnet} from "../../script/DeployValidatorsTestnet.s.sol";
import {DeployValidatorsMainnet} from "../../script/DeployValidatorsMainnet.s.sol";
import {FMXRewardSink} from "./utils/FMXRewardSink.sol";

/// @notice Exercises the deploy scripts' functions inside the test EVM only. Nothing here talks to
///         a network or broadcasts; the mainnet script's pinned constants and post-deploy checks
///         run under vm.chainId(3961).
contract DeployValidatorsTest is Test {
    function test_Testnet_DeploysWiredStack() public {
        DeployValidatorsTestnet s = new DeployValidatorsTestnet();
        address owner = makeAddr("owner");
        address reserve = makeAddr("reserve");
        address[] memory deny = new address[](1);
        deny[0] = makeAddr("premine");
        DeployValidatorsTestnet.Out memory o = s.deployAll(owner, address(0), reserve, deny);
        assertEq(o.hub.owner(), owner);
        assertEq(o.hub.rewardSink(), o.sink);
        assertTrue(o.hub.denied(deny[0]));
        assertEq(address(o.lens.hub()), address(o.hub));
        assertEq(o.router.owner(), owner);
        assertEq(o.router.reserve(), reserve);
        assertEq(address(o.router.sink()), o.sink);
        assertEq(o.router.hub(), address(o.hub));
        assertEq(o.hub.maxSeats(), 100);
    }

    /// The lab shares chain id 3961 with mainnet, so its hub must never share the mainnet hub's
    /// address (and with it the signature domain), even when deployed by the same key at the
    /// same nonce the mainnet script would use.
    function test_Lab_HubAddressNeverEqualsADirectDeploy() public {
        vm.chainId(3961);
        DeployValidatorsTestnet s = new DeployValidatorsTestnet();
        address owner = makeAddr("lab-owner");
        uint64 nonce = vm.getNonce(address(s));
        address direct = vm.computeCreateAddress(address(s), nonce + 1); // the slot after the sink
        DeployValidatorsTestnet.Out memory o = s.deployAll(owner, address(0), owner, new address[](0));
        address factory = vm.computeCreateAddress(address(s), nonce + 1);
        assertEq(address(o.hub), vm.computeCreateAddress(factory, 1), "hub created by LabHubDeployer");
        assertTrue(address(o.hub) != direct, "not where a direct deploy from the same key and nonce lands");
        assertEq(o.hub.owner(), owner);
        assertEq(o.hub.rewardSink(), o.sink);
        assertEq(address(o.lens.hub()), address(o.hub));
        assertEq(o.router.hub(), address(o.hub));
        // off 3961 (devnet, public testnet) the hub is created directly
        vm.chainId(39_611);
        nonce = vm.getNonce(address(s));
        o = s.deployAll(owner, address(0), owner, new address[](0));
        assertEq(address(o.hub), vm.computeCreateAddress(address(s), nonce + 1));
    }

    function test_Testnet_RefusesChain3961UnlessLab() public {
        DeployValidatorsTestnet s = new DeployValidatorsTestnet();
        vm.chainId(3961);
        vm.expectRevert(bytes("chain 3961: use DeployValidatorsMainnet (operator only)"));
        s.run();
        vm.setEnv("LAB", "true");
        vm.setEnv("OWNER", "0x910BD467D8576277f8f96DF47428377FFD94fEfe");
        vm.expectRevert(bytes("LAB needs OWNER set to a lab key"));
        s.run();
        vm.setEnv("LAB", "false");
        vm.setEnv("OWNER", "0x0000000000000000000000000000000000000000");
    }

    function test_Testnet_PilotShape() public {
        DeployValidatorsTestnet s = new DeployValidatorsTestnet();
        address owner = makeAddr("owner");
        DeployValidatorsTestnet.Out memory o = s.deployAll(owner, address(0), owner, new address[](0), 20, true);
        assertEq(o.hub.maxSeats(), 20);
        assertTrue(o.hub.allowlistOnly());
    }

    /// Mainnet needs the 2-of-3 multisig and the reward sink it owns at their real addresses.
    function _mainnetFixtures() internal {
        vm.chainId(3961);
        address msig = 0x910BD467D8576277f8f96DF47428377FFD94fEfe;
        address sinkAt = 0x691E5275BF346FfFa0B30174dDBeDfCC078dd8D6;
        vm.etch(msig, address(new MultisigStandIn()).code);
        vm.etch(sinkAt, address(new FMXRewardSink(msig)).code);
        vm.store(sinkAt, bytes32(uint256(0)), bytes32(uint256(uint160(msig)))); // FMXRewardSink.owner
    }

    function test_Mainnet_DeploysThePilot() public {
        DeployValidatorsMainnet s = new DeployValidatorsMainnet();
        _mainnetFixtures();
        s.checkChain();
        DeployValidatorsMainnet.Out memory o = s.deployAll();
        s.checkPilot(o);
        ValidatorHub hub = o.hub;
        assertEq(hub.maxSeats(), 20, "the pilot cap");
        assertTrue(hub.allowlistOnly(), "invite-only");
        assertEq(hub.owner(), 0x910BD467D8576277f8f96DF47428377FFD94fEfe);
        assertEq(hub.rewardSink(), 0x691E5275BF346FfFa0B30174dDBeDfCC078dd8D6);
        assertTrue(hub.denied(0xc0A5Eb613f859f072554F29f1Ab7400265af15aB), "treasury / first premine");
        assertTrue(hub.denied(0x910BD467D8576277f8f96DF47428377FFD94fEfe), "multisig");
        assertEq(address(o.lens.hub()), address(hub));
        assertEq(o.router.shareBps(), 4_000);
        assertEq(o.router.reserve(), 0x910BD467D8576277f8f96DF47428377FFD94fEfe);
        assertEq(s.PILOT_TRANCHE(), 20_000 ether);
    }

    function test_Mainnet_CheckChainRefusesAWrongSinkOwner() public {
        DeployValidatorsMainnet s = new DeployValidatorsMainnet();
        _mainnetFixtures();
        vm.store(0x691E5275BF346FfFa0B30174dDBeDfCC078dd8D6, bytes32(uint256(0)), bytes32(uint256(0xBEEF)));
        vm.expectRevert(bytes("reward sink owner is not the multisig"));
        s.checkChain();
    }

    function test_Mainnet_CheckPilotRefusesAnOpenHub() public {
        DeployValidatorsMainnet s = new DeployValidatorsMainnet();
        _mainnetFixtures();
        DeployValidatorsMainnet.Out memory o = s.deployAll();
        o.hub = new ValidatorHub(
            0x910BD467D8576277f8f96DF47428377FFD94fEfe,
            0x691E5275BF346FfFa0B30174dDBeDfCC078dd8D6,
            s.denyList(),
            20,
            false
        );
        vm.expectRevert(bytes("pilot allowlistOnly"));
        s.checkPilot(o);
    }

    function test_Mainnet_RunRefusesWithoutChainAndConfirmation() public {
        DeployValidatorsMainnet s = new DeployValidatorsMainnet();
        vm.expectRevert(bytes("chain 3961 only"));
        s.run();
        vm.chainId(3961);
        vm.expectRevert(bytes("set CONFIRM_MAINNET: operator-only mainnet deploy"));
        s.run();
    }
}

/// The multisig's two views the mainnet script reads (MinimalMultisig 2-of-3).
contract MultisigStandIn {
    function getOwners() external pure returns (address[] memory o) {
        o = new address[](3);
        o[0] = 0x1a143bf911E1E097730f3aA8C809C6B9109019EA;
        o[1] = 0x0fBBa0CC0e4f748Dc2Af25dDD3992700e7FCce15;
        o[2] = 0x11B53110eb83c548b392a56410bF5f959E6F41db;
    }

    function threshold() external pure returns (uint256) {
        return 2;
    }
}
