// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, stdError} from "forge-std/Test.sol";
import {TokenFactory, FerminuxToken} from "../src/TokenFactory.sol";

/// @dev Fee collector that rejects native transfers — exercises "FACTORY: fee transfer".
contract RejectingCollector {
    // no receive / no fallback
}

contract TokenFactoryTest is Test {
    TokenFactory internal factory;

    address internal collector = makeAddr("collector");
    address internal creator = makeAddr("creator");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    uint256 internal constant FEE = 10 ether;

    event TokenLaunched(
        address indexed token,
        address indexed creator,
        string name,
        string symbol,
        uint256 initialSupply,
        bool mintable
    );
    event FeeChanged(uint256 newFee);
    event FeeCollectorChanged(address newCollector);
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event OwnershipTransferred(address indexed from, address indexed to);
    event OwnershipRenounced(address indexed lastOwner);

    function setUp() public {
        factory = new TokenFactory(collector);
        vm.deal(creator, 1000 ether);
        vm.deal(alice, 1000 ether);
    }

    function _launch() internal returns (FerminuxToken) {
        vm.prank(creator);
        return FerminuxToken(factory.launch{value: FEE}("Demo Coin", "DEMO", 18, 1_000_000 ether, 0, false));
    }

    function _launchMintable(uint256 initialSupply, uint256 maxSupply) internal returns (FerminuxToken) {
        vm.prank(creator);
        return FerminuxToken(factory.launch{value: FEE}("Mint Coin", "MINT", 18, initialSupply, maxSupply, true));
    }

    // =====================================================================
    //                              TokenFactory
    // =====================================================================

    function test_Constructor_SetsCollectorAndDefaults() public view {
        assertEq(factory.feeCollector(), collector);
        assertEq(factory.launchFee(), 10 ether);
        assertEq(factory.totalLaunched(), 0);
        assertEq(factory.tokenCount(), 0);
    }

    function test_Constructor_RevertsOnZeroCollector() public {
        vm.expectRevert(bytes("FACTORY: zero collector"));
        new TokenFactory(address(0));
    }

    // ------------------------------------------------------------ launch fee

    function test_Launch_RevertsBelowFee() public {
        vm.prank(creator);
        vm.expectRevert(bytes("FACTORY: fee"));
        factory.launch{value: FEE - 1}("Demo", "DEMO", 18, 1e18, 0, false);
    }

    function test_Launch_ExactFee_ForwardedToCollector() public {
        _launch();
        assertEq(collector.balance, FEE);
        assertEq(address(factory).balance, 0, "factory must hold no fees");
    }

    function test_Launch_Overpayment_ForwardedInFull() public {
        vm.prank(creator);
        factory.launch{value: FEE + 3 ether}("Demo", "DEMO", 18, 1e18, 0, false);
        assertEq(collector.balance, FEE + 3 ether);
        assertEq(address(factory).balance, 0);
    }

    function test_Launch_RevertsWhenCollectorRejectsFee() public {
        TokenFactory f = new TokenFactory(address(new RejectingCollector()));
        vm.prank(creator);
        vm.expectRevert(bytes("FACTORY: fee transfer"));
        f.launch{value: FEE}("Demo", "DEMO", 18, 1e18, 0, false);
    }

    function test_SetFee_Zero_MakesLaunchFree() public {
        vm.prank(collector);
        factory.setFee(0);
        vm.prank(creator);
        factory.launch("Free", "FREE", 18, 1e18, 0, false); // no value at all
        assertEq(factory.totalLaunched(), 1);
    }

    // ------------------------------------------------------- input validation

    function test_Launch_NameLengthBounds() public {
        vm.startPrank(creator);
        vm.expectRevert(bytes("FACTORY: name len"));
        factory.launch{value: FEE}("", "SYM", 18, 1e18, 0, false);

        string memory name65 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"; // 65
        vm.expectRevert(bytes("FACTORY: name len"));
        factory.launch{value: FEE}(name65, "SYM", 18, 1e18, 0, false);

        // 1 and 64 chars are accepted
        factory.launch{value: FEE}("A", "SYM", 18, 1e18, 0, false);
        string memory name64 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"; // 64
        factory.launch{value: FEE}(name64, "SYM", 18, 1e18, 0, false);
        vm.stopPrank();
        assertEq(factory.totalLaunched(), 2);
    }

    function test_Launch_SymbolLengthBounds() public {
        vm.startPrank(creator);
        vm.expectRevert(bytes("FACTORY: symbol len"));
        factory.launch{value: FEE}("Name", "", 18, 1e18, 0, false);

        vm.expectRevert(bytes("FACTORY: symbol len"));
        factory.launch{value: FEE}("Name", "ABCDEFGHIJKLM", 18, 1e18, 0, false); // 13

        factory.launch{value: FEE}("Name", "S", 18, 1e18, 0, false); // 1
        factory.launch{value: FEE}("Name", "ABCDEFGHIJKL", 18, 1e18, 0, false); // 12
        vm.stopPrank();
        assertEq(factory.totalLaunched(), 2);
    }

    function test_Launch_DecimalsBound() public {
        vm.startPrank(creator);
        vm.expectRevert(bytes("FACTORY: decimals"));
        factory.launch{value: FEE}("Name", "SYM", 19, 1e18, 0, false);

        factory.launch{value: FEE}("Name", "SYM", 0, 1e18, 0, false); // 0 ok
        factory.launch{value: FEE}("Name", "SYM", 18, 1e18, 0, false); // 18 ok
        vm.stopPrank();
    }

    function test_Launch_ZeroSupplyRequiresMintable() public {
        vm.startPrank(creator);
        vm.expectRevert(bytes("FACTORY: zero supply, not mintable"));
        factory.launch{value: FEE}("Name", "SYM", 18, 0, 0, false);

        // zero supply + mintable is fine
        address token = factory.launch{value: FEE}("Name", "SYM", 18, 0, 0, true);
        vm.stopPrank();
        assertEq(FerminuxToken(token).totalSupply(), 0);
    }

    // --------------------------------------------------------------- registry

    function test_Launch_RecordsRegistryAndEmits() public {
        vm.prank(creator);
        vm.expectEmit(false, true, false, true); // token address unknown pre-call
        emit TokenLaunched(address(0), creator, "Demo Coin", "DEMO", 1_000_000 ether, false);
        address token = factory.launch{value: FEE}("Demo Coin", "DEMO", 18, 1_000_000 ether, 0, false);

        assertEq(factory.totalLaunched(), 1);
        assertEq(factory.tokenCount(), 1);
        assertTrue(factory.isFactoryToken(token));
        assertFalse(factory.isFactoryToken(address(0xdead)));

        (address t, address c, string memory n, string memory s, uint256 created, bool mintable) = factory.tokens(0);
        assertEq(t, token);
        assertEq(c, creator);
        assertEq(n, "Demo Coin");
        assertEq(s, "DEMO");
        assertEq(created, block.timestamp);
        assertFalse(mintable);
    }

    function test_TokensOf_TracksPerCreator() public {
        vm.prank(creator);
        address t1 = factory.launch{value: FEE}("One", "ONE", 18, 1e18, 0, false);
        vm.prank(alice);
        address t2 = factory.launch{value: FEE}("Two", "TWO", 18, 1e18, 0, false);
        vm.prank(creator);
        address t3 = factory.launch{value: FEE}("Three", "THREE", 18, 1e18, 0, false);

        address[] memory ofCreator = factory.tokensOf(creator);
        assertEq(ofCreator.length, 2);
        assertEq(ofCreator[0], t1);
        assertEq(ofCreator[1], t3);

        address[] memory ofAlice = factory.tokensOf(alice);
        assertEq(ofAlice.length, 1);
        assertEq(ofAlice[0], t2);

        assertEq(factory.tokensOf(bob).length, 0);
    }

    function test_TokensPage_PaginationEdges() public {
        // launch 5 tokens
        address[5] memory launched;
        for (uint256 i = 0; i < 5; i++) {
            vm.prank(creator);
            launched[i] = factory.launch{value: FEE}("Coin", "COIN", 18, 1e18, 0, false);
        }

        // full first page
        TokenFactory.TokenInfo[] memory page = factory.tokensPage(0, 2);
        assertEq(page.length, 2);
        assertEq(page[0].token, launched[0]);
        assertEq(page[1].token, launched[1]);

        // middle page
        page = factory.tokensPage(2, 2);
        assertEq(page.length, 2);
        assertEq(page[0].token, launched[2]);

        // clamped last page
        page = factory.tokensPage(4, 2);
        assertEq(page.length, 1);
        assertEq(page[0].token, launched[4]);

        // offset == length -> empty
        assertEq(factory.tokensPage(5, 1).length, 0);
        // offset beyond length -> empty
        assertEq(factory.tokensPage(100, 10).length, 0);
        // zero limit -> empty
        assertEq(factory.tokensPage(0, 0).length, 0);
        // limit beyond length -> whole registry
        assertEq(factory.tokensPage(0, 1000).length, 5);
    }

    function test_TokensPage_EmptyRegistry() public view {
        assertEq(factory.tokensPage(0, 10).length, 0);
    }

    function testFuzz_TokensPage_NeverReverts(uint256 offset, uint256 limit) public {
        limit = bound(limit, 0, 1000); // keep allocation sane
        for (uint256 i = 0; i < 3; i++) {
            vm.prank(creator);
            factory.launch{value: FEE}("Coin", "COIN", 18, 1e18, 0, false);
        }
        TokenFactory.TokenInfo[] memory page = factory.tokensPage(offset, limit);
        assertLe(page.length, 3);
    }

    // ------------------------------------------------------------------ admin

    function test_SetFee_OnlyCollector() public {
        vm.prank(creator);
        vm.expectRevert(bytes("FACTORY: not admin"));
        factory.setFee(1 ether);
    }

    function test_SetFee_UpdatesAndEmits() public {
        vm.expectEmit(false, false, false, true);
        emit FeeChanged(25 ether);
        vm.prank(collector);
        factory.setFee(25 ether);
        assertEq(factory.launchFee(), 25 ether);

        // old fee no longer enough
        vm.prank(creator);
        vm.expectRevert(bytes("FACTORY: fee"));
        factory.launch{value: 10 ether}("Demo", "DEMO", 18, 1e18, 0, false);
    }

    function test_SetFeeCollector_OnlyCollector() public {
        vm.prank(creator);
        vm.expectRevert(bytes("FACTORY: not admin"));
        factory.setFeeCollector(creator);
    }

    function test_SetFeeCollector_RevertsOnZero() public {
        vm.prank(collector);
        vm.expectRevert(bytes("FACTORY: zero collector"));
        factory.setFeeCollector(address(0));
    }

    function test_SetFeeCollector_UpdatesAndEmits_NewCollectorReceivesFees() public {
        vm.expectEmit(false, false, false, true);
        emit FeeCollectorChanged(bob);
        vm.prank(collector);
        factory.setFeeCollector(bob);
        assertEq(factory.feeCollector(), bob);

        // old collector locked out of admin
        vm.prank(collector);
        vm.expectRevert(bytes("FACTORY: not admin"));
        factory.setFee(1 ether);

        // fees now flow to the new collector
        _launch();
        assertEq(bob.balance, FEE);
        assertEq(collector.balance, 0);
    }

    function testFuzz_Launch_FeePaths(uint96 payment) public {
        vm.deal(creator, uint256(payment));
        vm.prank(creator);
        if (payment < FEE) {
            vm.expectRevert(bytes("FACTORY: fee"));
            factory.launch{value: payment}("Demo", "DEMO", 18, 1e18, 0, false);
        } else {
            factory.launch{value: payment}("Demo", "DEMO", 18, 1e18, 0, false);
            assertEq(collector.balance, payment);
        }
    }

    // =====================================================================
    //                             FerminuxToken
    // =====================================================================

    function test_Token_ConstructorState() public {
        FerminuxToken token = _launch();
        assertEq(token.name(), "Demo Coin");
        assertEq(token.symbol(), "DEMO");
        assertEq(token.decimals(), 18);
        assertEq(token.totalSupply(), 1_000_000 ether);
        assertEq(token.maxSupply(), 0);
        assertEq(token.owner(), creator);
        assertFalse(token.mintable());
        assertEq(token.factory(), address(factory));
        assertEq(token.balanceOf(creator), 1_000_000 ether);
    }

    function test_Token_Constructor_RevertsWhenSupplyExceedsMax() public {
        vm.expectRevert(bytes("TOKEN: supply > max"));
        new FerminuxToken("Bad", "BAD", 18, 101, 100, true, creator);
    }

    function test_Token_Transfer() public {
        FerminuxToken token = _launch();
        vm.expectEmit(true, true, false, true);
        emit Transfer(creator, alice, 100 ether);
        vm.prank(creator);
        assertTrue(token.transfer(alice, 100 ether));
        assertEq(token.balanceOf(alice), 100 ether);
    }

    function test_Token_Transfer_RevertsToZero() public {
        FerminuxToken token = _launch();
        vm.prank(creator);
        vm.expectRevert(bytes("TOKEN: zero to"));
        token.transfer(address(0), 1);
    }

    function test_Token_Transfer_RevertsOnInsufficientBalance() public {
        FerminuxToken token = _launch();
        vm.prank(alice);
        vm.expectRevert(stdError.arithmeticError);
        token.transfer(bob, 1);
    }

    function test_Token_ApproveAndTransferFrom() public {
        FerminuxToken token = _launch();
        vm.prank(creator);
        vm.expectEmit(true, true, false, true);
        emit Approval(creator, alice, 500 ether);
        token.approve(alice, 500 ether);

        vm.prank(alice);
        assertTrue(token.transferFrom(creator, bob, 200 ether));
        assertEq(token.allowance(creator, alice), 300 ether);
        assertEq(token.balanceOf(bob), 200 ether);
    }

    function test_Token_TransferFrom_RevertsOnInsufficientAllowance() public {
        FerminuxToken token = _launch();
        vm.prank(creator);
        token.approve(alice, 10);
        vm.prank(alice);
        vm.expectRevert(bytes("TOKEN: allowance"));
        token.transferFrom(creator, bob, 11);
    }

    function test_Token_TransferFrom_MaxAllowanceNotDecremented() public {
        FerminuxToken token = _launch();
        vm.prank(creator);
        token.approve(alice, type(uint256).max);
        vm.prank(alice);
        token.transferFrom(creator, bob, 1 ether);
        assertEq(token.allowance(creator, alice), type(uint256).max);
    }

    // ------------------------------------------------------------------ mint

    function test_Token_Mint_OnlyOwner() public {
        FerminuxToken token = _launchMintable(0, 0);
        vm.prank(alice);
        vm.expectRevert(bytes("TOKEN: not owner"));
        token.mint(alice, 1);
    }

    function test_Token_Mint_RevertsWhenNotMintable() public {
        FerminuxToken token = _launch(); // mintable = false
        vm.prank(creator);
        vm.expectRevert(bytes("TOKEN: not mintable"));
        token.mint(creator, 1);
    }

    function test_Token_Mint_UncappedWhenMaxZero() public {
        FerminuxToken token = _launchMintable(0, 0);
        vm.prank(creator);
        token.mint(alice, 1e30);
        assertEq(token.totalSupply(), 1e30);
        assertEq(token.balanceOf(alice), 1e30);
    }

    function test_Token_Mint_CapEdge() public {
        FerminuxToken token = _launchMintable(400, 1000);
        vm.startPrank(creator);
        token.mint(creator, 600); // exactly reaches the cap
        assertEq(token.totalSupply(), 1000);
        vm.expectRevert(bytes("TOKEN: exceeds max"));
        token.mint(creator, 1);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ burn

    function test_Token_Burn_AnyHolder() public {
        FerminuxToken token = _launch();
        vm.prank(creator);
        token.transfer(alice, 100);
        vm.expectEmit(true, true, false, true);
        emit Transfer(alice, address(0), 40);
        vm.prank(alice);
        token.burn(40);
        assertEq(token.balanceOf(alice), 60);
        assertEq(token.totalSupply(), 1_000_000 ether - 40);
    }

    function test_Token_Burn_RevertsAboveBalance() public {
        FerminuxToken token = _launch();
        vm.prank(alice);
        vm.expectRevert(stdError.arithmeticError);
        token.burn(1);
    }

    function test_Token_BurnThenMintUnderCap() public {
        FerminuxToken token = _launchMintable(1000, 1000);
        vm.startPrank(creator);
        token.burn(500);
        token.mint(creator, 500); // burn frees cap room (cap checks totalSupply)
        assertEq(token.totalSupply(), 1000);
        vm.stopPrank();
    }

    // ------------------------------------------------------------- ownership

    function test_Token_RenounceOwnership() public {
        FerminuxToken token = _launchMintable(0, 0);
        vm.expectEmit(true, false, false, false);
        emit OwnershipRenounced(creator);
        vm.prank(creator);
        token.renounceOwnership();
        assertEq(token.owner(), address(0));
        // minting is dead forever
        vm.prank(creator);
        vm.expectRevert(bytes("TOKEN: not owner"));
        token.mint(creator, 1);
    }

    function test_Token_RenounceOwnership_OnlyOwner() public {
        FerminuxToken token = _launch();
        vm.prank(alice);
        vm.expectRevert(bytes("TOKEN: not owner"));
        token.renounceOwnership();
    }

    function test_Token_TransferOwnership() public {
        FerminuxToken token = _launchMintable(0, 0);
        vm.expectEmit(true, true, false, false);
        emit OwnershipTransferred(creator, alice);
        vm.prank(creator);
        token.transferOwnership(alice);
        assertEq(token.owner(), alice);

        // old owner can no longer mint, new owner can
        vm.prank(creator);
        vm.expectRevert(bytes("TOKEN: not owner"));
        token.mint(creator, 1);
        vm.prank(alice);
        token.mint(alice, 5);
        assertEq(token.balanceOf(alice), 5);
    }

    function test_Token_TransferOwnership_RevertsOnZero() public {
        FerminuxToken token = _launch();
        vm.prank(creator);
        vm.expectRevert(bytes("TOKEN: zero owner"));
        token.transferOwnership(address(0));
    }

    function testFuzz_Token_MintWithinCap(uint128 initial, uint128 extra) public {
        uint256 cap = uint256(initial) + uint256(extra);
        vm.assume(cap > 0);
        FerminuxToken token = _launchMintable(initial, cap);
        vm.prank(creator);
        token.mint(creator, extra);
        assertEq(token.totalSupply(), cap);
    }
}
