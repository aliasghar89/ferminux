// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {ValidatorHub} from "../src/validators/ValidatorHub.sol";
import {ValidatorHubLens} from "../src/validators/ValidatorHubLens.sol";
import {SinkRouter} from "../src/validators/SinkRouter.sol";

interface IMultisigView {
    function getOwners() external view returns (address[] memory);
    function threshold() external view returns (uint256);
}

interface IRewardSinkView {
    function owner() external view returns (address);
}

/// @notice MAINNET (chain 3961) validator PILOT deploy: the owner's choice of 2026-09-26 — invite-only,
///         at most 20 seats of exactly 2,000 FMX, owner = the foundation multisig, reward budget = a
///         20,000 FMX tranche from FMXRewardSink. Opening to everyone comes only after an external
///         audit (P_OPEN_TO_ALL, one-way, 48 h timelock).
///
///         NEVER run by tooling, CI or an agent: the operator runs it through
///         infra/ops/validators/pilot.sh, which plans first, then applies with a CONFIRM token and
///         keystore signing, and carries out the multisig steps (MinimalMultisig 2-of-3: submit
///         auto-confirms, a second owner confirms, then execute):
///           1. sink.withdraw(hub, 20000 ether)          the reward tranche (sink balance checked first)
///           2. hub.setAllowlist(<pilot-allowlist.txt>, true)   when the file lists anyone
///           3. later, per PLAN 5.2 (after 30 clean days): sink.transferOwnership(router), then
///              router.acceptSinkOwnership()          (pilot.sh router-wire)
///           4. after the external audit: hub.queueParam(7, 1), 48 h later hub.applyParam(7, 1)
///              opens the hub to everyone, once and for good (pilot.sh open-queue / open-apply)
///
///         What this script deploys, in order, from one deployer key (it keeps no power afterwards):
///           - ValidatorHub(owner = multisig, sink = FMXRewardSink, deny list, maxSeats = 20,
///             allowlistOnly = true); the hub deploys its SealEvidence helper in its constructor;
///           - ValidatorHubLens(hub), read-only;
///           - SinkRouter(owner = multisig, sink, hub, reserve = multisig). It holds nothing and does
///             nothing until the multisig hands it the sink (step 3), so deploying it now only fixes
///             its address.
///
///         maxSeats = 20 is a constructor argument, fixed in the deploy transaction, so the pilot
///         cap is public from block one and every later change (to 100, 300, ...) goes through the
///         hub's own 48 h timelock like every other parameter.
///
/// @dev Guards: chain id must be 3961 and CONFIRM_MAINNET must equal CONFIRMATION. The hub's
///      constructor pins nothing (the lab shares chain id 3961), so checkChain() reads the multisig
///      and the sink before the deploy and checkPilot() re-reads every launch value after it. Never
///      rehearse this on the lab: with the mainnet deployer key at the same nonce the lab hub would take
///      the mainnet hub's address and so its signature domain (DeployValidatorsTestnet with LAB=true is
///      the lab path). A rehearsal on an anvil fork of mainnet (infra/ops/validators/rehearse-pilot.sh)
///      is fine: nothing there reaches the chain.
///
///   CONFIRM_MAINNET=deploy-validator-pilot-3961 \
///   forge script script/DeployValidatorsMainnet.s.sol --rpc-url https://rpc.ferminux.net --broadcast --slow \
///     --keystore <file> --password-file <file> --sender <deployer> --with-gas-price 2gwei --priority-gas-price 1gwei
contract DeployValidatorsMainnet is Script {
    string public constant CONFIRMATION = "deploy-validator-pilot-3961";
    address public constant MULTISIG = 0x910BD467D8576277f8f96DF47428377FFD94fEfe;
    address public constant REWARD_SINK = 0x691E5275BF346FfFa0B30174dDBeDfCC078dd8D6;
    uint256 public constant MULTISIG_THRESHOLD = 2;
    uint256 public constant MULTISIG_OWNERS = 3;

    /// The pilot (owner decision 2026-09-26).
    uint256 public constant PILOT_MAX_SEATS = 20;
    bool public constant PILOT_ALLOWLIST_ONLY = true;
    uint256 public constant PILOT_TRANCHE = 20_000 ether;

    struct Out {
        ValidatorHub hub;
        ValidatorHubLens lens;
        SinkRouter router;
    }

    function run() external {
        require(block.chainid == 3961, "chain 3961 only");
        require(
            keccak256(bytes(vm.envOr("CONFIRM_MAINNET", string("")))) == keccak256(bytes(CONFIRMATION)),
            "set CONFIRM_MAINNET: operator-only mainnet deploy"
        );
        checkChain();

        vm.startBroadcast();
        Out memory o = deployAll();
        vm.stopBroadcast();
        checkPilot(o);

        // pilot.sh reads these lines (two leading spaces, name, address)
        console.log("  ValidatorHub", address(o.hub));
        console.log("  SealEvidence", address(o.hub.sealEvidence()));
        console.log("  ValidatorHubLens", address(o.lens));
        console.log("  SinkRouter", address(o.router));
        console.log("  deployBlock", o.hub.deployBlock());
        console.log("  vetoSunsetBlock", o.hub.vetoSunsetBlock());
        console.log("NEXT (multisig, pilot.sh apply): sink.withdraw(hub, 20000 ether); hub.setAllowlist(file)");
    }

    /// @notice The multisig and the sink as the pilot expects them, read before anything is sent.
    function checkChain() public view {
        require(MULTISIG.code.length != 0, "multisig has no code");
        require(IMultisigView(MULTISIG).threshold() == MULTISIG_THRESHOLD, "multisig threshold is not 2");
        require(IMultisigView(MULTISIG).getOwners().length == MULTISIG_OWNERS, "multisig does not have 3 owners");
        require(REWARD_SINK.code.length != 0, "reward sink has no code");
        require(IRewardSinkView(REWARD_SINK).owner() == MULTISIG, "reward sink owner is not the multisig");
    }

    /// @notice Seat owners refused as policy (PLAN 3.1): the five genesis premine wallets (the
    ///         first is also the treasury), the multisig and the reward sink. The allowlist never
    ///         overrides this: openSeat checks the deny list first.
    function denyList() public pure returns (address[] memory d) {
        d = new address[](7);
        d[0] = 0xc0A5Eb613f859f072554F29f1Ab7400265af15aB;
        d[1] = 0xEeDd7368290a17aB2Aa3F298Ff24BB99D581E787;
        d[2] = 0x86e286684Ae5899A941142D143949C444F9Fe831;
        d[3] = 0x040F1E90EF72b364141D91c3C0314ac3b5eCD0AE;
        d[4] = 0x34f5366014EF292fd5ff9FFDE81d47819EF65cFC;
        d[5] = MULTISIG;
        d[6] = REWARD_SINK;
    }

    /// @notice Everything the broadcast creates, as one function the tests exercise.
    function deployAll() public returns (Out memory o) {
        o.hub = new ValidatorHub(MULTISIG, REWARD_SINK, denyList(), PILOT_MAX_SEATS, PILOT_ALLOWLIST_ONLY);
        o.lens = new ValidatorHubLens(o.hub);
        o.router = new SinkRouter(MULTISIG, REWARD_SINK, address(o.hub), MULTISIG);
    }

    /// @notice The launch state of a freshly deployed pilot (PLAN 3.1, 5, 13 and the pilot decision).
    function checkPilot(Out memory o) public view {
        ValidatorHub hub = o.hub;
        require(address(hub).code.length != 0, "hub has no code");
        require(hub.owner() == MULTISIG && hub.pendingOwner() == address(0), "hub owner");
        require(hub.rewardSink() == REWARD_SINK, "hub sink");
        require(hub.maxSeats() == PILOT_MAX_SEATS, "pilot maxSeats");
        require(hub.allowlistOnly() == PILOT_ALLOWLIST_ONLY, "pilot allowlistOnly");
        require(hub.rewardPerAttest() == 0.025 ether, "rewardPerAttest");
        require(hub.activationsPerDay() == 10, "activations per day");
        require(!hub.seatsPaused() && !hub.attestationsPaused(), "paused at launch");
        require(hub.openSeatsBlock() == 0 && hub.seatCount() == 0, "fresh hub");
        require(hub.vetoSunsetBlock() == hub.deployBlock() + 2_221_715, "veto sunset");
        require(address(hub.sealEvidence()).code.length != 0, "SealEvidence");
        address[] memory d = denyList();
        for (uint256 i; i < d.length; ++i) {
            require(hub.denied(d[i]), "deny list");
        }
        require(address(o.lens.hub()) == address(hub), "lens hub");
        SinkRouter r = o.router;
        require(r.owner() == MULTISIG && r.reserve() == MULTISIG, "router owner/reserve");
        require(address(r.sink()) == REWARD_SINK && r.hub() == address(hub), "router wiring");
        require(r.shareBps() == 4_000, "router share");
    }
}
