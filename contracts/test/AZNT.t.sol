// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, stdError} from "forge-std/Test.sol";
import {AZNT} from "../src/AZNT.sol";

contract AZNTTest is Test {
    AZNT internal aznt;

    address internal admin = makeAddr("admin");
    address internal minter = makeAddr("minter");
    address internal burner = makeAddr("burner");
    address internal pauser = makeAddr("pauser");
    address internal blacklister = makeAddr("blacklister");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    uint256 internal ownerKey = 0xA11CE;
    address internal permitOwner;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event RoleGranted(bytes32 indexed role, address indexed account);
    event RoleRevoked(bytes32 indexed role, address indexed account);
    event AdminTransferStarted(address indexed newAdmin);
    event AdminTransferred(address indexed oldAdmin, address indexed newAdmin);
    event Paused(address account);
    event Unpaused(address account);
    event Blacklisted(address indexed account);
    event UnBlacklisted(address indexed account);

    function setUp() public {
        permitOwner = vm.addr(ownerKey);
        aznt = new AZNT(admin);
        vm.startPrank(admin);
        aznt.grantRole(aznt.MINTER(), minter);
        aznt.grantRole(aznt.BURNER(), burner);
        aznt.grantRole(aznt.PAUSER(), pauser);
        aznt.grantRole(aznt.BLACKLISTER(), blacklister);
        vm.stopPrank();
    }

    function _mint(address to, uint256 amount) internal {
        vm.prank(minter);
        aznt.mint(to, amount);
    }

    // ------------------------------------------------------------ metadata

    function test_Metadata() public view {
        assertEq(aznt.name(), "Ferminux Manat");
        assertEq(aznt.symbol(), "AZNT");
        assertEq(aznt.decimals(), 6);
        assertEq(aznt.totalSupply(), 0);
    }

    // ---------------------------------------------------------- constructor

    function test_Constructor_SetsAdmin_EmitsEvent() public {
        vm.expectEmit(true, true, false, false);
        emit AdminTransferred(address(0), admin);
        AZNT fresh = new AZNT(admin);
        assertEq(fresh.admin(), admin);
        assertEq(fresh.pendingAdmin(), address(0));
    }

    function test_Constructor_RevertsOnZeroAdmin() public {
        vm.expectRevert(bytes("AZNT: zero admin"));
        new AZNT(address(0));
    }

    // ----------------------------------------------------------------- roles

    function test_GrantRole_OnlyAdmin() public {
        bytes32 role = aznt.MINTER();
        vm.prank(alice);
        vm.expectRevert(bytes("AZNT: not admin"));
        aznt.grantRole(role, alice);
    }

    function test_GrantRole_SetsAndEmits() public {
        bytes32 role = aznt.MINTER();
        vm.expectEmit(true, true, false, false);
        emit RoleGranted(role, alice);
        vm.prank(admin);
        aznt.grantRole(role, alice);
        assertTrue(aznt.hasRole(role, alice));
    }

    function test_RevokeRole_OnlyAdmin() public {
        bytes32 role = aznt.MINTER();
        vm.prank(alice);
        vm.expectRevert(bytes("AZNT: not admin"));
        aznt.revokeRole(role, minter);
    }

    function test_RevokeRole_ClearsAndEmits() public {
        bytes32 role = aznt.MINTER();
        vm.expectEmit(true, true, false, false);
        emit RoleRevoked(role, minter);
        vm.prank(admin);
        aznt.revokeRole(role, minter);
        assertFalse(aznt.hasRole(role, minter));
        vm.prank(minter);
        vm.expectRevert(bytes("AZNT: missing role"));
        aznt.mint(alice, 1);
    }

    // ------------------------------------------------------ two-step admin

    function test_TransferAdmin_OnlyAdmin() public {
        vm.prank(alice);
        vm.expectRevert(bytes("AZNT: not admin"));
        aznt.transferAdmin(alice);
    }

    function test_TransferAdmin_SetsPending_EmitsEvent() public {
        vm.expectEmit(true, false, false, false);
        emit AdminTransferStarted(alice);
        vm.prank(admin);
        aznt.transferAdmin(alice);
        assertEq(aznt.pendingAdmin(), alice);
        assertEq(aznt.admin(), admin); // unchanged until accepted
    }

    function test_AcceptAdmin_OnlyPending() public {
        vm.prank(admin);
        aznt.transferAdmin(alice);
        vm.prank(bob);
        vm.expectRevert(bytes("AZNT: not pending admin"));
        aznt.acceptAdmin();
    }

    function test_AcceptAdmin_CompletesTransfer() public {
        vm.prank(admin);
        aznt.transferAdmin(alice);
        vm.expectEmit(true, true, false, false);
        emit AdminTransferred(admin, alice);
        vm.prank(alice);
        aznt.acceptAdmin();
        assertEq(aznt.admin(), alice);
        assertEq(aznt.pendingAdmin(), address(0));
        // old admin lost power
        bytes32 role = aznt.MINTER();
        vm.prank(admin);
        vm.expectRevert(bytes("AZNT: not admin"));
        aznt.grantRole(role, bob);
        // new admin has it
        vm.prank(alice);
        aznt.grantRole(role, bob);
        assertTrue(aznt.hasRole(role, bob));
    }

    function test_TransferAdmin_CanBeOverwrittenOrCancelled() public {
        vm.startPrank(admin);
        aznt.transferAdmin(alice);
        aznt.transferAdmin(bob); // overwrite
        assertEq(aznt.pendingAdmin(), bob);
        aznt.transferAdmin(address(0)); // cancel
        assertEq(aznt.pendingAdmin(), address(0));
        vm.stopPrank();
        // nobody (not even address(0) callers) can accept a cancelled transfer
        vm.prank(alice);
        vm.expectRevert(bytes("AZNT: not pending admin"));
        aznt.acceptAdmin();
    }

    // ------------------------------------------------------------------ mint

    function test_Mint_RequiresMinterRole() public {
        vm.prank(alice);
        vm.expectRevert(bytes("AZNT: missing role"));
        aznt.mint(alice, 100);
    }

    function test_Mint_UpdatesSupplyAndBalance_EmitsTransfer() public {
        vm.expectEmit(true, true, false, true);
        emit Transfer(address(0), alice, 1_000_000);
        _mint(alice, 1_000_000);
        assertEq(aznt.totalSupply(), 1_000_000);
        assertEq(aznt.balanceOf(alice), 1_000_000);
    }

    function test_Mint_RevertsWhenPaused() public {
        vm.prank(pauser);
        aznt.pause();
        vm.prank(minter);
        vm.expectRevert(bytes("AZNT: paused"));
        aznt.mint(alice, 1);
    }

    function test_Mint_RevertsToBlacklisted() public {
        vm.prank(blacklister);
        aznt.blacklist(alice);
        vm.prank(minter);
        vm.expectRevert(bytes("AZNT: blacklisted"));
        aznt.mint(alice, 1);
    }

    function testFuzz_Mint(address to, uint256 amount) public {
        vm.assume(to != address(0));
        _mint(to, amount);
        assertEq(aznt.totalSupply(), amount);
        assertEq(aznt.balanceOf(to), amount);
    }

    // ------------------------------------------------------------------ burn

    function test_Burn_RequiresBurnerRole() public {
        _mint(alice, 100);
        vm.prank(alice);
        vm.expectRevert(bytes("AZNT: missing role"));
        aznt.burn(100);
    }

    function test_Burn_UpdatesSupplyAndBalance_EmitsTransfer() public {
        _mint(burner, 500);
        vm.expectEmit(true, true, false, true);
        emit Transfer(burner, address(0), 200);
        vm.prank(burner);
        aznt.burn(200);
        assertEq(aznt.totalSupply(), 300);
        assertEq(aznt.balanceOf(burner), 300);
    }

    function test_Burn_RevertsOnInsufficientBalance() public {
        _mint(burner, 100);
        vm.prank(burner);
        vm.expectRevert(stdError.arithmeticError);
        aznt.burn(101);
    }

    function test_Burn_WorksWhilePaused() public {
        // burn has no whenNotPaused modifier by design (redemption path stays open)
        _mint(burner, 100);
        vm.prank(pauser);
        aznt.pause();
        vm.prank(burner);
        aznt.burn(100);
        assertEq(aznt.totalSupply(), 0);
    }

    // ----------------------------------------------------- destroyBlackFunds

    function test_DestroyBlackFunds_RequiresBlacklisterRole() public {
        vm.prank(alice);
        vm.expectRevert(bytes("AZNT: missing role"));
        aznt.destroyBlackFunds(bob);
    }

    function test_DestroyBlackFunds_RevertsIfNotBlacklisted() public {
        vm.prank(blacklister);
        vm.expectRevert(bytes("AZNT: not blacklisted"));
        aznt.destroyBlackFunds(alice);
    }

    function test_DestroyBlackFunds_ZerosBalanceAndSupply() public {
        _mint(alice, 750);
        _mint(bob, 250);
        vm.startPrank(blacklister);
        aznt.blacklist(alice);
        vm.expectEmit(true, true, false, true);
        emit Transfer(alice, address(0), 750);
        aznt.destroyBlackFunds(alice);
        vm.stopPrank();
        assertEq(aznt.balanceOf(alice), 0);
        assertEq(aznt.totalSupply(), 250);
    }

    // ----------------------------------------------------------------- pause

    function test_Pause_RequiresPauserRole() public {
        vm.prank(alice);
        vm.expectRevert(bytes("AZNT: missing role"));
        aznt.pause();
    }

    function test_PauseUnpause_TogglesAndEmits() public {
        vm.expectEmit(false, false, false, true);
        emit Paused(pauser);
        vm.prank(pauser);
        aznt.pause();
        assertTrue(aznt.paused());

        vm.expectEmit(false, false, false, true);
        emit Unpaused(pauser);
        vm.prank(pauser);
        aznt.unpause();
        assertFalse(aznt.paused());
    }

    function test_Unpause_RequiresPauserRole() public {
        vm.prank(pauser);
        aznt.pause();
        vm.prank(alice);
        vm.expectRevert(bytes("AZNT: missing role"));
        aznt.unpause();
    }

    function test_Paused_BlocksTransfers() public {
        _mint(alice, 100);
        vm.prank(alice);
        aznt.approve(bob, 100);
        vm.prank(pauser);
        aznt.pause();

        vm.prank(alice);
        vm.expectRevert(bytes("AZNT: paused"));
        aznt.transfer(bob, 1);

        vm.prank(bob);
        vm.expectRevert(bytes("AZNT: paused"));
        aznt.transferFrom(alice, bob, 1);

        // resumes after unpause
        vm.prank(pauser);
        aznt.unpause();
        vm.prank(alice);
        aznt.transfer(bob, 1);
        assertEq(aznt.balanceOf(bob), 1);
    }

    // ------------------------------------------------------------- blacklist

    function test_Blacklist_RequiresBlacklisterRole() public {
        vm.prank(alice);
        vm.expectRevert(bytes("AZNT: missing role"));
        aznt.blacklist(bob);
    }

    function test_BlacklistUnblacklist_TogglesAndEmits() public {
        vm.expectEmit(true, false, false, false);
        emit Blacklisted(alice);
        vm.prank(blacklister);
        aznt.blacklist(alice);
        assertTrue(aznt.blacklisted(alice));

        vm.expectEmit(true, false, false, false);
        emit UnBlacklisted(alice);
        vm.prank(blacklister);
        aznt.unBlacklist(alice);
        assertFalse(aznt.blacklisted(alice));
    }

    function test_Blacklist_BlocksTransferPaths() public {
        _mint(alice, 100);
        _mint(bob, 100);
        vm.prank(alice);
        aznt.approve(bob, 100);

        vm.prank(blacklister);
        aznt.blacklist(alice);

        // blacklisted sender
        vm.prank(alice);
        vm.expectRevert(bytes("AZNT: blacklisted"));
        aznt.transfer(bob, 1);

        // blacklisted recipient
        vm.prank(bob);
        vm.expectRevert(bytes("AZNT: blacklisted"));
        aznt.transfer(alice, 1);

        // blacklisted `from` in transferFrom
        vm.prank(bob);
        vm.expectRevert(bytes("AZNT: blacklisted"));
        aznt.transferFrom(alice, bob, 1);

        // blacklisted spender (msg.sender) in transferFrom
        vm.prank(bob);
        aznt.approve(alice, 100);
        vm.prank(alice);
        vm.expectRevert(bytes("AZNT: blacklisted"));
        aznt.transferFrom(bob, bob, 1);

        // unblacklist restores
        vm.prank(blacklister);
        aznt.unBlacklist(alice);
        vm.prank(alice);
        aznt.transfer(bob, 1);
        assertEq(aznt.balanceOf(bob), 101);
    }

    // ------------------------------------------------------------- transfers

    function test_Transfer_MovesBalance_EmitsEvent() public {
        _mint(alice, 100);
        vm.expectEmit(true, true, false, true);
        emit Transfer(alice, bob, 40);
        vm.prank(alice);
        assertTrue(aznt.transfer(bob, 40));
        assertEq(aznt.balanceOf(alice), 60);
        assertEq(aznt.balanceOf(bob), 40);
    }

    function test_Transfer_RevertsToZeroAddress() public {
        _mint(alice, 100);
        vm.prank(alice);
        vm.expectRevert(bytes("AZNT: transfer to zero"));
        aznt.transfer(address(0), 1);
    }

    function test_Transfer_RevertsOnInsufficientBalance() public {
        _mint(alice, 100);
        vm.prank(alice);
        vm.expectRevert(stdError.arithmeticError);
        aznt.transfer(bob, 101);
    }

    function test_Approve_SetsAllowance_EmitsEvent() public {
        vm.expectEmit(true, true, false, true);
        emit Approval(alice, bob, 123);
        vm.prank(alice);
        assertTrue(aznt.approve(bob, 123));
        assertEq(aznt.allowance(alice, bob), 123);
    }

    function test_TransferFrom_SpendsAllowance() public {
        _mint(alice, 100);
        vm.prank(alice);
        aznt.approve(bob, 60);
        vm.prank(bob);
        assertTrue(aznt.transferFrom(alice, bob, 25));
        assertEq(aznt.allowance(alice, bob), 35);
        assertEq(aznt.balanceOf(bob), 25);
    }

    function test_TransferFrom_RevertsOnInsufficientAllowance() public {
        _mint(alice, 100);
        vm.prank(alice);
        aznt.approve(bob, 10);
        vm.prank(bob);
        vm.expectRevert(bytes("AZNT: insufficient allowance"));
        aznt.transferFrom(alice, bob, 11);
    }

    function test_TransferFrom_MaxAllowanceNotDecremented() public {
        _mint(alice, 100);
        vm.prank(alice);
        aznt.approve(bob, type(uint256).max);
        vm.prank(bob);
        aznt.transferFrom(alice, bob, 50);
        assertEq(aznt.allowance(alice, bob), type(uint256).max);
    }

    function testFuzz_TransferRoundTrip(uint256 mintAmount, uint256 sendAmount) public {
        mintAmount = bound(mintAmount, 0, type(uint128).max);
        sendAmount = bound(sendAmount, 0, mintAmount);
        _mint(alice, mintAmount);
        vm.prank(alice);
        aznt.transfer(bob, sendAmount);
        assertEq(aznt.balanceOf(alice), mintAmount - sendAmount);
        assertEq(aznt.balanceOf(bob), sendAmount);
        assertEq(aznt.totalSupply(), mintAmount);
    }

    // ---------------------------------------------------------------- permit

    function _permitDigest(address owner_, address spender, uint256 value, uint256 nonce, uint256 deadline)
        internal
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encodePacked(
                "\x19\x01",
                aznt.DOMAIN_SEPARATOR(),
                keccak256(abi.encode(aznt.PERMIT_TYPEHASH(), owner_, spender, value, nonce, deadline))
            )
        );
    }

    function test_Permit_ValidSignature() public {
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(ownerKey, _permitDigest(permitOwner, bob, 777, aznt.nonces(permitOwner), deadline));

        vm.expectEmit(true, true, false, true);
        emit Approval(permitOwner, bob, 777);
        aznt.permit(permitOwner, bob, 777, deadline, v, r, s);

        assertEq(aznt.allowance(permitOwner, bob), 777);
        assertEq(aznt.nonces(permitOwner), 1);
    }

    function test_Permit_SpendableViaTransferFrom() public {
        _mint(permitOwner, 100);
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(ownerKey, _permitDigest(permitOwner, bob, 100, aznt.nonces(permitOwner), deadline));
        aznt.permit(permitOwner, bob, 100, deadline, v, r, s);
        vm.prank(bob);
        aznt.transferFrom(permitOwner, bob, 100);
        assertEq(aznt.balanceOf(bob), 100);
    }

    function test_Permit_RevertsOnWrongSigner() public {
        uint256 deadline = block.timestamp + 1 hours;
        uint256 wrongKey = 0xBAD;
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(wrongKey, _permitDigest(permitOwner, bob, 777, aznt.nonces(permitOwner), deadline));
        vm.expectRevert(bytes("AZNT: invalid signature"));
        aznt.permit(permitOwner, bob, 777, deadline, v, r, s);
    }

    function test_Permit_RevertsWhenExpired() public {
        uint256 deadline = block.timestamp - 1;
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(ownerKey, _permitDigest(permitOwner, bob, 777, aznt.nonces(permitOwner), deadline));
        vm.expectRevert(bytes("AZNT: permit expired"));
        aznt.permit(permitOwner, bob, 777, deadline, v, r, s);
    }

    function test_Permit_RevertsOnReplay() public {
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(ownerKey, _permitDigest(permitOwner, bob, 777, aznt.nonces(permitOwner), deadline));
        aznt.permit(permitOwner, bob, 777, deadline, v, r, s);
        // nonce moved 0 -> 1, same signature no longer verifies
        vm.expectRevert(bytes("AZNT: invalid signature"));
        aznt.permit(permitOwner, bob, 777, deadline, v, r, s);
    }

    function test_Permit_RevertsOnTamperedValue() public {
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(ownerKey, _permitDigest(permitOwner, bob, 777, aznt.nonces(permitOwner), deadline));
        vm.expectRevert(bytes("AZNT: invalid signature"));
        aznt.permit(permitOwner, bob, 778, deadline, v, r, s); // value changed
    }

    function test_DomainSeparator_RecomputedOnChainIdChange() public {
        bytes32 cached = aznt.DOMAIN_SEPARATOR();
        vm.chainId(999_999);
        bytes32 forked = aznt.DOMAIN_SEPARATOR();
        assertTrue(cached != forked, "separator must change with chainid");

        // permit still works on the new chain id (signature over the fresh separator)
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(ownerKey, _permitDigest(permitOwner, bob, 5, aznt.nonces(permitOwner), deadline));
        aznt.permit(permitOwner, bob, 5, deadline, v, r, s);
        assertEq(aznt.allowance(permitOwner, bob), 5);
    }

    function testFuzz_Permit(uint128 value, uint40 deadlineOffset) public {
        uint256 deadline = block.timestamp + uint256(deadlineOffset);
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(ownerKey, _permitDigest(permitOwner, bob, value, aznt.nonces(permitOwner), deadline));
        aznt.permit(permitOwner, bob, value, deadline, v, r, s);
        assertEq(aznt.allowance(permitOwner, bob), value);
        assertEq(aznt.nonces(permitOwner), 1);
    }
}
