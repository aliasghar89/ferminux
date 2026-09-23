// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {FerminuxLightClient} from "../../src/proof/FerminuxLightClient.sol";
import {FerminuxSentVerifier} from "../../src/proof/FerminuxSentVerifier.sol";
import {MerkleTrie} from "../../src/proof/vendor/MerkleTrie.sol";
import {FerminuxBridge} from "../../src/FerminuxBridge.sol";

/// @notice Real-data half: headers and receipts are REAL Ferminux mainnet
///         blocks (bridge/tools/proof/gen-fixtures.mjs checks each one hashes to
///         the block hash the node reports). Synthetic half: a private chain in
///         the identical format, for attacks mainnet never shows.
contract FerminuxProofTest is Test {
    uint64 constant EPOCH = 30000;
    uint64 constant PERIOD = 7;
    address constant FERMINUX_BRIDGE = 0xe162eeDa683f067d4Ebf61060Fa322332a779EF4;

    string json;
    address owner = makeAddr("owner");
    address guardian = makeAddr("guardian");

    function setUp() public {
        json = vm.readFile("test/fixtures/ferminux-proof.json");
    }

    // ------------------------------------------------------------ helpers

    function _bytesArr(string memory path) internal view returns (bytes[] memory) {
        return vm.parseJsonBytesArray(json, path);
    }

    function _slice(bytes[] memory a, uint256 from, uint256 to) internal pure returns (bytes[] memory out) {
        out = new bytes[](to - from);
        for (uint256 i = from; i < to; i++) out[i - from] = a[i];
    }

    function _realClient() internal returns (FerminuxLightClient lc) {
        lc = new FerminuxLightClient(vm.parseJsonBytes(json, ".real.bootstrap.header"), EPOCH, PERIOD, owner, guardian);
    }

    function _realClientAtHead() internal returns (FerminuxLightClient lc) {
        lc = _realClient();
        for (uint256 i = 1; i < 7; i++) {
            lc.advance(_bytesArr(string.concat(".real.checkpoints[", vm.toString(i), "].headers")));
        }
    }

    function _synthClient() internal returns (FerminuxLightClient lc) {
        lc = new FerminuxLightClient(vm.parseJsonBytes(json, ".synthetic.checkpoint"), EPOCH, PERIOD, owner, guardian);
    }

    function _transfer() internal view returns (FerminuxBridge.BridgeTransfer memory t) {
        t.srcChainId = uint64(vm.parseUint(vm.parseJsonString(json, ".synthetic.sent.transfer.srcChainId")));
        t.dstChainId = uint64(vm.parseUint(vm.parseJsonString(json, ".synthetic.sent.transfer.dstChainId")));
        t.nonce = uint64(vm.parseUint(vm.parseJsonString(json, ".synthetic.sent.transfer.nonce")));
        t.srcToken = vm.parseJsonAddress(json, ".synthetic.sent.transfer.srcToken");
        t.dstToken = vm.parseJsonAddress(json, ".synthetic.sent.transfer.dstToken");
        t.sender = vm.parseJsonAddress(json, ".synthetic.sent.transfer.sender");
        t.recipient = vm.parseJsonAddress(json, ".synthetic.sent.transfer.recipient");
        t.amount = vm.parseUint(vm.parseJsonString(json, ".synthetic.sent.transfer.amount"));
    }

    function _sentProof(string memory which, uint256 txIndex, uint256 logIndex) internal view returns (bytes memory) {
        bytes[] memory chain = _bytesArr(".synthetic.chain");
        // Target E+1 (carries the receipts root) + three descendants: seals by 4 distinct signers.
        bytes[] memory headers = _slice(chain, 1, 5);
        bytes[] memory proof = _bytesArr(string.concat(".synthetic.sent.", which, ".proof"));
        return abi.encode(headers, proof, txIndex, logIndex);
    }

    // ================================================ REAL MAINNET DATA

    function test_real_bootstrapAnchorsTheRealCheckpoint() public {
        FerminuxLightClient lc = _realClient();
        assertEq(lc.BOOTSTRAP_HASH(), vm.parseJsonBytes32(json, ".real.bootstrap.hash"));
        assertEq(lc.latestCheckpoint(), 180000);
        address[] memory s = lc.signersAt(180000);
        assertEq(s.length, 5);
        assertEq(s[0], 0x1538249E04c767dFfC50845068C19F633341bB0f);
        assertEq(lc.quorum(180000), 3);
    }

    function test_real_advancesThroughEveryCheckpointToHead() public {
        FerminuxLightClient lc = _realClientAtHead();
        assertEq(lc.latestCheckpoint(), 360000);
        assertEq(lc.signersAt(360000).length, 5);
    }

    function test_real_blocksAreFinalAndReceiptsProve() public {
        FerminuxLightClient lc = _realClientAtHead();
        for (uint256 k = 0; k < 2; k++) {
            string memory base = string.concat(".real.receipts[", vm.toString(k), "]");
            FerminuxLightClient.Verified memory v = lc.verifyFinal(_bytesArr(string.concat(base, ".headers")));
            assertEq(v.number, vm.parseJsonUint(json, string.concat(base, ".blockNumber")));

            uint256 txIndex = vm.parseJsonUint(json, string.concat(base, ".txIndex"));
            bytes memory key = txIndex == 0 ? bytes(hex"80") : abi.encodePacked(uint8(txIndex));
            bytes memory got = MerkleTrie.get(key, _bytesArr(string.concat(base, ".proof")), v.receiptsRoot);
            assertEq(got, vm.parseJsonBytes(json, string.concat(base, ".receiptRaw")));
        }
    }

    /// The whole pipeline on real data up to the event check: a real agent-
    /// registry log is proven final and decoded, then refused as not-a-Sent.
    function test_real_verifierRefusesARealNonSentLog() public {
        FerminuxLightClient lc = _realClientAtHead();
        address emitter = vm.parseJsonAddress(json, ".real.receipts[1].log.address");
        FerminuxSentVerifier sv = new FerminuxSentVerifier(lc, emitter, 3961);
        bytes memory proof = abi.encode(
            _bytesArr(".real.receipts[1].headers"),
            _bytesArr(".real.receipts[1].proof"),
            vm.parseJsonUint(json, ".real.receipts[1].txIndex"),
            vm.parseJsonUint(json, ".real.receipts[1].logIndex")
        );
        FerminuxBridge.BridgeTransfer memory t = _transfer();
        vm.expectRevert(bytes("SV: not a Sent log"));
        sv.verifySent(t, proof);
    }

    function test_real_tooFewDescendantsIsNotFinal() public {
        FerminuxLightClient lc = _realClientAtHead();
        bytes[] memory h = _bytesArr(".real.receipts[0].headers");
        vm.expectRevert(bytes("LC: not final"));
        lc.verifyFinal(_slice(h, 0, 2)); // two seals of five: no majority
    }

    function test_real_tamperedHeaderIsRefused() public {
        FerminuxLightClient lc = _realClientAtHead();
        bytes[] memory h = _bytesArr(".real.receipts[0].headers");
        // Flip a byte of the target's receiptsRoot: the seal no longer matches
        // any signer, and its child no longer links to it.
        bytes memory target = h[0];
        target[100] = bytes1(uint8(target[100]) ^ 0x01);
        h[0] = target;
        vm.expectRevert();
        lc.verifyFinal(h);
    }

    function test_real_checkpointsCannotBeSkipped() public {
        FerminuxLightClient lc = _realClient();
        vm.expectRevert(bytes("LC: checkpoints must be sequential"));
        lc.advance(_bytesArr(".real.checkpoints[2].headers")); // 240000 straight after 180000
    }

    function test_real_unknownEpochCannotBeProven() public {
        FerminuxLightClient lc = _realClient(); // only 180000 known
        vm.expectRevert(bytes("LC: unknown signer set"));
        lc.verifyFinal(_bytesArr(".real.receipts[0].headers")); // block in epoch 360000
    }

    function test_real_reorderedRunIsRefused() public {
        FerminuxLightClient lc = _realClientAtHead();
        bytes[] memory h = _bytesArr(".real.receipts[0].headers");
        (h[1], h[2]) = (h[2], h[1]);
        vm.expectRevert(bytes("LC: broken parent link"));
        lc.verifyFinal(h);
    }

    function test_real_finalizeCaches() public {
        FerminuxLightClient lc = _realClientAtHead();
        FerminuxLightClient.Verified memory v = lc.finalize(_bytesArr(".real.receipts[0].headers"));
        assertEq(lc.finalized(v.hash).number, v.number);
    }

    // ================================================ SYNTHETIC ATTACKS

    function test_synth_finalWithMajority() public {
        FerminuxLightClient lc = _synthClient();
        bytes[] memory chain = _bytesArr(".synthetic.chain");
        lc.verifyFinal(_slice(chain, 1, 4)); // seals 1,2,3 of 5
    }

    function test_synth_outsiderSealIsRefused() public {
        FerminuxLightClient lc = _synthClient();
        bytes[] memory h = new bytes[](1);
        h[0] = vm.parseJsonBytes(json, ".synthetic.outsiderHeader");
        vm.expectRevert(bytes("LC: target not sealed by the set"));
        lc.verifyFinal(h);
    }

    function test_synth_twoSignersTakingTurnsNeverFinalise() public {
        FerminuxLightClient lc = _synthClient();
        vm.expectRevert(bytes("LC: not final"));
        lc.verifyFinal(_bytesArr(".synthetic.weakChain"));
    }

    function test_synth_conflictingFinalBranchesFreeze() public {
        FerminuxLightClient lc = _synthClient();
        bytes[] memory chain = _bytesArr(".synthetic.chain");
        bytes[] memory a = _slice(chain, 2, 5);
        bytes[] memory b = _bytesArr(".synthetic.conflictBranch");
        lc.proveConflict(a, b);
        assertTrue(lc.frozen());
        vm.expectRevert(bytes("LC: frozen"));
        lc.verifyFinal(a);
        vm.prank(guardian);
        vm.expectRevert(bytes("LC: not owner"));
        lc.unfreeze();
        vm.prank(owner);
        lc.unfreeze();
        lc.verifyFinal(a);
    }

    function test_synth_sameBranchTwiceIsNotAConflict() public {
        FerminuxLightClient lc = _synthClient();
        bytes[] memory chain = _bytesArr(".synthetic.chain");
        bytes[] memory a = _slice(chain, 2, 5);
        vm.expectRevert(bytes("LC: same block"));
        lc.proveConflict(a, a);
    }

    function test_synth_advanceAdoptsChangedSetSealedByOldMajority() public {
        FerminuxLightClient lc = _synthClient();
        lc.advance(_bytesArr(".synthetic.nextCheckpoint.headers"));
        uint64 next = uint64(vm.parseJsonUint(json, ".synthetic.nextCheckpoint.number"));
        assertEq(lc.latestCheckpoint(), next);
        address[] memory want = vm.parseJsonAddressArray(json, ".synthetic.nextCheckpoint.signers");
        address[] memory got = lc.signersAt(next);
        assertEq(got.length, want.length);
        for (uint256 i = 0; i < want.length; i++) assertEq(got[i], want[i]);
    }

    function test_synth_guardianFreezes() public {
        FerminuxLightClient lc = _synthClient();
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(bytes("LC: not guardian"));
        lc.freeze();
        vm.prank(guardian);
        lc.freeze();
        assertTrue(lc.frozen());
    }

    // ---------------------------------------------------- Sent verifier

    function test_sent_provenTransferVerifies() public {
        FerminuxLightClient lc = _synthClient();
        FerminuxSentVerifier sv = new FerminuxSentVerifier(lc, FERMINUX_BRIDGE, 3961);
        (bytes32 id,, uint64 num) = sv.verifySent(_transfer(), _sentProof("okProof", 1, 1));
        assertEq(id, vm.parseJsonBytes32(json, ".synthetic.sent.transferId"));
        assertEq(num, uint64(vm.parseJsonUint(json, ".synthetic.epochNumber")) + 1);
    }

    function test_sent_everyFieldIsBound() public {
        FerminuxLightClient lc = _synthClient();
        FerminuxSentVerifier sv = new FerminuxSentVerifier(lc, FERMINUX_BRIDGE, 3961);
        bytes memory proof = _sentProof("okProof", 1, 1);
        FerminuxBridge.BridgeTransfer memory t;

        t = _transfer(); t.amount += 1;
        vm.expectRevert(bytes("SV: amount mismatch")); sv.verifySent(t, proof);
        t = _transfer(); t.recipient = address(0xBEEF);
        vm.expectRevert(bytes("SV: party mismatch")); sv.verifySent(t, proof);
        t = _transfer(); t.sender = address(0xBEEF);
        vm.expectRevert(bytes("SV: party mismatch")); sv.verifySent(t, proof);
        t = _transfer(); t.nonce += 1;
        vm.expectRevert(bytes("SV: nonce mismatch")); sv.verifySent(t, proof);
        t = _transfer(); t.dstToken = address(0xBEEF);
        vm.expectRevert(bytes("SV: token mismatch")); sv.verifySent(t, proof);
        t = _transfer(); t.dstChainId = 1;
        vm.expectRevert(bytes("SV: dst chain mismatch")); sv.verifySent(t, proof);
        t = _transfer(); t.srcChainId = 1;
        vm.expectRevert(bytes("SV: src chain mismatch")); sv.verifySent(t, proof);
    }

    function test_sent_decoyLogInSameReceiptIsRefused() public {
        FerminuxLightClient lc = _synthClient();
        FerminuxSentVerifier sv = new FerminuxSentVerifier(lc, FERMINUX_BRIDGE, 3961);
        FerminuxBridge.BridgeTransfer memory t = _transfer();
        vm.expectRevert(bytes("SV: not the source bridge"));
        sv.verifySent(t, _sentProof("okProof", 1, 0));
    }

    function test_sent_failedTransactionIsRefused() public {
        FerminuxLightClient lc = _synthClient();
        FerminuxSentVerifier sv = new FerminuxSentVerifier(lc, FERMINUX_BRIDGE, 3961);
        FerminuxBridge.BridgeTransfer memory t = _transfer();
        vm.expectRevert(bytes("SV: transaction failed"));
        sv.verifySent(t, _sentProof("failedProof", 2, 0));
    }

    function test_sent_otherBridgeDeploymentIsRefused() public {
        FerminuxLightClient lc = _synthClient();
        FerminuxSentVerifier sv = new FerminuxSentVerifier(lc, address(0xB0B), 3961);
        FerminuxBridge.BridgeTransfer memory t = _transfer();
        vm.expectRevert(bytes("SV: not the source bridge"));
        sv.verifySent(t, _sentProof("okProof", 1, 1));
    }

    function test_sent_proofForWrongIndexIsRefused() public {
        FerminuxLightClient lc = _synthClient();
        FerminuxSentVerifier sv = new FerminuxSentVerifier(lc, FERMINUX_BRIDGE, 3961);
        FerminuxBridge.BridgeTransfer memory t = _transfer();
        vm.expectRevert();
        sv.verifySent(t, _sentProof("okProof", 2, 1)); // proof is for key rlp(1)
    }

    function test_sent_frozenClientStopsVerification() public {
        FerminuxLightClient lc = _synthClient();
        FerminuxSentVerifier sv = new FerminuxSentVerifier(lc, FERMINUX_BRIDGE, 3961);
        vm.prank(guardian);
        lc.freeze();
        FerminuxBridge.BridgeTransfer memory t = _transfer();
        vm.expectRevert(bytes("LC: frozen"));
        sv.verifySent(t, _sentProof("okProof", 1, 1));
    }

    function test_gas_realProof() public {
        FerminuxLightClient lc = _realClientAtHead();
        bytes[] memory h = _bytesArr(".real.receipts[0].headers");
        uint256 g = gasleft();
        lc.verifyFinal(_slice(h, 0, 5));
        emit log_named_uint("verifyFinal gas, 5 real headers", g - gasleft());
    }
}
