// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Faucet} from "../src/Faucet.sol";

/// @dev Calls drip() but rejects the payout — exercises "Faucet: send failed".
contract RejectingDripper {
    Faucet internal immutable faucet;

    constructor(Faucet _faucet) {
        faucet = _faucet;
    }

    function go() external {
        faucet.drip();
    }
    // no receive / no fallback
}

/// @dev Owner that rejects the withdraw payout — exercises "Faucet: withdraw failed".
contract RejectingOwner {
    Faucet internal immutable faucet;

    constructor(Faucet _faucet) {
        faucet = _faucet;
    }

    function doWithdraw(uint256 amount) external {
        faucet.withdraw(amount);
    }
    // no receive / no fallback
}

contract FaucetTest is Test {
    Faucet internal faucet;

    address internal deployer = makeAddr("deployer");
    address internal user = makeAddr("user");
    address internal rando = makeAddr("rando");

    event Dripped(address indexed to, uint256 amount);
    event Config(uint256 dripAmount, uint256 cooldown);

    function setUp() public {
        vm.warp(1_700_000_000);
        vm.prank(deployer);
        faucet = new Faucet();
        vm.deal(address(faucet), 100 ether);
    }

    // ---------------------------------------------------------- constructor

    function test_Constructor_OwnerIsDeployer_Defaults() public view {
        assertEq(faucet.owner(), deployer);
        assertEq(faucet.dripAmount(), 0.5 ether);
        assertEq(faucet.cooldown(), 24 hours);
    }

    function test_Receive_AcceptsFunding() public {
        vm.deal(rando, 1 ether);
        vm.prank(rando);
        (bool ok,) = address(faucet).call{value: 1 ether}("");
        assertTrue(ok);
        assertEq(address(faucet).balance, 101 ether);
    }

    // ------------------------------------------------------------------ drip

    function test_Drip_PaysAndRecordsTimestamp() public {
        vm.expectEmit(true, false, false, true);
        emit Dripped(user, 0.5 ether);
        vm.prank(user);
        faucet.drip();
        assertEq(user.balance, 0.5 ether);
        assertEq(faucet.lastDrip(user), block.timestamp);
        assertEq(address(faucet).balance, 99.5 ether);
    }

    function test_Drip_RevertsDuringCooldown() public {
        vm.prank(user);
        faucet.drip();
        vm.warp(block.timestamp + 24 hours - 1);
        vm.prank(user);
        vm.expectRevert(bytes("Faucet: cooldown"));
        faucet.drip();
    }

    function test_Drip_WorksExactlyAtCooldownBoundary() public {
        vm.prank(user);
        faucet.drip();
        vm.warp(block.timestamp + 24 hours);
        vm.prank(user);
        faucet.drip();
        assertEq(user.balance, 1 ether);
    }

    function test_Drip_CooldownIsPerAddress() public {
        vm.prank(user);
        faucet.drip();
        vm.prank(rando);
        faucet.drip(); // different address, no shared cooldown
        assertEq(rando.balance, 0.5 ether);
    }

    function test_Drip_RevertsWhenEmpty() public {
        vm.prank(deployer);
        faucet.withdraw(100 ether); // drain
        vm.prank(user);
        vm.expectRevert(bytes("Faucet: empty"));
        faucet.drip();
    }

    function test_Drip_RevertsWhenBalanceBelowDripAmount() public {
        vm.prank(deployer);
        faucet.withdraw(99.6 ether); // 0.4 left < 0.5 drip
        vm.prank(user);
        vm.expectRevert(bytes("Faucet: empty"));
        faucet.drip();
    }

    function test_Drip_RevertsWhenReceiverRejects() public {
        RejectingDripper bad = new RejectingDripper(faucet);
        vm.expectRevert(bytes("Faucet: send failed"));
        bad.go();
        // failed drip must not burn the cooldown
        assertEq(faucet.lastDrip(address(bad)), 0);
    }

    // ------------------------------------------------------------- setConfig

    function test_SetConfig_OnlyOwner() public {
        vm.prank(rando);
        vm.expectRevert(bytes("Faucet: not owner"));
        faucet.setConfig(1 ether, 1 hours);
    }

    function test_SetConfig_UpdatesAndEmits() public {
        vm.expectEmit(false, false, false, true);
        emit Config(2 ether, 1 hours);
        vm.prank(deployer);
        faucet.setConfig(2 ether, 1 hours);
        assertEq(faucet.dripAmount(), 2 ether);
        assertEq(faucet.cooldown(), 1 hours);

        // new config takes effect
        vm.prank(user);
        faucet.drip();
        assertEq(user.balance, 2 ether);
        vm.warp(block.timestamp + 1 hours);
        vm.prank(user);
        faucet.drip();
        assertEq(user.balance, 4 ether);
    }

    function testFuzz_SetConfig(uint256 dripAmount, uint256 cooldown) public {
        vm.prank(deployer);
        faucet.setConfig(dripAmount, cooldown);
        assertEq(faucet.dripAmount(), dripAmount);
        assertEq(faucet.cooldown(), cooldown);
    }

    // -------------------------------------------------------------- withdraw

    function test_Withdraw_OnlyOwner() public {
        vm.prank(rando);
        vm.expectRevert(bytes("Faucet: not owner"));
        faucet.withdraw(1 ether);
    }

    function test_Withdraw_PaysOwner() public {
        vm.prank(deployer);
        faucet.withdraw(40 ether);
        assertEq(deployer.balance, 40 ether);
        assertEq(address(faucet).balance, 60 ether);
    }

    function test_Withdraw_RevertsOnInsufficientBalance() public {
        vm.prank(deployer);
        vm.expectRevert(bytes("Faucet: withdraw failed"));
        faucet.withdraw(101 ether);
    }

    function test_Withdraw_RevertsWhenOwnerRejects() public {
        RejectingOwner bad = new RejectingOwner(faucet);
        vm.prank(deployer);
        faucet.transferOwnership(address(bad));
        vm.expectRevert(bytes("Faucet: withdraw failed"));
        bad.doWithdraw(1 ether);
    }

    // ----------------------------------------------------- transferOwnership

    function test_TransferOwnership_OnlyOwner() public {
        vm.prank(rando);
        vm.expectRevert(bytes("Faucet: not owner"));
        faucet.transferOwnership(rando);
    }

    function test_TransferOwnership_RevertsOnZero() public {
        vm.prank(deployer);
        vm.expectRevert(bytes("Faucet: zero owner"));
        faucet.transferOwnership(address(0));
    }

    function test_TransferOwnership_HandsOverControl() public {
        vm.prank(deployer);
        faucet.transferOwnership(rando);
        assertEq(faucet.owner(), rando);

        // old owner locked out
        vm.prank(deployer);
        vm.expectRevert(bytes("Faucet: not owner"));
        faucet.setConfig(1 ether, 1 hours);

        // new owner in control
        vm.prank(rando);
        faucet.setConfig(1 ether, 1 hours);
        assertEq(faucet.dripAmount(), 1 ether);
    }
}
