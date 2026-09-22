// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, stdError} from "forge-std/Test.sol";
import {WFMX} from "../src/WFMX.sol";
import {FMXRejector} from "./mocks/Mocks.sol";

contract WFMXTest is Test {
    WFMX internal wfmx;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event Deposit(address indexed dst, uint256 wad);
    event Withdrawal(address indexed src, uint256 wad);

    function setUp() public {
        wfmx = new WFMX();
        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
    }

    function test_Metadata() public view {
        assertEq(wfmx.name(), "Wrapped FMX");
        assertEq(wfmx.symbol(), "WFMX");
        assertEq(wfmx.decimals(), 18);
        assertEq(wfmx.totalSupply(), 0);
    }

    function test_Deposit_MintsOneForOne() public {
        vm.prank(alice);
        vm.expectEmit(true, false, false, true, address(wfmx));
        emit Deposit(alice, 5 ether);
        wfmx.deposit{value: 5 ether}();

        assertEq(wfmx.balanceOf(alice), 5 ether);
        assertEq(wfmx.totalSupply(), 5 ether);
        assertEq(address(wfmx).balance, 5 ether);
        assertEq(alice.balance, 95 ether);
    }

    function test_Receive_IsADeposit() public {
        vm.prank(alice);
        (bool ok,) = address(wfmx).call{value: 2 ether}("");
        assertTrue(ok);
        assertEq(wfmx.balanceOf(alice), 2 ether);
    }

    function test_Withdraw_ReturnsNativeFMX() public {
        vm.startPrank(alice);
        wfmx.deposit{value: 5 ether}();

        vm.expectEmit(true, false, false, true, address(wfmx));
        emit Withdrawal(alice, 3 ether);
        wfmx.withdraw(3 ether);
        vm.stopPrank();

        assertEq(wfmx.balanceOf(alice), 2 ether);
        assertEq(alice.balance, 98 ether);
        assertEq(wfmx.totalSupply(), 2 ether, "supply always equals the FMX held");
    }

    function test_Withdraw_RevertsWithoutBalance() public {
        vm.prank(alice);
        vm.expectRevert(stdError.arithmeticError);
        wfmx.withdraw(1);
    }

    function test_Withdraw_RevertsIfRecipientRejectsFMX() public {
        FMXRejector rejector = new FMXRejector();
        vm.deal(address(rejector), 0);
        vm.prank(alice);
        (bool ok,) = address(wfmx).call{value: 1 ether}("");
        assertTrue(ok);

        vm.prank(alice);
        wfmx.transfer(address(rejector), 1 ether);

        vm.prank(address(rejector));
        vm.expectRevert(bytes("WFMX: FMX transfer failed"));
        wfmx.withdraw(1 ether);
    }

    function test_Transfer() public {
        vm.startPrank(alice);
        wfmx.deposit{value: 5 ether}();
        wfmx.transfer(bob, 2 ether);
        vm.stopPrank();
        assertEq(wfmx.balanceOf(alice), 3 ether);
        assertEq(wfmx.balanceOf(bob), 2 ether);
    }

    function test_TransferFrom_SpendsAllowance() public {
        vm.startPrank(alice);
        wfmx.deposit{value: 5 ether}();
        wfmx.approve(bob, 2 ether);
        vm.stopPrank();

        vm.prank(bob);
        wfmx.transferFrom(alice, bob, 2 ether);
        assertEq(wfmx.allowance(alice, bob), 0);

        vm.prank(bob);
        vm.expectRevert(bytes("WFMX: insufficient allowance"));
        wfmx.transferFrom(alice, bob, 1);
    }

    function test_TransferFrom_InfiniteAllowance() public {
        vm.startPrank(alice);
        wfmx.deposit{value: 5 ether}();
        wfmx.approve(bob, type(uint256).max);
        vm.stopPrank();

        vm.prank(bob);
        wfmx.transferFrom(alice, bob, 1 ether);
        assertEq(wfmx.allowance(alice, bob), type(uint256).max);
    }

    function test_TransferFrom_RevertsOverBalance() public {
        vm.prank(alice);
        wfmx.deposit{value: 1 ether}();
        vm.prank(alice);
        vm.expectRevert(stdError.arithmeticError);
        wfmx.transfer(bob, 2 ether);
    }

    function testFuzz_DepositWithdrawRoundTrip(uint96 amount) public {
        vm.assume(amount > 0);
        vm.deal(alice, amount);
        vm.startPrank(alice);
        wfmx.deposit{value: amount}();
        assertEq(wfmx.totalSupply(), amount);
        wfmx.withdraw(amount);
        vm.stopPrank();
        assertEq(alice.balance, amount);
        assertEq(wfmx.totalSupply(), 0);
    }

    /// @notice Every WFMX in existence is backed by exactly one FMX held here.
    function test_Invariant_FullyCollateralised() public {
        vm.prank(alice);
        wfmx.deposit{value: 5 ether}();
        vm.prank(bob);
        wfmx.deposit{value: 3 ether}();
        assertEq(wfmx.balanceOf(alice) + wfmx.balanceOf(bob), address(wfmx).balance);
        assertEq(wfmx.totalSupply(), address(wfmx).balance);
    }
}
