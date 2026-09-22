// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {X402Vault} from "../src/X402Vault.sol";
import {AgentAccount} from "../src/AgentAccount.sol";
import {AgentAccountFactory} from "../src/AgentAccountFactory.sol";
import {Rejecter} from "./Base.t.sol";

contract X402VaultTest is Test {
    X402Vault internal vault;

    address internal gov = makeAddr("governance");
    address internal treasury = makeAddr("treasury");
    address internal payer;
    uint256 internal payerPk;
    address internal payee = makeAddr("payee");
    address internal relayer = makeAddr("relayer");
    address internal mallory;
    uint256 internal malloryPk;

    function setUp() public {
        (payer, payerPk) = makeAddrAndKey("payer");
        (mallory, malloryPk) = makeAddrAndKey("mallory");
        vault = new X402Vault(gov, treasury);
        vm.deal(payer, 100 ether);
        vm.deal(relayer, 1 ether);
        vm.warp(1_700_000_000);
        vm.prank(payer);
        vault.deposit{value: 10 ether}();
    }

    function _voucher(uint256 amount, uint256 nonce) internal view returns (X402Vault.Voucher memory v) {
        v = X402Vault.Voucher({
            payer: payer,
            payee: payee,
            amount: amount,
            nonce: nonce,
            expiry: uint64(block.timestamp + 60),
            ref: keccak256("resource")
        });
    }

    function _sign(uint256 pk, X402Vault.Voucher memory v) internal view returns (bytes memory) {
        (uint8 vv, bytes32 r, bytes32 s) = vm.sign(pk, vault.hashVoucher(v));
        return abi.encodePacked(r, s, vv);
    }

    function _fee(uint256 amount) internal view returns (uint256) {
        return (amount * vault.feeBps()) / 10000;
    }

    // ───────────────────────────── deploy / deposit ─────────────────────────────

    function test_deployState() public view {
        assertEq(vault.governance(), gov);
        assertEq(vault.feeRecipient(), treasury);
        assertEq(vault.feeBps(), 100);
        assertEq(vault.UNLOCK_DELAY(), 1 hours);
        assertEq(vault.balance(payer), 10 ether);
    }

    function test_constructor_revertsZero() public {
        vm.expectRevert(X402Vault.ZeroAddress.selector);
        new X402Vault(address(0), treasury);
        vm.expectRevert(X402Vault.ZeroAddress.selector);
        new X402Vault(gov, address(0));
    }

    function test_deposit_emitsAndAccumulates() public {
        vm.prank(payer);
        vm.expectEmit(true, true, true, true);
        emit X402Vault.Deposited(payer, 1 ether);
        vault.deposit{value: 1 ether}();
        assertEq(vault.balance(payer), 11 ether);
    }

    function test_deposit_revertsZero() public {
        vm.prank(payer);
        vm.expectRevert(X402Vault.ZeroValue.selector);
        vault.deposit{value: 0}();
    }

    function test_depositFor() public {
        vm.prank(payer);
        vault.depositFor{value: 2 ether}(mallory);
        assertEq(vault.balance(mallory), 2 ether);
        vm.prank(payer);
        vm.expectRevert(X402Vault.ZeroAddress.selector);
        vault.depositFor{value: 1}(address(0));
    }

    // ───────────────────────────── settle ─────────────────────────────

    function test_settle_happyPath() public {
        X402Vault.Voucher memory v = _voucher(1 ether, 1);
        bytes memory sig = _sign(payerPk, v);
        uint256 fee = _fee(1 ether);
        vm.prank(relayer);
        vm.expectEmit(true, true, true, true);
        emit X402Vault.Settled(payer, payee, 1 ether, fee, 1, keccak256("resource"));
        vault.settle(v, sig);
        assertEq(vault.balance(payer), 9 ether);
        assertEq(vault.credits(payee), 1 ether - fee);
        assertEq(vault.credits(treasury), fee);
        assertTrue(vault.used(payer, 1));
    }

    function test_settle_nonceReplayRejected() public {
        X402Vault.Voucher memory v = _voucher(1 ether, 7);
        bytes memory sig = _sign(payerPk, v);
        vault.settle(v, sig);
        vm.expectRevert(abi.encodeWithSelector(X402Vault.VoucherInvalid.selector, "nonce used"));
        vault.settle(v, sig);
    }

    function test_settle_expired() public {
        X402Vault.Voucher memory v = _voucher(1 ether, 1);
        bytes memory sig = _sign(payerPk, v);
        vm.warp(v.expiry + 1);
        vm.expectRevert(abi.encodeWithSelector(X402Vault.VoucherInvalid.selector, "expired"));
        vault.settle(v, sig);
    }

    function test_settle_atExpiryBoundaryOk() public {
        X402Vault.Voucher memory v = _voucher(1 ether, 1);
        bytes memory sig = _sign(payerPk, v);
        vm.warp(v.expiry);
        vault.settle(v, sig);
        assertTrue(vault.used(payer, 1));
    }

    function test_settle_wrongSigner() public {
        X402Vault.Voucher memory v = _voucher(1 ether, 1);
        bytes memory sig = _sign(malloryPk, v);
        vm.expectRevert(abi.encodeWithSelector(X402Vault.VoucherInvalid.selector, "bad signature"));
        vault.settle(v, sig);
    }

    function test_settle_tamperedAmount() public {
        X402Vault.Voucher memory v = _voucher(1 ether, 1);
        bytes memory sig = _sign(payerPk, v);
        v.amount = 2 ether;
        vm.expectRevert(abi.encodeWithSelector(X402Vault.VoucherInvalid.selector, "bad signature"));
        vault.settle(v, sig);
    }

    function test_settle_insufficientBalance() public {
        X402Vault.Voucher memory v = _voucher(11 ether, 1);
        bytes memory sig = _sign(payerPk, v);
        vm.expectRevert(abi.encodeWithSelector(X402Vault.VoucherInvalid.selector, "insufficient balance"));
        vault.settle(v, sig);
    }

    function test_settle_zeroAmountAndZeroPayee() public {
        X402Vault.Voucher memory v = _voucher(0, 1);
        vm.expectRevert(abi.encodeWithSelector(X402Vault.VoucherInvalid.selector, "zero amount"));
        vault.settle(v, "");
        v = _voucher(1, 1);
        v.payee = address(0);
        vm.expectRevert(abi.encodeWithSelector(X402Vault.VoucherInvalid.selector, "zero payee"));
        vault.settle(v, "");
    }

    function test_settle_malformedSignatureLength() public {
        X402Vault.Voucher memory v = _voucher(1 ether, 1);
        vm.expectRevert(abi.encodeWithSelector(X402Vault.VoucherInvalid.selector, "bad signature"));
        vault.settle(v, hex"1234");
    }

    function test_settle_highSRejected() public {
        X402Vault.Voucher memory v = _voucher(1 ether, 1);
        (uint8 vv, bytes32 r, bytes32 s) = vm.sign(payerPk, vault.hashVoucher(v));
        // flip to the high-s form (still a mathematically valid signature) — must be rejected
        bytes32 hs = bytes32(0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141 - uint256(s));
        uint8 hv = vv == 27 ? 28 : 27;
        vm.expectRevert(abi.encodeWithSelector(X402Vault.VoucherInvalid.selector, "bad signature"));
        vault.settle(v, abi.encodePacked(r, hs, hv));
    }

    function test_settle_domainBoundToContract() public {
        X402Vault other = new X402Vault(gov, treasury);
        X402Vault.Voucher memory v = _voucher(1 ether, 1);
        (uint8 vv, bytes32 r, bytes32 s) = vm.sign(payerPk, other.hashVoucher(v));
        vm.expectRevert(abi.encodeWithSelector(X402Vault.VoucherInvalid.selector, "bad signature"));
        vault.settle(v, abi.encodePacked(r, s, vv));
    }

    function test_settle_duringUnlockStillWorks() public {
        vm.prank(payer);
        vault.requestUnlock();
        X402Vault.Voucher memory v = _voucher(1 ether, 1);
        vault.settle(v, _sign(payerPk, v));
        assertEq(vault.balance(payer), 9 ether);
    }

    function test_settle_zeroFee() public {
        vm.prank(gov);
        vault.setFee(0);
        X402Vault.Voucher memory v = _voucher(1 ether, 1);
        vault.settle(v, _sign(payerPk, v));
        assertEq(vault.credits(payee), 1 ether);
        assertEq(vault.credits(treasury), 0);
    }

    // ───────────────────────────── ERC-1271 (AgentAccount pays) ─────────────────────────────

    function test_settle_erc1271_agentAccountSessionKey() public {
        AgentAccountFactory f = new AgentAccountFactory();
        address owner = makeAddr("owner");
        (address key, uint256 keyPk) = makeAddrAndKey("session");
        address acct = f.create(owner, bytes32(0));
        vm.prank(owner);
        address[] memory none;
        AgentAccount(payable(acct)).addSession(key, 1 ether, uint64(block.timestamp + 1 days), none);
        vm.deal(acct, 5 ether);
        vm.prank(acct);
        vault.deposit{value: 3 ether}();

        X402Vault.Voucher memory v = _voucher(1 ether, 1);
        v.payer = acct;
        (uint8 vv, bytes32 r, bytes32 s) = vm.sign(keyPk, vault.hashVoucher(v));
        (bool ok, string memory reason) = vault.verify(v, abi.encodePacked(r, s, vv));
        assertTrue(ok, reason);
        vault.settle(v, abi.encodePacked(r, s, vv));
        assertEq(vault.balance(acct), 2 ether);
        assertEq(vault.credits(payee), 1 ether - _fee(1 ether));

        // revoked key → 1271 says no
        vm.prank(owner);
        AgentAccount(payable(acct)).revokeSession(key);
        v.nonce = 2;
        (vv, r, s) = vm.sign(keyPk, vault.hashVoucher(v));
        vm.expectRevert(abi.encodeWithSelector(X402Vault.VoucherInvalid.selector, "bad signature"));
        vault.settle(v, abi.encodePacked(r, s, vv));
    }

    function test_settle_contractPayerWithout1271Rejected() public {
        Rejecter rj = new Rejecter();
        vm.prank(payer);
        vault.depositFor{value: 1 ether}(address(rj));
        X402Vault.Voucher memory v = _voucher(1, 1);
        v.payer = address(rj);
        bytes memory sig = _sign(payerPk, v);
        vm.expectRevert(abi.encodeWithSelector(X402Vault.VoucherInvalid.selector, "bad signature"));
        vault.settle(v, sig);
    }

    // ───────────────────────────── settleBatch ─────────────────────────────

    function test_settleBatch_skipsInvalidAndSettlesRest() public {
        X402Vault.Voucher[] memory vs = new X402Vault.Voucher[](4);
        bytes[] memory sigs = new bytes[](4);
        vs[0] = _voucher(1 ether, 1);
        sigs[0] = _sign(payerPk, vs[0]);
        vs[1] = _voucher(1 ether, 1); // replay of nonce 1
        sigs[1] = _sign(payerPk, vs[1]);
        vs[2] = _voucher(1 ether, 2);
        sigs[2] = _sign(malloryPk, vs[2]); // bad signer
        vs[3] = _voucher(2 ether, 3);
        sigs[3] = _sign(payerPk, vs[3]);

        vm.expectEmit(true, true, true, true);
        emit X402Vault.Settled(payer, payee, 1 ether, _fee(1 ether), 1, keccak256("resource"));
        vm.expectEmit(true, true, true, true);
        emit X402Vault.Skipped(payer, 1, "nonce used");
        vm.expectEmit(true, true, true, true);
        emit X402Vault.Skipped(payer, 2, "bad signature");
        vm.expectEmit(true, true, true, true);
        emit X402Vault.Settled(payer, payee, 2 ether, _fee(2 ether), 3, keccak256("resource"));
        vault.settleBatch(vs, sigs);

        assertEq(vault.balance(payer), 7 ether);
        assertTrue(vault.used(payer, 1));
        assertFalse(vault.used(payer, 2));
        assertTrue(vault.used(payer, 3));
        assertEq(vault.credits(payee), 3 ether - _fee(1 ether) - _fee(2 ether));
    }

    function test_settleBatch_payerRunsDryMidBatch() public {
        X402Vault.Voucher[] memory vs = new X402Vault.Voucher[](2);
        bytes[] memory sigs = new bytes[](2);
        vs[0] = _voucher(8 ether, 1);
        sigs[0] = _sign(payerPk, vs[0]);
        vs[1] = _voucher(3 ether, 2);
        sigs[1] = _sign(payerPk, vs[1]);
        vm.expectEmit(true, true, true, true);
        emit X402Vault.Skipped(payer, 2, "insufficient balance");
        vault.settleBatch(vs, sigs);
        assertEq(vault.balance(payer), 2 ether);
        assertFalse(vault.used(payer, 2));
    }

    function test_settleBatch_lengthMismatch() public {
        X402Vault.Voucher[] memory vs = new X402Vault.Voucher[](1);
        bytes[] memory sigs = new bytes[](2);
        vm.expectRevert(X402Vault.LengthMismatch.selector);
        vault.settleBatch(vs, sigs);
    }

    function test_settleBatch_empty() public {
        X402Vault.Voucher[] memory vs;
        bytes[] memory sigs;
        vault.settleBatch(vs, sigs);
    }

    // ───────────────────────────── verify ─────────────────────────────

    function test_verify_reasons() public {
        X402Vault.Voucher memory v = _voucher(1 ether, 1);
        bytes memory sig = _sign(payerPk, v);
        (bool ok, string memory reason) = vault.verify(v, sig);
        assertTrue(ok);
        assertEq(reason, "");
        vault.settle(v, sig);
        (ok, reason) = vault.verify(v, sig);
        assertFalse(ok);
        assertEq(reason, "nonce used");
        v.payer = address(0);
        (ok, reason) = vault.verify(v, sig);
        assertEq(reason, "zero payer");
    }

    // ───────────────────────────── unlock / withdraw ─────────────────────────────

    function test_withdraw_requiresUnlock() public {
        vm.prank(payer);
        vm.expectRevert(X402Vault.Locked.selector);
        vault.withdraw(1 ether);
    }

    function test_withdraw_tooEarly() public {
        vm.prank(payer);
        vault.requestUnlock();
        uint64 at = uint64(block.timestamp + 1 hours);
        assertEq(vault.unlockAt(payer), at);
        vm.warp(at - 1);
        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(X402Vault.TooEarly.selector, at));
        vault.withdraw(1 ether);
    }

    function test_withdraw_afterUnlock_relocks() public {
        vm.prank(payer);
        vm.expectEmit(true, true, true, true);
        emit X402Vault.UnlockRequested(payer, uint64(block.timestamp + 1 hours));
        vault.requestUnlock();
        vm.warp(block.timestamp + 1 hours);
        uint256 before = payer.balance;
        vm.prank(payer);
        vm.expectEmit(true, true, true, true);
        emit X402Vault.Withdrawn(payer, 4 ether);
        vault.withdraw(4 ether);
        assertEq(payer.balance, before + 4 ether);
        assertEq(vault.balance(payer), 6 ether);
        assertEq(vault.unlockAt(payer), 0);
        vm.prank(payer);
        vm.expectRevert(X402Vault.Locked.selector);
        vault.withdraw(1 ether);
    }

    function test_withdraw_exceedsBalance() public {
        vm.prank(payer);
        vault.requestUnlock();
        vm.warp(block.timestamp + 1 hours);
        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(X402Vault.InsufficientBalance.selector, 11 ether, 10 ether));
        vault.withdraw(11 ether);
        vm.prank(payer);
        vm.expectRevert(X402Vault.ZeroValue.selector);
        vault.withdraw(0);
    }

    function test_withdraw_toRejecterRevertsAndRollsBack() public {
        Rejecter rj = new Rejecter();
        vm.prank(payer);
        vault.depositFor{value: 1 ether}(address(rj));
        vm.prank(address(rj));
        vault.requestUnlock();
        vm.warp(block.timestamp + 1 hours);
        vm.prank(address(rj));
        vm.expectRevert(X402Vault.TransferFailed.selector);
        vault.withdraw(1 ether);
        assertEq(vault.balance(address(rj)), 1 ether);
    }

    function test_withdrawCredits() public {
        X402Vault.Voucher memory v = _voucher(1 ether, 1);
        vault.settle(v, _sign(payerPk, v));
        uint256 net = 1 ether - _fee(1 ether);
        vm.prank(payee);
        vm.expectEmit(true, true, true, true);
        emit X402Vault.CreditsWithdrawn(payee, net);
        vault.withdrawCredits();
        assertEq(payee.balance, net);
        assertEq(vault.credits(payee), 0);
        vm.prank(payee);
        vm.expectRevert(X402Vault.NothingToWithdraw.selector);
        vault.withdrawCredits();
        vm.prank(treasury);
        vault.withdrawCredits();
        assertEq(treasury.balance, _fee(1 ether));
        assertEq(address(vault).balance, 9 ether);
    }

    function test_withdrawCredits_reentrancyBlocked() public {
        ReenterVault re = new ReenterVault(vault);
        X402Vault.Voucher memory v = _voucher(1 ether, 1);
        v.payee = address(re);
        vault.settle(v, _sign(payerPk, v));
        re.pull();
        assertEq(re.attempts(), 1);
        assertFalse(re.reentered());
        assertEq(vault.credits(address(re)), 0);
    }

    // ───────────────────────────── governance ─────────────────────────────

    function test_governance_setters() public {
        vm.startPrank(gov);
        vault.setFee(250);
        assertEq(vault.feeBps(), 250);
        vm.expectRevert(X402Vault.FeeTooHigh.selector);
        vault.setFee(1001);
        vault.setFeeRecipient(mallory);
        assertEq(vault.feeRecipient(), mallory);
        vm.expectRevert(X402Vault.ZeroAddress.selector);
        vault.setFeeRecipient(address(0));
        vm.expectRevert(X402Vault.ZeroAddress.selector);
        vault.setGovernance(address(0));
        vault.setGovernance(mallory);
        vm.stopPrank();
        assertEq(vault.governance(), mallory);
        vm.prank(gov);
        vm.expectRevert(X402Vault.NotGovernance.selector);
        vault.setFee(1);
    }

    function test_governance_onlyGovernance() public {
        vm.prank(payer);
        vm.expectRevert(X402Vault.NotGovernance.selector);
        vault.setFee(1);
        vm.prank(payer);
        vm.expectRevert(X402Vault.NotGovernance.selector);
        vault.setFeeRecipient(payer);
        vm.prank(payer);
        vm.expectRevert(X402Vault.NotGovernance.selector);
        vault.setGovernance(payer);
    }

    // ───────────────────────────── fuzz: value conservation ─────────────────────────────

    function testFuzz_settle_conservesValue(uint96 amount, uint16 fee) public {
        amount = uint96(bound(amount, 1, 10 ether));
        fee = uint16(bound(fee, 0, 1000));
        vm.prank(gov);
        vault.setFee(fee);
        X402Vault.Voucher memory v = _voucher(amount, 42);
        vault.settle(v, _sign(payerPk, v));
        assertEq(vault.balance(payer) + vault.credits(payee) + vault.credits(treasury), 10 ether);
    }
}

contract ReenterVault {
    X402Vault public vault;
    uint256 public attempts;
    bool public reentered;

    constructor(X402Vault v) {
        vault = v;
    }

    function pull() external {
        vault.withdrawCredits();
    }

    receive() external payable {
        attempts++;
        if (attempts == 1) {
            try vault.withdrawCredits() {
                reentered = true;
            } catch {}
        }
    }
}
