// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {Test} from "forge-std/Test.sol";
import {FerminuxAgents} from "../src/FerminuxAgents.sol";

contract FerminuxAgentsTest is Test {
    FerminuxAgents n; address gov = address(0xA11CE); address bob = address(0xB0B);
    function setUp() public { n = new FerminuxAgents(gov, 50 ether, "https://ferminux.net/nft/agents/meta/"); vm.deal(bob, 1000 ether); }
    function testMintAndURI() public {
        vm.prank(bob); n.mint{value: 50 ether}(13);
        assertEq(n.ownerOf(13), bob); assertEq(n.totalSupply(), 1);
        assertEq(n.tokenURI(13), "https://ferminux.net/nft/agents/meta/13.json");
        assertEq(address(n).balance, 50 ether);
    }
    function testMintRejects() public {
        vm.startPrank(bob);
        vm.expectRevert(FerminuxAgents.WrongPayment.selector); n.mint{value: 1 ether}(1);
        vm.expectRevert(FerminuxAgents.BadId.selector); n.mint{value: 50 ether}(42);
        n.mint{value: 50 ether}(1);
        vm.expectRevert(FerminuxAgents.AlreadyMinted.selector); n.mint{value: 50 ether}(1);
        vm.stopPrank();
    }
    function testReserveWithdrawPause() public {
        uint256[] memory ids = new uint256[](2); ids[0] = 41; ids[1] = 40;
        vm.prank(bob); vm.expectRevert(FerminuxAgents.NotOwner.selector); n.reserve(ids, bob);
        vm.prank(gov); n.reserve(ids, gov); assertEq(n.ownerOf(41), gov); assertEq(n.totalSupply(), 2);
        vm.prank(bob); n.mint{value: 50 ether}(2);
        vm.prank(gov); n.withdraw(); assertEq(gov.balance, 50 ether);
        vm.prank(gov); n.setPaused(true);
        vm.prank(bob); vm.expectRevert(FerminuxAgents.SalePaused.selector); n.mint{value: 50 ether}(3);
    }
    function testTransferAndApprove() public {
        vm.prank(bob); n.mint{value: 50 ether}(5);
        vm.prank(gov); vm.expectRevert(FerminuxAgents.NotAuthorized.selector); n.transferFrom(bob, gov, 5);
        vm.prank(bob); n.approve(gov, 5);
        vm.prank(gov); n.transferFrom(bob, gov, 5); assertEq(n.ownerOf(5), gov); assertEq(n.balanceOf(bob), 0);
    }
}
