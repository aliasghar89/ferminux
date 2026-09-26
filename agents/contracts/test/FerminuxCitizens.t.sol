// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {FerminuxCitizens} from "../src/FerminuxCitizens.sol";

/// Accepts tokens and, when armed, tries to mint again from inside onERC721Received.
contract ReenteringMinter {
    FerminuxCitizens public immutable n;
    uint256 public reenterId;
    bool public reentryBlocked;

    constructor(FerminuxCitizens n_) {
        n = n_;
    }

    function mintTwice(uint256 first, uint256 second) external payable {
        reenterId = second;
        n.mint{value: msg.value / 2}(first);
    }

    function onERC721Received(address, address, uint256, bytes calldata) external returns (bytes4) {
        if (reenterId != 0) {
            uint256 id = reenterId;
            reenterId = 0;
            try n.mint{value: address(this).balance}(id) {}
            catch (bytes memory err) {
                reentryBlocked = bytes4(err) == FerminuxCitizens.Reentrancy.selector;
            }
        }
        return this.onERC721Received.selector;
    }

    receive() external payable {}
}

/// Re-enters mint and lets the revert bubble, so the whole outer mint must revert.
contract StrictReenterer {
    FerminuxCitizens public immutable n;
    uint256 public second;

    constructor(FerminuxCitizens n_) {
        n = n_;
    }

    function go(uint256 first, uint256 second_) external payable {
        second = second_;
        n.mint{value: msg.value}(first);
    }

    function onERC721Received(address, address, uint256, bytes calldata) external returns (bytes4) {
        n.mint{value: 0}(second);
        return this.onERC721Received.selector;
    }
}

contract WrongReceiver {
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return 0xdeadbeef;
    }
}

contract NoHook {}

contract RejectsFmx {
    receive() external payable {
        revert("no");
    }
}

