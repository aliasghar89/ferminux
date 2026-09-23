// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";
import {AgentAccount} from "../src/AgentAccount.sol";
import {AgentAccountFactory} from "../src/AgentAccountFactory.sol";
import {MemoryAnchor} from "../src/MemoryAnchor.sol";
import {IAccountFactoryLike} from "../src/lib/IAccount.sol";

contract MemoryAnchorTest is Test {
    AgentRegistry internal registry;
    AgentAccountFactory internal factory;
    MemoryAnchor internal anchors;

    address internal gov = makeAddr("governance");
    address internal relayer = makeAddr("relayer");
    address internal stranger = makeAddr("stranger");
    address internal alice;
    uint256 internal alicePk;
    address internal mallory;
    uint256 internal malloryPk;

    uint256 internal agentId;
    uint256 internal constant MIN_BOND = 100 ether;

    function setUp() public {
        (alice, alicePk) = makeAddrAndKey("alice");
        (mallory, malloryPk) = makeAddrAndKey("mallory");
        registry = new AgentRegistry(address(this), MIN_BOND);
        factory = new AgentAccountFactory();
        anchors = new MemoryAnchor(registry, IAccountFactoryLike(address(factory)), gov);
        vm.deal(alice, 1_000 ether);
        vm.deal(mallory, 1_000 ether);
        vm.warp(1_700_000_000);
        vm.prank(alice);
        agentId = registry.register{value: MIN_BOND}("Toolbox", "https://toolbox.example", "", 0.1 ether);
    }

    // ───────────────────────────── merkle reference (mirrors the contract rule) ─────────────────────────────

    function _leafOf(bytes32 h) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(bytes1(0x00), h));
    }

    function _leafFor(bytes memory record) internal pure returns (bytes32) {
        return _leafOf(keccak256(record));
    }

    function _node(bytes32 l, bytes32 r) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(bytes1(0x01), l, r));
    }

    function _records(uint256 n) internal pure returns (bytes[] memory recs) {
        recs = new bytes[](n);
        for (uint256 i; i < n; i++) {
            recs[i] = abi.encodePacked('{"seq":', vm.toString(i + 1), ',"op":"put"}');
        }
    }

    function _leaves(bytes[] memory recs) internal pure returns (bytes32[] memory out) {
        out = new bytes32[](recs.length);
        for (uint256 i; i < recs.length; i++) {
            out[i] = _leafFor(recs[i]);
        }
    }

    function _root(bytes32[] memory leaves) internal pure returns (bytes32) {
        uint256 n = leaves.length;
        require(n != 0, "empty");
        bytes32[] memory level = new bytes32[](n);
        for (uint256 i; i < n; i++) {
            level[i] = leaves[i];
        }
        while (n > 1) {
            uint256 w;
            for (uint256 i; i < n; i += 2) {
                bytes32 l = level[i];
                bytes32 r = i + 1 < n ? level[i + 1] : l;
                level[w++] = _node(l, r);
            }
            n = w;
        }
        return level[0];
    }

    function _proof(bytes32[] memory leaves, uint256 index) internal pure returns (bytes32[] memory out) {
        uint256 n = leaves.length;
        bytes32[] memory level = new bytes32[](n);
        for (uint256 i; i < n; i++) {
            level[i] = leaves[i];
        }
        bytes32[] memory buf = new bytes32[](64);
        uint256 k;
        uint256 idx = index;
        while (n > 1) {
            if (!(idx == n - 1 && n % 2 == 1)) {
                uint256 sib = idx % 2 == 0 ? idx + 1 : idx - 1;
                buf[k++] = level[sib];
            }
            uint256 w;
            for (uint256 i; i < n; i += 2) {
                bytes32 l = level[i];
                bytes32 r = i + 1 < n ? level[i + 1] : l;
                level[w++] = _node(l, r);
            }
            n = w;
            idx /= 2;
        }
        out = new bytes32[](k);
        for (uint256 i; i < k; i++) {
            out[i] = buf[i];
        }
    }

    function _batch(uint256 n) internal pure returns (bytes[] memory recs, bytes32[] memory leaves, bytes32 root) {
        recs = _records(n);
        leaves = _leaves(recs);
        root = _root(leaves);
    }

    // ───────────────────────────── deploy ─────────────────────────────

    function test_deployState() public view {
        assertEq(address(anchors.registry()), address(registry));
        assertEq(address(anchors.accountFactory()), address(factory));
        assertEq(anchors.governance(), gov);
        assertEq(anchors.maxUriBytes(), 256);
        assertEq(anchors.NAME(), "FerminuxMemoryAnchor");
        assertEq(anchors.VERSION(), "1");
        assertEq(
            anchors.ANCHOR_TYPEHASH(),
            keccak256(
                "Anchor(uint256 agentId,bytes32 root,bytes32 prevRoot,uint32 count,string uri,uint256 nonce,uint64 deadline)"
            )
        );
    }

    function test_constructor_revertsZero() public {
        vm.expectRevert(MemoryAnchor.ZeroAddress.selector);
        new MemoryAnchor(AgentRegistry(address(0)), IAccountFactoryLike(address(factory)), gov);
        vm.expectRevert(MemoryAnchor.ZeroAddress.selector);
        new MemoryAnchor(registry, IAccountFactoryLike(address(factory)), address(0));
    }

    function test_headEmptyBeforeAnyAnchor() public view {
        (bytes32 root, uint64 seq, uint64 total, uint64 ts) = anchors.head(agentId);
        assertEq(root, bytes32(0));
        assertEq(seq, 0);
        assertEq(total, 0);
        assertEq(ts, 0);
        assertEq(anchors.anchorCount(agentId), 0);
    }

    // ───────────────────────────── anchoring ─────────────────────────────

    function test_anchor_firstBatch() public {
        (,, bytes32 root) = _batch(5);
        vm.expectEmit(true, true, true, true);
        emit MemoryAnchor.MemoryAnchored(agentId, 1, root, bytes32(0), 5, 5, alice, "fmx://payload/0xdead");
        vm.prank(alice);
        uint64 seq = anchors.anchor(agentId, root, bytes32(0), 5, "fmx://payload/0xdead");
        assertEq(seq, 1);

        (bytes32 h, uint64 s, uint64 total, uint64 ts) = anchors.head(agentId);
        assertEq(h, root);
        assertEq(s, 1);
        assertEq(total, 5);
        assertEq(ts, uint64(block.timestamp));
        assertEq(anchors.anchorCount(agentId), 1);

        MemoryAnchor.Anchor memory a = anchors.getAnchor(agentId, 1);
        assertEq(a.root, root);
        assertEq(a.prevRoot, bytes32(0));
        assertEq(a.seq, 1);
        assertEq(a.count, 5);
        assertEq(a.totalRecords, 5);
        assertEq(a.uri, "fmx://payload/0xdead");
    }

    function test_anchor_chainsRootsAndAccumulates() public {
        (,, bytes32 r1) = _batch(3);
        vm.prank(alice);
        anchors.anchor(agentId, r1, bytes32(0), 3, "");
        bytes32 r2 = keccak256("second-root");
        vm.warp(block.timestamp + 3600);
        vm.prank(alice);
        uint64 seq = anchors.anchor(agentId, r2, r1, 7, "");
        assertEq(seq, 2);

        (bytes32 h, uint64 s, uint64 total,) = anchors.head(agentId);
        assertEq(h, r2);
        assertEq(s, 2);
        assertEq(total, 10);

        MemoryAnchor.Anchor memory a2 = anchors.getAnchor(agentId, 2);
        assertEq(a2.prevRoot, r1, "the chain of roots is itself a chain");
        // the earlier batch is untouched — this log is append-only
        MemoryAnchor.Anchor memory a1 = anchors.getAnchor(agentId, 1);
        assertEq(a1.root, r1);
        assertEq(a1.totalRecords, 3);
    }

    function test_anchor_sequenceIsStrictlyMonotone() public {
        bytes32 prev = bytes32(0);
        for (uint64 i = 1; i <= 6; i++) {
            bytes32 root = keccak256(abi.encodePacked("root", i));
            vm.prank(alice);
            uint64 seq = anchors.anchor(agentId, root, prev, 1, "");
            assertEq(seq, i, "seq must increase by exactly one");
            assertEq(anchors.getAnchor(agentId, i).seq, i);
            prev = root;
        }
        assertEq(anchors.anchorCount(agentId), 6);
        (,, uint64 total,) = anchors.head(agentId);
        assertEq(total, 6);
    }

    function test_anchor_revertsOnStalePrevRoot() public {
        bytes32 r1 = keccak256("r1");
        vm.prank(alice);
        anchors.anchor(agentId, r1, bytes32(0), 1, "");
        // a second writer that never saw r1 tries to append from the genesis position
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(MemoryAnchor.PrevRootMismatch.selector, r1, bytes32(0)));
        anchors.anchor(agentId, keccak256("r2"), bytes32(0), 1, "");
        // and a wrong value is refused too
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(MemoryAnchor.PrevRootMismatch.selector, r1, keccak256("bogus")));
        anchors.anchor(agentId, keccak256("r2"), keccak256("bogus"), 1, "");
    }

    function test_anchor_revertsWhenFirstBatchNamesAPrevRoot() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(MemoryAnchor.PrevRootMismatch.selector, bytes32(0), keccak256("x")));
        anchors.anchor(agentId, keccak256("r1"), keccak256("x"), 1, "");
    }

    function test_anchor_revertsZeroRootAndEmptyBatch() public {
        vm.prank(alice);
        vm.expectRevert(MemoryAnchor.ZeroRoot.selector);
        anchors.anchor(agentId, bytes32(0), bytes32(0), 1, "");
        vm.prank(alice);
        vm.expectRevert(MemoryAnchor.EmptyBatch.selector);
        anchors.anchor(agentId, keccak256("r"), bytes32(0), 0, "");
    }

    function test_anchor_revertsLongUri() public {
        string memory long = new string(257);
        vm.prank(alice);
        vm.expectRevert(MemoryAnchor.StringTooLong.selector);
        anchors.anchor(agentId, keccak256("r"), bytes32(0), 1, long);
    }

    function test_anchor_revertsNotAuthorized() public {
        vm.prank(stranger);
        vm.expectRevert(MemoryAnchor.NotAuthorized.selector);
        anchors.anchor(agentId, keccak256("r"), bytes32(0), 1, "");
    }

    function test_anchor_revertsUnknownAgent() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(MemoryAnchor.UnknownAgent.selector, uint256(999)));
        anchors.anchor(999, keccak256("r"), bytes32(0), 1, "");
    }

    function test_getAnchor_revertsUnknownSeq() public {
        vm.expectRevert(abi.encodeWithSelector(MemoryAnchor.UnknownAnchor.selector, agentId, uint64(1)));
        anchors.getAnchor(agentId, 1);
        vm.prank(alice);
        anchors.anchor(agentId, keccak256("r"), bytes32(0), 1, "");
        vm.expectRevert(abi.encodeWithSelector(MemoryAnchor.UnknownAnchor.selector, agentId, uint64(0)));
        anchors.getAnchor(agentId, 0);
        vm.expectRevert(abi.encodeWithSelector(MemoryAnchor.UnknownAnchor.selector, agentId, uint64(2)));
        anchors.getAnchor(agentId, 2);
    }

    function test_getAnchors_paginates() public {
        bytes32 prev = bytes32(0);
        for (uint64 i = 1; i <= 5; i++) {
            bytes32 root = keccak256(abi.encodePacked("p", i));
            vm.prank(alice);
            anchors.anchor(agentId, root, prev, 2, "");
            prev = root;
        }
        MemoryAnchor.Anchor[] memory page = anchors.getAnchors(agentId, 2, 2);
        assertEq(page.length, 2);
        assertEq(page[0].seq, 2);
        assertEq(page[1].seq, 3);
        assertEq(anchors.getAnchors(agentId, 4, 100).length, 2);
        assertEq(anchors.getAnchors(agentId, 6, 10).length, 0);
        assertEq(anchors.getAnchors(agentId, 1, 0).length, 0);
        assertEq(anchors.getAnchors(agentId, 0, 1)[0].seq, 1, "fromSeq 0 is treated as 1");
    }

    // ───────────────────────────── authority ─────────────────────────────

    function test_anchor_byAgentAccountOfTheOwner() public {
        AgentAccount acct = AgentAccount(payable(factory.create(alice, bytes32("mem"))));
        assertTrue(anchors.canAnchor(agentId, address(acct)));
        bytes32 root = keccak256("via-account");
        vm.prank(alice);
        acct.execute(
            address(anchors), 0, abi.encodeCall(MemoryAnchor.anchor, (agentId, root, bytes32(0), 4, "fmx://x"))
        );
        (bytes32 h,, uint64 total,) = anchors.head(agentId);
        assertEq(h, root);
        assertEq(total, 4);
    }

    function test_anchor_foreignAgentAccountRejected() public {
        AgentAccount acct = AgentAccount(payable(factory.create(mallory, bytes32("evil"))));
        assertFalse(anchors.canAnchor(agentId, address(acct)));
        vm.prank(mallory);
        vm.expectRevert(MemoryAnchor.NotAuthorized.selector); // AgentAccount bubbles the target's revert data
        acct.execute(
            address(anchors), 0, abi.encodeCall(MemoryAnchor.anchor, (agentId, keccak256("r"), bytes32(0), 1, ""))
        );
        assertEq(anchors.anchorCount(agentId), 0);
    }

    function test_setAnchorer_grantAndRevoke() public {
        address gatewayKey = makeAddr("gateway");
        vm.prank(alice);
        vm.expectEmit(true, true, true, true);
        emit MemoryAnchor.AnchorerSet(agentId, gatewayKey, true);
        anchors.setAnchorer(agentId, gatewayKey, true);
        assertTrue(anchors.canAnchor(agentId, gatewayKey));

        bytes32 r1 = keccak256("by-gateway");
        vm.prank(gatewayKey);
        anchors.anchor(agentId, r1, bytes32(0), 9, "");
        (bytes32 h,,,) = anchors.head(agentId);
        assertEq(h, r1);

        vm.prank(alice);
        anchors.setAnchorer(agentId, gatewayKey, false);
        assertFalse(anchors.canAnchor(agentId, gatewayKey));
        vm.prank(gatewayKey);
        vm.expectRevert(MemoryAnchor.NotAuthorized.selector);
        anchors.anchor(agentId, keccak256("r2"), r1, 1, "");
    }

    function test_setAnchorer_ownerOnlyAndZero() public {
        vm.prank(stranger);
        vm.expectRevert(MemoryAnchor.NotAuthorized.selector);
        anchors.setAnchorer(agentId, stranger, true);
        vm.prank(alice);
        vm.expectRevert(MemoryAnchor.ZeroAddress.selector);
        anchors.setAnchorer(agentId, address(0), true);
    }

    function test_anchor_followsAgentOwnershipTransfer() public {
        vm.prank(alice);
        anchors.anchor(agentId, keccak256("r1"), bytes32(0), 1, "");
        vm.prank(alice);
        registry.transferOwnership(agentId, mallory);
        // memory is keyed by agent, so the new owner continues the SAME chain
        vm.prank(mallory);
        anchors.anchor(agentId, keccak256("r2"), keccak256("r1"), 1, "");
        (, uint64 seq, uint64 total,) = anchors.head(agentId);
        assertEq(seq, 2);
        assertEq(total, 2);
        vm.prank(alice);
        vm.expectRevert(MemoryAnchor.NotAuthorized.selector);
        anchors.anchor(agentId, keccak256("r3"), keccak256("r2"), 1, "");
    }

    // ───────────────────────────── relayed (signed) anchoring ─────────────────────────────

    function _sign(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function test_anchorFor_signedByOwner() public {
        bytes32 root = keccak256("signed");
        uint64 deadline = uint64(block.timestamp + 600);
        bytes32 digest = anchors.hashAnchor(agentId, root, bytes32(0), 3, "fmx://u", 0, deadline);
        bytes memory sig = _sign(alicePk, digest);

        assertEq(anchors.nonceOf(agentId), 0);
        vm.prank(relayer);
        uint64 seq = anchors.anchorFor(agentId, root, bytes32(0), 3, "fmx://u", deadline, sig);
        assertEq(seq, 1);
        assertEq(anchors.nonceOf(agentId), 1);
        (bytes32 h,, uint64 total,) = anchors.head(agentId);
        assertEq(h, root);
        assertEq(total, 3);
    }

    function test_anchorFor_replayReverts() public {
        bytes32 root = keccak256("replay");
        uint64 deadline = uint64(block.timestamp + 600);
        bytes memory sig = _sign(alicePk, anchors.hashAnchor(agentId, root, bytes32(0), 1, "", 0, deadline));
        vm.prank(relayer);
        anchors.anchorFor(agentId, root, bytes32(0), 1, "", deadline, sig);
        // same signature again: the nonce has moved, so the digest no longer matches
        vm.prank(relayer);
        vm.expectRevert(MemoryAnchor.BadSignature.selector);
        anchors.anchorFor(agentId, root, bytes32(0), 1, "", deadline, sig);
    }

    function test_anchorFor_expiredReverts() public {
        uint64 deadline = uint64(block.timestamp + 10);
        bytes memory sig = _sign(alicePk, anchors.hashAnchor(agentId, keccak256("x"), bytes32(0), 1, "", 0, deadline));
        vm.warp(block.timestamp + 11);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(MemoryAnchor.ExpiredSignature.selector, deadline));
        anchors.anchorFor(agentId, keccak256("x"), bytes32(0), 1, "", deadline, sig);
    }

    function test_anchorFor_wrongSignerReverts() public {
        uint64 deadline = uint64(block.timestamp + 600);
        bytes memory sig = _sign(malloryPk, anchors.hashAnchor(agentId, keccak256("x"), bytes32(0), 1, "", 0, deadline));
        vm.prank(relayer);
        vm.expectRevert(MemoryAnchor.BadSignature.selector);
        anchors.anchorFor(agentId, keccak256("x"), bytes32(0), 1, "", deadline, sig);
    }

    function test_anchorFor_tamperedFieldReverts() public {
        uint64 deadline = uint64(block.timestamp + 600);
        bytes memory sig = _sign(alicePk, anchors.hashAnchor(agentId, keccak256("x"), bytes32(0), 1, "", 0, deadline));
        vm.prank(relayer);
        vm.expectRevert(MemoryAnchor.BadSignature.selector);
        anchors.anchorFor(agentId, keccak256("x"), bytes32(0), 99, "", deadline, sig); // count changed
    }

    function test_anchorFor_erc1271ContractOwner() public {
        AgentAccount acct = AgentAccount(payable(factory.create(alice, bytes32("owner"))));
        vm.prank(alice);
        registry.transferOwnership(agentId, address(acct));

        bytes32 root = keccak256("1271");
        uint64 deadline = uint64(block.timestamp + 600);
        bytes memory sig = _sign(alicePk, anchors.hashAnchor(agentId, root, bytes32(0), 2, "", 0, deadline));
        vm.prank(relayer);
        anchors.anchorFor(agentId, root, bytes32(0), 2, "", deadline, sig);
        (bytes32 h,,,) = anchors.head(agentId);
        assertEq(h, root);
    }

    function test_anchorFor_revertsUnknownAgent() public {
        uint64 deadline = uint64(block.timestamp + 600);
        vm.expectRevert(abi.encodeWithSelector(MemoryAnchor.UnknownAgent.selector, uint256(42)));
        anchors.anchorFor(42, keccak256("x"), bytes32(0), 1, "", deadline, hex"00");
    }

    // ───────────────────────────── merkle: leaves and roots ─────────────────────────────

    function test_leafOf_matchesReference() public view {
        bytes memory record = bytes('{"seq":1,"op":"put"}');
        assertEq(anchors.recordLeaf(record), _leafFor(record));
        assertEq(anchors.leafOf(keccak256(record)), _leafFor(record));
    }

    function test_computeRoot_matchesReference() public view {
        for (uint256 n = 1; n <= 9; n++) {
            (, bytes32[] memory leaves, bytes32 root) = _batch(n);
            assertEq(anchors.computeRoot(leaves), root, "root mismatch");
        }
    }

    function test_computeRoot_singleLeafIsTheLeaf() public view {
        bytes32[] memory one = new bytes32[](1);
        one[0] = _leafFor("only");
        assertEq(anchors.computeRoot(one), one[0]);
    }

    function test_computeRoot_revertsEmpty() public {
        bytes32[] memory none = new bytes32[](0);
        vm.expectRevert(MemoryAnchor.EmptyBatch.selector);
        anchors.computeRoot(none);
    }

    function test_leafAndNodeDomainsDiffer() public view {
        // a node hash can never be mistaken for a leaf hash: different domain tags
        bytes32 h = keccak256("x");
        assertTrue(anchors.leafOf(h) != keccak256(abi.encodePacked(bytes1(0x01), h, h)));
    }

    // ───────────────────────────── merkle: verification ─────────────────────────────

    function test_verify_everyLeafOfEveryTreeSize() public view {
        for (uint256 n = 1; n <= 9; n++) {
            (bytes[] memory recs, bytes32[] memory leaves, bytes32 root) = _batch(n);
            for (uint256 i; i < n; i++) {
                assertTrue(anchors.verify(root, recs[i], _proof(leaves, i), i, n), "proof should verify");
            }
        }
    }

    function test_verify_oddTreeDuplicatesTheLastNode() public view {
        // 3 leaves: index 2 is the odd node, paired with itself, and its proof is one element shorter
        (bytes[] memory recs, bytes32[] memory leaves, bytes32 root) = _batch(3);
        bytes32[] memory p2 = _proof(leaves, 2);
        assertEq(p2.length, 1, "odd last node consumes no proof element at the leaf level");
        assertTrue(anchors.verify(root, recs[2], p2, 2, 3));
        assertEq(_proof(leaves, 0).length, 2);
    }

    function test_verify_rejectsWrongIndex() public view {
        (bytes[] memory recs, bytes32[] memory leaves, bytes32 root) = _batch(4);
        assertFalse(anchors.verify(root, recs[1], _proof(leaves, 1), 0, 4), "proof replayed at another index");
        assertFalse(anchors.verify(root, recs[1], _proof(leaves, 1), 4, 4), "index out of range");
    }

    function test_verify_rejectsForgedSibling() public view {
        (bytes[] memory recs, bytes32[] memory leaves, bytes32 root) = _batch(4);
        bytes32[] memory p = _proof(leaves, 0);
        p[0] = keccak256("forged");
        assertFalse(anchors.verify(root, recs[0], p, 0, 4));
    }

    function test_verify_rejectsRecordNotInTheBatch() public view {
        (, bytes32[] memory leaves, bytes32 root) = _batch(4);
        assertFalse(anchors.verify(root, bytes("a record that was never written"), _proof(leaves, 0), 0, 4));
    }

    function test_verify_rejectsExtraProofElement() public view {
        (bytes[] memory recs, bytes32[] memory leaves, bytes32 root) = _batch(4);
        bytes32[] memory p = _proof(leaves, 0);
        bytes32[] memory padded = new bytes32[](p.length + 1);
        for (uint256 i; i < p.length; i++) {
            padded[i] = p[i];
        }
        padded[p.length] = keccak256("junk");
        assertFalse(anchors.verify(root, recs[0], padded, 0, 4), "leftover proof elements must be rejected");
    }

    function test_verify_rejectsShortProof() public view {
        (bytes[] memory recs, bytes32[] memory leaves, bytes32 root) = _batch(4);
        bytes32[] memory p = _proof(leaves, 0);
        bytes32[] memory short = new bytes32[](p.length - 1);
        for (uint256 i; i < short.length; i++) {
            short[i] = p[i];
        }
        assertFalse(anchors.verify(root, recs[0], short, 0, 4));
    }

    function test_verify_countPinsTheTreeShape() public view {
        // the classic [a,b,c] vs [a,b,c,c] ambiguity: the anchored count closes it
        (bytes[] memory recs3, bytes32[] memory leaves3, bytes32 root3) = _batch(3);
        bytes32[] memory leaves4 = new bytes32[](4);
        for (uint256 i; i < 3; i++) {
            leaves4[i] = leaves3[i];
        }
        leaves4[3] = leaves3[2]; // duplicate the last leaf
        assertEq(_root(leaves4), root3, "the two leaf sets fold to the same root by construction");
        // a proof built for the 4-leaf reading is rejected when the anchored count says 3
        assertFalse(anchors.verify(root3, recs3[2], _proof(leaves4, 3), 3, 3), "index >= count");
        assertTrue(anchors.verify(root3, recs3[2], _proof(leaves3, 2), 2, 3));
    }

    function test_verify_rejectsZeroRootAndZeroCount() public view {
        (bytes[] memory recs, bytes32[] memory leaves,) = _batch(2);
        assertFalse(anchors.verify(bytes32(0), recs[0], _proof(leaves, 0), 0, 2));
        assertFalse(anchors.verify(keccak256("r"), recs[0], _proof(leaves, 0), 0, 0));
    }

    function test_verifyRecord_againstStoredAnchor() public {
        (bytes[] memory recs, bytes32[] memory leaves, bytes32 root) = _batch(6);
        vm.prank(alice);
        anchors.anchor(agentId, root, bytes32(0), 6, "");
        for (uint256 i; i < 6; i++) {
            assertTrue(anchors.verifyRecord(agentId, 1, recs[i], _proof(leaves, i), i));
            assertTrue(anchors.verifyAgainstHead(agentId, recs[i], _proof(leaves, i), i));
        }
        assertFalse(anchors.verifyRecord(agentId, 1, bytes("forged"), _proof(leaves, 0), 0));
    }

    function test_verifyRecord_wrongBatchFails() public {
        (bytes[] memory recsA, bytes32[] memory leavesA, bytes32 rootA) = _batch(4);
        vm.prank(alice);
        anchors.anchor(agentId, rootA, bytes32(0), 4, "");
        bytes32 rootB = keccak256("other-batch");
        vm.prank(alice);
        anchors.anchor(agentId, rootB, rootA, 4, "");
        // a record of batch 1 does not verify against batch 2's root
        assertFalse(anchors.verifyRecord(agentId, 2, recsA[0], _proof(leavesA, 0), 0));
        assertTrue(anchors.verifyRecord(agentId, 1, recsA[0], _proof(leavesA, 0), 0));
        // and the head is now batch 2
        assertFalse(anchors.verifyAgainstHead(agentId, recsA[0], _proof(leavesA, 0), 0));
    }

    function test_verifyAgainstHead_falseWhenNeverAnchored() public view {
        (bytes[] memory recs, bytes32[] memory leaves,) = _batch(2);
        assertFalse(anchors.verifyAgainstHead(agentId, recs[0], _proof(leaves, 0), 0));
    }

    function test_verifyRecord_revertsUnknownAnchor() public {
        (bytes[] memory recs, bytes32[] memory leaves,) = _batch(2);
        vm.expectRevert(abi.encodeWithSelector(MemoryAnchor.UnknownAnchor.selector, agentId, uint64(1)));
        anchors.verifyRecord(agentId, 1, recs[0], _proof(leaves, 0), 0);
    }

    function testFuzz_verify(uint8 rawN, uint8 rawI) public view {
        uint256 n = (uint256(rawN) % 24) + 1;
        uint256 i = uint256(rawI) % n;
        (bytes[] memory recs, bytes32[] memory leaves, bytes32 root) = _batch(n);
        assertTrue(anchors.verify(root, recs[i], _proof(leaves, i), i, n));
        if (n > 1) {
            uint256 other = (i + 1) % n;
            assertFalse(anchors.verify(root, recs[i], _proof(leaves, other), other, n));
        }
    }

    // ───────────────────────────── cost ─────────────────────────────

    function test_anchor_costIsFlatRegardlessOfBatchSize() public {
        // warm up: the first-ever batch for an agent also pays for the cold array slot
        vm.prank(alice);
        anchors.anchor(agentId, keccak256("warm"), bytes32(0), 1, "");

        uint256 g0 = gasleft();
        vm.prank(alice);
        anchors.anchor(agentId, keccak256("small"), keccak256("warm"), 1, "");
        uint256 small = g0 - gasleft();

        g0 = gasleft();
        vm.prank(alice);
        anchors.anchor(agentId, keccak256("huge"), keccak256("small"), 1_000_000, "");
        uint256 huge = g0 - gasleft();

        // a 1-record batch and a 1,000,000-record batch cost within a rounding error of each other
        uint256 diff = huge > small ? huge - small : small - huge;
        assertLt(diff, small / 20, "per-record gas must be zero");
        assertLt(huge, 120_000, "one batch must stay a small tx");
    }

    // ───────────────────────────── governance ─────────────────────────────

    function test_setMaxUriBytes() public {
        vm.prank(gov);
        vm.expectEmit(true, true, true, true);
        emit MemoryAnchor.MaxUriBytesChanged(8);
        anchors.setMaxUriBytes(8);
        assertEq(anchors.maxUriBytes(), 8);
        vm.prank(alice);
        vm.expectRevert(MemoryAnchor.StringTooLong.selector);
        anchors.anchor(agentId, keccak256("r"), bytes32(0), 1, "123456789");
        vm.prank(alice);
        anchors.anchor(agentId, keccak256("r"), bytes32(0), 1, "12345678");
    }

    function test_governance_access() public {
        vm.prank(stranger);
        vm.expectRevert(MemoryAnchor.NotGovernance.selector);
        anchors.setMaxUriBytes(1);
        vm.prank(stranger);
        vm.expectRevert(MemoryAnchor.NotGovernance.selector);
        anchors.setGovernance(stranger);
        vm.prank(gov);
        vm.expectRevert(MemoryAnchor.ZeroAddress.selector);
        anchors.setGovernance(address(0));
        address multisig = makeAddr("multisig");
        vm.prank(gov);
        vm.expectEmit(true, true, true, true);
        emit MemoryAnchor.GovernanceChanged(gov, multisig);
        anchors.setGovernance(multisig);
        assertEq(anchors.governance(), multisig);
        vm.prank(gov);
        vm.expectRevert(MemoryAnchor.NotGovernance.selector);
        anchors.setMaxUriBytes(1);
    }

    // ───────────────────────────── no factory configured ─────────────────────────────

    function test_worksWithoutAccountFactory() public {
        MemoryAnchor bare = new MemoryAnchor(registry, IAccountFactoryLike(address(0)), gov);
        AgentAccount acct = AgentAccount(payable(factory.create(alice, bytes32("x"))));
        assertFalse(bare.canAnchor(agentId, address(acct)), "no factory -> no implicit account authority");
        assertTrue(bare.canAnchor(agentId, alice));
        vm.prank(alice);
        bare.anchor(agentId, keccak256("r"), bytes32(0), 1, "");
        assertEq(bare.anchorCount(agentId), 1);
    }
}
