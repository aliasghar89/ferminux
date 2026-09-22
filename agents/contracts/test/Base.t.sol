// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";
import {ServiceEscrow} from "../src/ServiceEscrow.sol";

/// @dev Shared fixture: deploys registry + escrow with the deploy-script ordering.
abstract contract BaseTest is Test {
    AgentRegistry internal registry;
    ServiceEscrow internal escrow;

    address internal deployer = address(this);
    address internal gov = makeAddr("governance");
    address internal treasury = makeAddr("treasury");
    address internal alice = makeAddr("alice"); // agent owner
    address internal bob = makeAddr("bob"); // client
    address internal carol = makeAddr("carol"); // third party

    uint256 internal constant MIN_BOND = 100 ether;
    uint256 internal constant PRICE = 1 ether;

    function setUp() public virtual {
        registry = new AgentRegistry(deployer, MIN_BOND);
        escrow = new ServiceEscrow(registry, deployer, treasury);
        registry.setEscrow(address(escrow));
        registry.setGovernance(gov);
        escrow.setGovernance(gov);

        vm.deal(alice, 1_000 ether);
        vm.deal(bob, 1_000 ether);
        vm.deal(carol, 1_000 ether);
        vm.warp(1_700_000_000);
    }

    function _register(address owner, uint256 bond) internal returns (uint256 id) {
        vm.prank(owner);
        id = registry.register{value: bond}("Scribe", "https://scribe.example", "fmx://payload/0xabc", PRICE);
    }

    function _registerAlice() internal returns (uint256) {
        return _register(alice, MIN_BOND);
    }

    function _request(uint256 agentId, address client, uint256 amount) internal returns (uint256 jobId) {
        vm.prank(client);
        jobId = escrow.requestJob{value: amount}(agentId, keccak256("in"), "fmx://payload/0xin");
    }

    function _deliver(uint256 jobId, address owner) internal {
        vm.prank(owner);
        escrow.deliver(jobId, keccak256("out"), "fmx://payload/0xout");
    }
}

/// @dev Receiver that tries to re-enter escrow.withdraw() / registry.withdrawBond() when paid.
contract Reenterer {
    ServiceEscrow public escrow;
    AgentRegistry public registry;
    uint256 public agentId;
    uint256 public attempts;
    bool public reentered;

    constructor(ServiceEscrow e, AgentRegistry r) {
        escrow = e;
        registry = r;
    }

    function setAgentId(uint256 id) external {
        agentId = id;
    }

    function register(string calldata name) external payable returns (uint256 id) {
        id = registry.register{value: msg.value}(name, "https://evil", "", 1 ether);
        agentId = id;
    }

    function retire() external {
        registry.retire(agentId);
    }

    function withdrawBond() external {
        registry.withdrawBond(agentId);
    }

    function withdraw() external {
        escrow.withdraw();
    }

    function deliver(uint256 jobId) external {
        escrow.deliver(jobId, keccak256("out"), "");
    }

    receive() external payable {
        attempts++;
        if (attempts == 1) {
            // First payout: try to drain again.
            if (address(escrow) != address(0) && escrow.credits(address(this)) == 0) {
                try escrow.withdraw() {
                    reentered = true;
                } catch {}
            }
            if (agentId != 0) {
                try registry.withdrawBond(agentId) {
                    reentered = true;
                } catch {}
            }
        }
    }
}

/// @dev Receiver that rejects all ETH.
contract Rejecter {
    receive() external payable {
        revert("no");
    }
}
