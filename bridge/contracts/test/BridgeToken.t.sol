// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, stdError} from "forge-std/Test.sol";
import {BridgeToken} from "../src/BridgeToken.sol";

contract BridgeTokenTest is Test {
    uint64 internal constant LOCAL_CHAIN = 3961;
    uint64 internal constant ORIGIN_CHAIN = 1;
    address internal constant ORIGIN_TOKEN = address(0xF3F3);

    BridgeToken internal token;

    address internal bridge = makeAddr("bridge");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event BridgeMinted(address indexed to, uint256 amount);
    event BridgeBurned(address indexed from, uint256 amount);

    function setUp() public {
        vm.chainId(LOCAL_CHAIN);
        token = new BridgeToken("Wrapped RMT", "wRMT", 18, bridge, ORIGIN_CHAIN, ORIGIN_TOKEN);
    }

    function _mint(address to, uint256 amount) internal {
        vm.prank(bridge);
        token.mint(to, amount);
        // burn() is allowance-gated, so a holder must approve the bridge exactly
        // as they would before any transferFrom. Fixtures model that holder.
        vm.prank(to);
        token.approve(bridge, type(uint256).max);
    }

    // ---------------------------------------------------------- constructor

    function test_Constructor_MirrorsOriginMetadata() public view {
        assertEq(token.name(), "Wrapped RMT");
        assertEq(token.symbol(), "wRMT");
        assertEq(token.decimals(), 18);
        assertEq(token.bridge(), bridge);
        assertEq(token.originChainId(), ORIGIN_CHAIN);
        assertEq(token.originToken(), ORIGIN_TOKEN);
        assertEq(token.totalSupply(), 0);
    }

    function test_Constructor_MirrorsNonEighteenDecimals() public {
        BridgeToken six = new BridgeToken("Wrapped AZNT", "wAZNT", 6, bridge, ORIGIN_CHAIN, ORIGIN_TOKEN);
        assertEq(six.decimals(), 6);
    }

    function test_Constructor_AllowsNativeOriginToken() public {
        BridgeToken wfmx = new BridgeToken("Wrapped FMX", "wFMX", 18, bridge, ORIGIN_CHAIN, address(0));
        assertEq(wfmx.originToken(), address(0));
    }

    function test_Constructor_RevertsOnEmptyName() public {
        vm.expectRevert(bytes("WTOKEN: name len"));
        new BridgeToken("", "wRMT", 18, bridge, ORIGIN_CHAIN, ORIGIN_TOKEN);
    }

    function test_Constructor_RevertsOnEmptySymbol() public {
        vm.expectRevert(bytes("WTOKEN: symbol len"));
        new BridgeToken("Wrapped RMT", "", 18, bridge, ORIGIN_CHAIN, ORIGIN_TOKEN);
    }

    function test_Constructor_RevertsOnTooManyDecimals() public {
        vm.expectRevert(bytes("WTOKEN: decimals"));
        new BridgeToken("Wrapped RMT", "wRMT", 19, bridge, ORIGIN_CHAIN, ORIGIN_TOKEN);
    }

    function test_Constructor_RevertsOnZeroBridge() public {
        vm.expectRevert(bytes("WTOKEN: zero bridge"));
        new BridgeToken("Wrapped RMT", "wRMT", 18, address(0), ORIGIN_CHAIN, ORIGIN_TOKEN);
    }

    function test_Constructor_RevertsOnZeroOriginChain() public {
        vm.expectRevert(bytes("WTOKEN: zero origin chain"));
        new BridgeToken("Wrapped RMT", "wRMT", 18, bridge, 0, ORIGIN_TOKEN);
    }

    function test_Constructor_RevertsWhenOriginIsLocalChain() public {
        vm.expectRevert(bytes("WTOKEN: origin is local"));
        new BridgeToken("Wrapped RMT", "wRMT", 18, bridge, LOCAL_CHAIN, ORIGIN_TOKEN);
    }

    // ----------------------------------------------------------- supply

    function test_Mint_OnlyBridge() public {
        vm.expectEmit(true, true, true, true);
        emit Transfer(address(0), alice, 100 ether);
        vm.expectEmit(true, true, true, true);
        emit BridgeMinted(alice, 100 ether);
        _mint(alice, 100 ether);

        assertEq(token.balanceOf(alice), 100 ether);
        assertEq(token.totalSupply(), 100 ether);
    }

    function test_Mint_RevertsForNonBridge() public {
        vm.prank(alice);
        vm.expectRevert(bytes("WTOKEN: not bridge"));
        token.mint(alice, 1 ether);
    }

    function test_Mint_RevertsForZeroRecipient() public {
        vm.prank(bridge);
        vm.expectRevert(bytes("WTOKEN: mint to zero"));
        token.mint(address(0), 1 ether);
    }

    function test_Burn_OnlyBridge() public {
        _mint(alice, 100 ether);

        vm.expectEmit(true, true, true, true);
        emit Transfer(alice, address(0), 40 ether);
        vm.expectEmit(true, true, true, true);
        emit BridgeBurned(alice, 40 ether);
        vm.prank(bridge);
        token.burn(alice, 40 ether);

        assertEq(token.balanceOf(alice), 60 ether);
        assertEq(token.totalSupply(), 60 ether);
    }

    function test_Burn_RevertsForNonBridge() public {
        _mint(alice, 100 ether);
        vm.prank(alice);
        vm.expectRevert(bytes("WTOKEN: not bridge"));
        token.burn(alice, 1 ether);
    }

    function test_Burn_RevertsOnInsufficientBalance() public {
        _mint(alice, 1 ether);
        // The allowance check runs before the balance subtraction, so an
        // over-burn is rejected as an allowance failure rather than as an
        // arithmetic underflow. _mint approves type(uint256).max, so narrow the
        // allowance here to exercise the BALANCE path deliberately.
        vm.prank(alice);
        token.approve(bridge, 2 ether);
        vm.prank(bridge);
        vm.expectRevert(stdError.arithmeticError);
        token.burn(alice, 2 ether);
    }

    function test_NoOwnerMintExists() public view {
        // There is no owner() and no privileged mint other than the bridge's.
        // Probing an owner()/mint(uint256) surface must find nothing.
        (bool okOwner,) = address(token).staticcall(abi.encodeWithSignature("owner()"));
        assertFalse(okOwner);
        (bool okMint,) = address(token).staticcall(abi.encodeWithSignature("mint(uint256)"));
        assertFalse(okMint);
    }

    // --------------------------------------------------------- transfers

    function test_Transfer_MovesBalance() public {
        _mint(alice, 100 ether);
        vm.prank(alice);
        assertTrue(token.transfer(bob, 30 ether));
        assertEq(token.balanceOf(alice), 70 ether);
        assertEq(token.balanceOf(bob), 30 ether);
        assertEq(token.totalSupply(), 100 ether);
    }

    function test_Transfer_RevertsToZero() public {
        _mint(alice, 100 ether);
        vm.prank(alice);
        vm.expectRevert(bytes("WTOKEN: transfer to zero"));
        token.transfer(address(0), 1 ether);
    }

    function test_Transfer_RevertsOnInsufficientBalance() public {
        _mint(alice, 1 ether);
        vm.prank(alice);
        vm.expectRevert(stdError.arithmeticError);
        token.transfer(bob, 2 ether);
    }

    function test_Approve_AndTransferFrom() public {
        _mint(alice, 100 ether);
        vm.prank(alice);
        vm.expectEmit(true, true, true, true);
        emit Approval(alice, bob, 40 ether);
        token.approve(bob, 40 ether);
        assertEq(token.allowance(alice, bob), 40 ether);

        vm.prank(bob);
        token.transferFrom(alice, carol, 25 ether);
        assertEq(token.allowance(alice, bob), 15 ether);
        assertEq(token.balanceOf(carol), 25 ether);
    }

    function test_TransferFrom_RevertsOnInsufficientAllowance() public {
        _mint(alice, 100 ether);
        vm.prank(alice);
        token.approve(bob, 10 ether);
        vm.prank(bob);
        vm.expectRevert(bytes("WTOKEN: insufficient allowance"));
        token.transferFrom(alice, carol, 11 ether);
    }

    function test_TransferFrom_InfiniteAllowanceNotDecremented() public {
        _mint(alice, 100 ether);
        vm.prank(alice);
        token.approve(bob, type(uint256).max);
        vm.prank(bob);
        token.transferFrom(alice, carol, 25 ether);
        assertEq(token.allowance(alice, bob), type(uint256).max);
    }

    // ------------------------------------------------------------ permit

    function _permitDigest(address o, address spender, uint256 value, uint256 nonce, uint256 deadline)
        internal
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encodePacked(
                "\x19\x01",
                token.DOMAIN_SEPARATOR(),
                keccak256(abi.encode(token.PERMIT_TYPEHASH(), o, spender, value, nonce, deadline))
            )
        );
    }

    function test_Permit_SetsAllowance() public {
        (address ownerAddr, uint256 key) = makeAddrAndKey("permitOwner");
        _mint(ownerAddr, 100 ether);
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, _permitDigest(ownerAddr, bob, 50 ether, 0, deadline));

        token.permit(ownerAddr, bob, 50 ether, deadline, v, r, s);

        assertEq(token.allowance(ownerAddr, bob), 50 ether);
        assertEq(token.nonces(ownerAddr), 1);

        vm.prank(bob);
        token.transferFrom(ownerAddr, carol, 50 ether);
        assertEq(token.balanceOf(carol), 50 ether);
    }

    function test_Permit_RevertsWhenExpired() public {
        (address ownerAddr, uint256 key) = makeAddrAndKey("permitOwner");
        uint256 deadline = block.timestamp - 1;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, _permitDigest(ownerAddr, bob, 50 ether, 0, deadline));
        vm.expectRevert(bytes("WTOKEN: permit expired"));
        token.permit(ownerAddr, bob, 50 ether, deadline, v, r, s);
    }

    function test_Permit_RevertsOnWrongSigner() public {
        (address ownerAddr,) = makeAddrAndKey("permitOwner");
        (, uint256 wrongKey) = makeAddrAndKey("someoneElse");
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(wrongKey, _permitDigest(ownerAddr, bob, 50 ether, 0, deadline));
        vm.expectRevert(bytes("WTOKEN: invalid signature"));
        token.permit(ownerAddr, bob, 50 ether, deadline, v, r, s);
    }

    function test_Permit_RevertsOnReplay() public {
        (address ownerAddr, uint256 key) = makeAddrAndKey("permitOwner");
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, _permitDigest(ownerAddr, bob, 50 ether, 0, deadline));
        token.permit(ownerAddr, bob, 50 ether, deadline, v, r, s);
        vm.expectRevert(bytes("WTOKEN: invalid signature"));
        token.permit(ownerAddr, bob, 50 ether, deadline, v, r, s);
    }

    function test_Permit_RevertsOnTamperedValue() public {
        (address ownerAddr, uint256 key) = makeAddrAndKey("permitOwner");
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, _permitDigest(ownerAddr, bob, 50 ether, 0, deadline));
        vm.expectRevert(bytes("WTOKEN: invalid signature"));
        token.permit(ownerAddr, bob, 51 ether, deadline, v, r, s);
    }

    function test_DomainSeparator_RebuildsOnChainIdFork() public {
        bytes32 before = token.DOMAIN_SEPARATOR();
        vm.chainId(999);
        assertTrue(token.DOMAIN_SEPARATOR() != before);
        vm.chainId(LOCAL_CHAIN);
        assertEq(token.DOMAIN_SEPARATOR(), before);
    }

    // ------------------------------------------------------------- fuzz

    function testFuzz_MintBurnConservesSupply(uint128 mintAmount, uint128 burnAmount) public {
        vm.assume(burnAmount <= mintAmount);
        _mint(alice, mintAmount);
        vm.prank(bridge);
        token.burn(alice, burnAmount);
        assertEq(token.totalSupply(), uint256(mintAmount) - burnAmount);
        assertEq(token.balanceOf(alice), uint256(mintAmount) - burnAmount);
    }

    function testFuzz_TransferConservesTotal(uint128 amount, uint128 part) public {
        vm.assume(part <= amount);
        _mint(alice, amount);
        vm.prank(alice);
        token.transfer(bob, part);
        assertEq(token.balanceOf(alice) + token.balanceOf(bob), amount);
        assertEq(token.totalSupply(), amount);
    }

    function testFuzz_OnlyBridgeCanMint(address caller, uint128 amount) public {
        vm.assume(caller != bridge);
        vm.prank(caller);
        vm.expectRevert(bytes("WTOKEN: not bridge"));
        token.mint(caller, amount);
    }
}