contract FerminuxCitizensTest is Test {
    FerminuxCitizens n;
    address gov = address(0xA11CE); // stands in for the governance multisig
    address curator = address(0xC0DE);
    address treasury = address(0x7EA5);
    address royalty = address(0x2981);
    address bob = address(0xB0B);
    address eve = address(0xE7E);
    uint256[4] prices = [uint256(50 ether), 100 ether, 250 ether, 500 ether];
    string constant BASE = "https://ferminux.net/nft/citizens/meta/";
    string constant CURI = "https://ferminux.net/nft/citizens/contract.json";

    event TokenMinted(uint256 indexed tokenId, address indexed to, uint8 tier, uint256 paid);
    event TokensAppended(uint256 fromId, uint256 toId);
    event TierChanged(uint256 indexed tokenId, uint8 tier);
    event TierPriceChanged(uint8 indexed tier, uint256 price);
    event PauseChanged(bool paused);
    event SupplyLocked(uint256 totalIds);
    event MetadataFrozen();
    event BaseURIChanged(string baseURI);
    event TreasuryChanged(address indexed treasury);
    event RoyaltyChanged(address indexed receiver, uint96 bps);
    event CuratorChanged(address indexed account, bool isCurator);
    event Withdrawn(address indexed to, uint256 amount);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ContractURIUpdated();
    event MetadataUpdate(uint256 tokenId);
    event BatchMetadataUpdate(uint256 fromTokenId, uint256 toTokenId);

    function setUp() public {
        n = new FerminuxCitizens("Ferminux Citizens", "FMXC", gov, prices, BASE, CURI, treasury, royalty, 500);
        vm.prank(gov);
        n.grantCurator(curator);
        // ids 1..8: two of each tier
        uint8[] memory t = new uint8[](8);
        (t[0], t[1], t[2], t[3], t[4], t[5], t[6], t[7]) = (0, 1, 2, 3, 0, 1, 2, 3);
        vm.prank(curator);
        n.appendTokens(t);
        vm.deal(bob, 10_000 ether);
        vm.deal(eve, 10_000 ether);
    }

    function _tiers(uint8 a, uint8 b) internal pure returns (uint8[] memory t) {
        t = new uint8[](2);
        (t[0], t[1]) = (a, b);
    }

    // ---------------- construction ----------------
    function testConstructorState() public view {
        assertEq(n.name(), "Ferminux Citizens");
        assertEq(n.symbol(), "FMXC");
        assertEq(n.owner(), gov);
        assertEq(n.pendingOwner(), address(0));
        assertEq(n.totalIds(), 8);
        assertEq(n.totalSupply(), 0);
        for (uint8 i = 0; i < 4; i++) assertEq(n.priceOfTier(i), prices[i]);
        assertEq(n.baseURI(), BASE);
        assertEq(n.contractURI(), CURI);
        assertEq(n.treasury(), treasury);
        assertEq(n.royaltyReceiver(), royalty);
        assertEq(n.royaltyBps(), 500);
        assertFalse(n.paused());
        assertFalse(n.supplyLocked());
        assertFalse(n.metadataFrozen());
    }

    function testConstructorRejects() public {
        vm.expectRevert(FerminuxCitizens.ZeroAddress.selector);
        new FerminuxCitizens("x", "X", address(0), prices, BASE, CURI, treasury, royalty, 500);
        vm.expectRevert(FerminuxCitizens.ZeroAddress.selector);
        new FerminuxCitizens("x", "X", gov, prices, BASE, CURI, address(0), royalty, 500);
        vm.expectRevert(FerminuxCitizens.ZeroAddress.selector);
        new FerminuxCitizens("x", "X", gov, prices, BASE, CURI, treasury, address(0), 500);
        vm.expectRevert(FerminuxCitizens.RoyaltyTooHigh.selector);
        new FerminuxCitizens("x", "X", gov, prices, BASE, CURI, treasury, royalty, 1001);
    }

    function testSupportsInterface() public view {
        assertTrue(n.supportsInterface(0x01ffc9a7));
        assertTrue(n.supportsInterface(0x80ac58cd));
        assertTrue(n.supportsInterface(0x5b5e139f));
        assertTrue(n.supportsInterface(0x2a55205a));
        assertTrue(n.supportsInterface(0x49064906));
        assertFalse(n.supportsInterface(0xffffffff));
    }

    // ---------------- mint + exact price ----------------
    function testMintEveryTierAtExactPrice() public {
        for (uint256 id = 1; id <= 4; id++) {
            uint8 tier = n.tierOf(id);
            assertEq(tier, uint8(id - 1));
            uint256 p = n.price(id);
            assertEq(p, prices[tier]);
            vm.expectEmit(true, true, true, true);
            emit TokenMinted(id, bob, tier, p);
            vm.prank(bob);
            n.mint{value: p}(id);
            assertEq(n.ownerOf(id), bob);
        }
        assertEq(n.totalSupply(), 4);
        assertEq(n.balanceOf(bob), 4);
        assertEq(address(n).balance, 900 ether);
        assertEq(n.tokenURI(3), string.concat(BASE, "3.json"));
    }

    function testMintRejects() public {
        vm.startPrank(bob);
        vm.expectRevert(FerminuxCitizens.WrongPrice.selector);
        n.mint{value: 49 ether}(1);
        vm.expectRevert(FerminuxCitizens.WrongPrice.selector);
        n.mint{value: 51 ether}(1);
        vm.expectRevert(FerminuxCitizens.WrongPrice.selector);
        n.mint{value: 50 ether}(4); // Legendary costs 500
        vm.expectRevert(FerminuxCitizens.BadId.selector);
        n.mint{value: 50 ether}(0);
        vm.expectRevert(FerminuxCitizens.BadId.selector);
        n.mint{value: 50 ether}(9);
        n.mint{value: 50 ether}(1);
        vm.expectRevert(FerminuxCitizens.Minted.selector);
        n.mint{value: 50 ether}(1);
        vm.stopPrank();
        vm.expectRevert(FerminuxCitizens.BadId.selector);
        n.price(9);
        vm.expectRevert(FerminuxCitizens.BadId.selector);
        n.tierOf(0);
        vm.expectRevert(FerminuxCitizens.BadId.selector);
        n.tokenURI(2); // exists but unminted
    }

    function testFuzzWrongValue(uint256 v) public {
        vm.assume(v != 100 ether && v <= 10_000 ether);
        vm.prank(bob);
        vm.expectRevert(FerminuxCitizens.WrongPrice.selector);
        n.mint{value: v}(2);
    }

    function testZeroPriceTierIsNotForSale() public {
        vm.prank(gov);
        n.setTierPrice(3, 0);
        vm.prank(bob);
        vm.expectRevert(FerminuxCitizens.NotForSale.selector);
        n.mint{value: 0}(4);
        uint256[] memory ids = new uint256[](1);
        ids[0] = 4;
        vm.prank(gov);
        n.reserve(ids, gov); // the owner can still place it
        assertEq(n.ownerOf(4), gov);
    }

    function testPause() public {
        vm.prank(bob);
        vm.expectRevert(FerminuxCitizens.NotOwner.selector);
        n.pause();
        vm.expectEmit(false, false, false, true);
        emit PauseChanged(true);
        vm.prank(gov);
        n.pause();
        vm.prank(bob);
        vm.expectRevert(FerminuxCitizens.Paused.selector);
        n.mint{value: 50 ether}(1);
        vm.prank(gov);
        n.unpause();
        vm.prank(bob);
        n.mint{value: 50 ether}(1);
    }

    // ---------------- reentrancy through the safe-mint receiver ----------------
    function testReentrantMintFromReceiverIsBlocked() public {
        ReenteringMinter r = new ReenteringMinter(n);
        vm.deal(address(r), 0);
        vm.prank(bob);
        r.mintTwice{value: 100 ether}(1, 5); // 50 for #1, the other 50 tries #5 from inside the hook
        assertEq(n.ownerOf(1), address(r));
        assertTrue(r.reentryBlocked());
        assertFalse(n.minted(5));
        assertEq(n.totalSupply(), 1);
        assertEq(address(n).balance, 50 ether);
    }

    function testReentrantMintRevertsWholeMint() public {
        StrictReenterer s = new StrictReenterer(n);
        vm.prank(bob);
        vm.expectRevert(FerminuxCitizens.Reentrancy.selector);
        s.go{value: 50 ether}(1, 5);
        assertFalse(n.minted(1));
        assertEq(n.totalSupply(), 0);
    }

    function testMintToContractNeedsReceiver() public {
        WrongReceiver w = new WrongReceiver();
        vm.deal(address(w), 100 ether);
        vm.prank(address(w));
        vm.expectRevert(FerminuxCitizens.UnsafeRecipient.selector);
        n.mint{value: 50 ether}(1);
        NoHook h = new NoHook();
        vm.deal(address(h), 100 ether);
        vm.prank(address(h));
        vm.expectRevert(); // no onERC721Received at all
        n.mint{value: 50 ether}(1);
    }

    // ---------------- curator + growth ----------------
    function testRoles() public {
        vm.prank(eve);
        vm.expectRevert(FerminuxCitizens.NotCurator.selector);
        n.appendTokens(_tiers(0, 0));
        vm.prank(eve);
        vm.expectRevert(FerminuxCitizens.NotCurator.selector);
        n.setTier(1, 2);
        vm.prank(eve);
        vm.expectRevert(FerminuxCitizens.NotOwner.selector);
        n.grantCurator(eve);
        vm.prank(curator);
        vm.expectRevert(FerminuxCitizens.NotOwner.selector);
        n.grantCurator(eve); // curators cannot make curators
        vm.prank(curator);
        vm.expectRevert(FerminuxCitizens.NotOwner.selector);
        n.setTierPrice(0, 1);

        vm.expectEmit(true, false, false, true);
        emit CuratorChanged(eve, true);
        vm.prank(gov);
        n.grantCurator(eve);
        assertTrue(n.isCurator(eve));
        vm.prank(eve);
        n.appendTokens(_tiers(1, 1));
        assertEq(n.totalIds(), 10);

        vm.prank(gov);
        n.revokeCurator(eve);
        assertFalse(n.isCurator(eve));
        vm.prank(eve);
        vm.expectRevert(FerminuxCitizens.NotCurator.selector);
        n.appendTokens(_tiers(1, 1));

        vm.prank(gov); // the owner is always a curator
        n.appendTokens(_tiers(2, 3));
        assertEq(n.totalIds(), 12);
        vm.prank(gov);
        vm.expectRevert(FerminuxCitizens.ZeroAddress.selector);
        n.grantCurator(address(0));
    }

    function testAppendAfterMints() public {
        vm.prank(bob);
        n.mint{value: 250 ether}(3);
        vm.expectEmit(false, false, false, true);
        emit TokensAppended(9, 11);
        uint8[] memory t = new uint8[](3);
        (t[0], t[1], t[2]) = (3, 0, 2);
        vm.prank(curator);
        n.appendTokens(t);
        assertEq(n.totalIds(), 11);
        assertEq(n.ownerOf(3), bob); // earlier mint untouched
        assertEq(n.tierOf(3), 2);
        assertEq(n.tierOf(9), 3);
        assertEq(n.tierOf(10), 0);
        assertEq(n.tierOf(11), 2);
        assertEq(n.price(9), 500 ether);
        vm.prank(eve);
        n.mint{value: 500 ether}(9);
        assertEq(n.ownerOf(9), eve);
        assertEq(n.totalSupply(), 2);
    }

    function testAppendRejects() public {
        vm.startPrank(curator);
        vm.expectRevert(FerminuxCitizens.EmptyBatch.selector);
        n.appendTokens(new uint8[](0));
        vm.expectRevert(FerminuxCitizens.BadTier.selector);
        n.appendTokens(_tiers(0, 4));
        vm.stopPrank();
        assertEq(n.totalIds(), 8); // a bad batch appends nothing
    }

    function testLockSupply() public {
        vm.prank(curator);
        vm.expectRevert(FerminuxCitizens.NotOwner.selector);
        n.lockSupply();
        vm.expectEmit(false, false, false, true);
        emit SupplyLocked(8);
        vm.prank(gov);
        n.lockSupply();
        assertTrue(n.supplyLocked());
        vm.prank(curator);
        vm.expectRevert(FerminuxCitizens.SupplyIsLocked.selector);
        n.appendTokens(_tiers(0, 0));
        vm.prank(gov);
        vm.expectRevert(FerminuxCitizens.SupplyIsLocked.selector);
        n.appendTokens(_tiers(0, 0));
        // existing ids still sell, and unminted ones can still be re-tiered
        vm.prank(curator);
        n.setTier(8, 0);
        vm.prank(bob);
        n.mint{value: 50 ether}(8);
    }

    function testSetTierOnlyWhileUnminted() public {
        vm.expectEmit(true, false, false, true);
        emit TierChanged(5, 3);
        vm.expectEmit(false, false, false, true);
        emit MetadataUpdate(5);
        vm.prank(curator);
        n.setTier(5, 3);
        assertEq(n.tierOf(5), 3);
        assertEq(n.price(5), 500 ether);
        vm.prank(bob);
        vm.expectRevert(FerminuxCitizens.WrongPrice.selector);
        n.mint{value: 50 ether}(5);
        vm.prank(bob);
        n.mint{value: 500 ether}(5);
        vm.prank(curator);
        vm.expectRevert(FerminuxCitizens.Minted.selector);
        n.setTier(5, 0);
        vm.prank(gov);
        vm.expectRevert(FerminuxCitizens.Minted.selector);
        n.setTier(5, 0);
        vm.startPrank(curator);
        vm.expectRevert(FerminuxCitizens.BadTier.selector);
        n.setTier(6, 4);
        vm.expectRevert(FerminuxCitizens.BadId.selector);
        n.setTier(9, 0);
        vm.expectRevert(FerminuxCitizens.BadId.selector);
        n.setTier(0, 0);
        vm.stopPrank();
    }

    function testTierPrices() public {
        vm.expectEmit(true, false, false, true);
        emit TierPriceChanged(1, 120 ether);
        vm.prank(gov);
        n.setTierPrice(1, 120 ether);
        assertEq(n.price(2), 120 ether);
        assertEq(n.price(6), 120 ether);
        vm.prank(gov);
        vm.expectRevert(FerminuxCitizens.BadTier.selector);
        n.setTierPrice(4, 1);
        vm.prank(bob);
        n.mint{value: 120 ether}(2);
    }

    function testTokensInfo() public {
        vm.prank(bob);
        n.mint{value: 100 ether}(2);
        (uint8[] memory t, address[] memory o) = n.tokensInfo(0, 100);
        assertEq(t.length, 8);
        assertEq(o.length, 8);
        assertEq(t[3], 3);
        assertEq(o[1], bob);
        assertEq(o[0], address(0));
        (t, o) = n.tokensInfo(7, 3);
        assertEq(t.length, 0);
        (t, o) = n.tokensInfo(8, 8);
        assertEq(t.length, 1);
        assertEq(t[0], 3);
    }

    // ---------------- money ----------------
    function testWithdrawToTreasury() public {
        vm.prank(bob);
        n.mint{value: 500 ether}(4);
        vm.prank(eve);
        n.mint{value: 50 ether}(1);
        vm.prank(eve);
        vm.expectRevert(FerminuxCitizens.NotCurator.selector);
        n.withdraw();
        vm.expectEmit(true, false, false, true);
        emit Withdrawn(treasury, 550 ether);
        vm.prank(curator);
        n.withdraw();
        assertEq(treasury.balance, 550 ether);
        assertEq(address(n).balance, 0);

        address t2 = address(0x7EA6);
        vm.prank(eve);
        vm.expectRevert(FerminuxCitizens.NotOwner.selector);
        n.setTreasury(t2);
        vm.prank(gov);
        vm.expectRevert(FerminuxCitizens.ZeroAddress.selector);
        n.setTreasury(address(0));
        vm.expectEmit(true, false, false, false);
        emit TreasuryChanged(t2);
        vm.prank(gov);
        n.setTreasury(t2);
        vm.prank(bob);
        n.mint{value: 100 ether}(2);
        vm.prank(gov);
        n.withdraw();
        assertEq(t2.balance, 100 ether);
    }

    function testWithdrawFailsLoudly() public {
        RejectsFmx r = new RejectsFmx();
        vm.prank(gov);
        n.setTreasury(address(r));
        vm.prank(bob);
        n.mint{value: 50 ether}(1);
        vm.prank(gov);
        vm.expectRevert(FerminuxCitizens.TransferFailed.selector);
        n.withdraw();
        assertEq(address(n).balance, 50 ether);
    }

    function testRoyaltyMath() public {
        (address rcv, uint256 amt) = n.royaltyInfo(1, 1000 ether);
        assertEq(rcv, royalty);
        assertEq(amt, 50 ether);
        (, amt) = n.royaltyInfo(1, 999);
        assertEq(amt, 49); // rounds down
        vm.expectEmit(true, false, false, true);
        emit RoyaltyChanged(bob, 1000);
        vm.prank(gov);
        n.setRoyalty(bob, 1000);
        (rcv, amt) = n.royaltyInfo(77, 250 ether);
        assertEq(rcv, bob);
        assertEq(amt, 25 ether);
        vm.startPrank(gov);
        vm.expectRevert(FerminuxCitizens.RoyaltyTooHigh.selector);
        n.setRoyalty(bob, 1001);
        vm.expectRevert(FerminuxCitizens.ZeroAddress.selector);
        n.setRoyalty(address(0), 100);
        n.setRoyalty(bob, 0);
        vm.stopPrank();
        (, amt) = n.royaltyInfo(1, 1000 ether);
        assertEq(amt, 0);
        vm.prank(eve);
        vm.expectRevert(FerminuxCitizens.NotOwner.selector);
        n.setRoyalty(eve, 100);
    }

    function testFuzzRoyalty(uint96 bps, uint128 sale) public {
        bps = uint96(bound(bps, 0, 1000));
        vm.prank(gov);
        n.setRoyalty(royalty, bps);
        (, uint256 amt) = n.royaltyInfo(1, sale);
        assertEq(amt, (uint256(sale) * bps) / 10000);
        assertLe(amt, uint256(sale) / 10);
    }

    // ---------------- metadata ----------------
    function testMetadataSettersAndFreeze() public {
        vm.prank(bob);
        n.mint{value: 50 ether}(1);
        vm.prank(eve);
        vm.expectRevert(FerminuxCitizens.NotOwner.selector);
        n.setBaseURI("ipfs://x/");
        vm.expectEmit(false, false, false, true);
        emit BaseURIChanged("ipfs://x/");
        vm.expectEmit(false, false, false, true);
        emit BatchMetadataUpdate(1, type(uint256).max);
        vm.prank(gov);
        n.setBaseURI("ipfs://x/");
        assertEq(n.tokenURI(1), "ipfs://x/1.json");
        vm.expectEmit(false, false, false, true);
        emit ContractURIUpdated();
        vm.prank(gov);
        n.setContractURI("ipfs://c.json");
        assertEq(n.contractURI(), "ipfs://c.json");

        vm.prank(curator);
        vm.expectRevert(FerminuxCitizens.NotOwner.selector);
        n.freezeMetadata();
        vm.expectEmit(false, false, false, true);
        emit MetadataFrozen();
        vm.prank(gov);
        n.freezeMetadata();
        assertTrue(n.metadataFrozen());
        vm.startPrank(gov);
        vm.expectRevert(FerminuxCitizens.MetadataIsFrozen.selector);
        n.setBaseURI("https://evil/");
        vm.expectRevert(FerminuxCitizens.MetadataIsFrozen.selector);
        n.setContractURI("https://evil/c.json");
        vm.stopPrank();
        assertEq(n.tokenURI(1), "ipfs://x/1.json");
        // growth continues under the frozen base
        vm.prank(curator);
        n.appendTokens(_tiers(0, 0));
        vm.prank(bob);
        n.mint{value: 50 ether}(9);
        assertEq(n.tokenURI(9), "ipfs://x/9.json");
    }

    // ---------------- ownership (two-step) ----------------
    function testOwnershipTwoStep() public {
        address msig = address(0x910B);
        vm.prank(eve);
        vm.expectRevert(FerminuxCitizens.NotOwner.selector);
        n.transferOwnership(eve);
        vm.expectEmit(true, true, false, false);
        emit OwnershipTransferStarted(gov, msig);
        vm.prank(gov);
        n.transferOwnership(msig);
        assertEq(n.owner(), gov); // nothing moves until accepted
        assertEq(n.pendingOwner(), msig);
        vm.prank(eve);
        vm.expectRevert(FerminuxCitizens.NotPendingOwner.selector);
        n.acceptOwnership();
        vm.expectEmit(true, true, false, false);
        emit OwnershipTransferred(gov, msig);
        vm.prank(msig);
        n.acceptOwnership();
        assertEq(n.owner(), msig);
        assertEq(n.pendingOwner(), address(0));
        vm.prank(gov);
        vm.expectRevert(FerminuxCitizens.NotOwner.selector);
        n.pause();
        vm.prank(msig);
        n.pause();
        // cancel a pending transfer
        vm.prank(msig);
        n.transferOwnership(eve);
        vm.prank(msig);
        n.transferOwnership(address(0));
        vm.prank(eve);
        vm.expectRevert(FerminuxCitizens.NotPendingOwner.selector);
        n.acceptOwnership();
    }

    // ---------------- reserve + transfers ----------------
    function testReserveToPlainContract() public {
        NoHook vault = new NoHook(); // like MinimalMultisig: no receiver hook
        uint256[] memory ids = new uint256[](2);
        (ids[0], ids[1]) = (4, 8);
        vm.prank(bob);
        vm.expectRevert(FerminuxCitizens.NotOwner.selector);
        n.reserve(ids, bob);
        vm.prank(gov);
        n.reserve(ids, address(vault));
        assertEq(n.ownerOf(4), address(vault));
        assertEq(n.ownerOf(8), address(vault));
        assertEq(n.totalSupply(), 2);
        vm.prank(gov);
        vm.expectRevert(FerminuxCitizens.Minted.selector);
        n.reserve(ids, gov);
        ids[0] = 9;
        vm.prank(gov);
        vm.expectRevert(FerminuxCitizens.BadId.selector);
        n.reserve(ids, gov);
    }

    function testTransferAndApprove() public {
        vm.prank(bob);
        n.mint{value: 50 ether}(1);
        vm.prank(eve);
        vm.expectRevert(FerminuxCitizens.NotAuthorized.selector);
        n.transferFrom(bob, eve, 1);
        vm.prank(bob);
        n.approve(eve, 1);
        vm.prank(eve);
        n.transferFrom(bob, eve, 1);
        assertEq(n.ownerOf(1), eve);
        assertEq(n.balanceOf(bob), 0);
        assertEq(n.getApproved(1), address(0));
        vm.prank(eve);
        n.setApprovalForAll(bob, true);
        vm.prank(bob);
        n.safeTransferFrom(eve, bob, 1);
        assertEq(n.ownerOf(1), bob);
        WrongReceiver w = new WrongReceiver();
        vm.prank(bob);
        vm.expectRevert(FerminuxCitizens.UnsafeRecipient.selector);
        n.safeTransferFrom(bob, address(w), 1);
        vm.prank(bob);
        vm.expectRevert(FerminuxCitizens.ZeroAddress.selector);
        n.transferFrom(bob, address(0), 1);
    }
}
