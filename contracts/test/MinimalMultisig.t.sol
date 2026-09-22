// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MinimalMultisig} from "../src/MinimalMultisig.sol";
import {AZNT} from "../src/AZNT.sol";
import {TokenFactory} from "../src/TokenFactory.sol";

/// @dev Target whose function always reverts — exercises "MSIG: call failed".
contract RevertingTarget {
    bool public armed = true;

    function disarm() external {
        armed = false;
    }

    function poke() external view {
        require(!armed, "TARGET: boom");
    }
}

contract MinimalMultisigTest is Test {
    MinimalMultisig internal msig;

    address internal owner1 = makeAddr("owner1");
    address internal owner2 = makeAddr("owner2");
    address internal owner3 = makeAddr("owner3");
    address internal outsider = makeAddr("outsider");
    address internal payee = makeAddr("payee");

    event Deposit(address indexed sender, uint256 value);
    event Submitted(uint256 indexed txId, address indexed proposer, address to, uint256 value, bytes data);
    event Confirmed(uint256 indexed txId, address indexed owner);
    event Revoked(uint256 indexed txId, address indexed owner);
    event Executed(uint256 indexed txId, address indexed executor);

    function setUp() public {
        msig = new MinimalMultisig(_owners(), 2);
        vm.deal(address(msig), 10 ether);
    }

    function _owners() internal view returns (address[] memory owners) {
        owners = new address[](3);
        owners[0] = owner1;
        owners[1] = owner2;
        owners[2] = owner3;
    }

    function _submitPayment(uint256 value) internal returns (uint256 txId) {
        vm.prank(owner1);
        txId = msig.submit(payee, value, "");
    }

    // ---------------------------------------------------------- constructor

    function test_Constructor_SetsOwnersAndThreshold() public view {
        assertEq(msig.threshold(), 2);
        assertEq(msig.ownerCount(), 3);
        assertTrue(msig.isOwner(owner1));
        assertTrue(msig.isOwner(owner2));
        assertTrue(msig.isOwner(owner3));
        assertFalse(msig.isOwner(outsider));
        address[] memory owners = msig.getOwners();
        assertEq(owners.length, 3);
        assertEq(owners[0], owner1);
        assertEq(msig.owners(2), owner3);
        assertEq(msig.transactionCount(), 0);
    }

    function test_Constructor_RevertsOnNoOwners() public {
        vm.expectRevert(bytes("MSIG: no owners"));
        new MinimalMultisig(new address[](0), 1);
    }

    function test_Constructor_RevertsOnZeroThreshold() public {
        vm.expectRevert(bytes("MSIG: bad threshold"));
        new MinimalMultisig(_owners(), 0);
    }

    function test_Constructor_RevertsOnThresholdAboveOwnerCount() public {
        vm.expectRevert(bytes("MSIG: bad threshold"));
        new MinimalMultisig(_owners(), 4);
    }

    function test_Constructor_RevertsOnZeroOwner() public {
        address[] memory owners = _owners();
        owners[1] = address(0);
        vm.expectRevert(bytes("MSIG: zero owner"));
        new MinimalMultisig(owners, 2);
    }

    function test_Constructor_RevertsOnDuplicateOwner() public {
        address[] memory owners = _owners();
        owners[2] = owner1;
        vm.expectRevert(bytes("MSIG: duplicate owner"));
        new MinimalMultisig(owners, 2);
    }

    function testFuzz_Constructor_ThresholdBounds(uint256 threshold) public {
        if (threshold >= 1 && threshold <= 3) {
            MinimalMultisig m = new MinimalMultisig(_owners(), threshold);
            assertEq(m.threshold(), threshold);
        } else {
            vm.expectRevert(bytes("MSIG: bad threshold"));
            new MinimalMultisig(_owners(), threshold);
        }
    }

    // -------------------------------------------------------------- receive

    function test_Receive_AcceptsFMX_EmitsDeposit() public {
        vm.deal(outsider, 3 ether);
        vm.expectEmit(true, false, false, true);
        emit Deposit(outsider, 3 ether);
        vm.prank(outsider);
        (bool ok,) = address(msig).call{value: 3 ether}("");
        assertTrue(ok);
        assertEq(address(msig).balance, 13 ether);
    }

    function testFuzz_Receive(uint96 value) public {
        vm.deal(outsider, value);
        vm.prank(outsider);
        (bool ok,) = address(msig).call{value: value}("");
        assertTrue(ok);
        assertEq(address(msig).balance, 10 ether + uint256(value));
    }

    // ---------------------------------------------------------------- submit

    function test_Submit_OnlyOwner() public {
        vm.prank(outsider);
        vm.expectRevert(bytes("MSIG: not owner"));
        msig.submit(payee, 1 ether, "");
    }

    function test_Submit_RevertsOnZeroTarget() public {
        vm.prank(owner1);
        vm.expectRevert(bytes("MSIG: zero target"));
        msig.submit(address(0), 1 ether, "");
    }

    function test_Submit_StoresTx_AutoConfirms_Emits() public {
        bytes memory data = abi.encodeWithSignature("foo(uint256)", 42);

        vm.expectEmit(true, true, false, true);
        emit Submitted(0, owner1, payee, 1 ether, data);
        vm.expectEmit(true, true, false, false);
        emit Confirmed(0, owner1);

        vm.prank(owner1);
        uint256 txId = msig.submit(payee, 1 ether, data);
        assertEq(txId, 0);
        assertEq(msig.transactionCount(), 1);

        (address to, uint256 value, bytes memory storedData, bool executed, uint256 confs) = msig.getTransaction(0);
        assertEq(to, payee);
        assertEq(value, 1 ether);
        assertEq(storedData, data);
        assertFalse(executed);
        assertEq(confs, 1); // proposer auto-confirmed
        assertTrue(msig.confirmedBy(0, owner1));
    }

    function test_Submit_TxIdsIncrement() public {
        vm.startPrank(owner1);
        assertEq(msig.submit(payee, 1, ""), 0);
        assertEq(msig.submit(payee, 2, ""), 1);
        assertEq(msig.submit(payee, 3, ""), 2);
        vm.stopPrank();
        assertEq(msig.transactionCount(), 3);
    }

    // --------------------------------------------------------------- confirm

    function test_Confirm_OnlyOwner() public {
        _submitPayment(1 ether);
        vm.prank(outsider);
        vm.expectRevert(bytes("MSIG: not owner"));
        msig.confirm(0);
    }

    function test_Confirm_RevertsOnUnknownTx() public {
        vm.prank(owner1);
        vm.expectRevert(bytes("MSIG: no such tx"));
        msig.confirm(0);
    }

    function test_Confirm_RevertsOnDoubleConfirm() public {
        _submitPayment(1 ether);
        vm.prank(owner1); // already auto-confirmed at submit
        vm.expectRevert(bytes("MSIG: already confirmed"));
        msig.confirm(0);
    }

    function test_Confirm_RevertsAfterExecution() public {
        uint256 txId = _submitPayment(1 ether);
        vm.prank(owner2);
        msig.confirm(txId);
        vm.prank(owner1);
        msig.execute(txId);
        vm.prank(owner3);
        vm.expectRevert(bytes("MSIG: already executed"));
        msig.confirm(txId);
    }

    function test_Confirm_CountsAndEmits() public {
        uint256 txId = _submitPayment(1 ether);
        vm.expectEmit(true, true, false, false);
        emit Confirmed(txId, owner2);
        vm.prank(owner2);
        msig.confirm(txId);
        (,,,, uint256 confs) = msig.getTransaction(txId);
        assertEq(confs, 2);
        assertTrue(msig.confirmedBy(txId, owner2));
    }

    // ---------------------------------------------------------------- revoke

    function test_Revoke_OnlyOwner() public {
        _submitPayment(1 ether);
        vm.prank(outsider);
        vm.expectRevert(bytes("MSIG: not owner"));
        msig.revoke(0);
    }

    function test_Revoke_RevertsIfNotConfirmed() public {
        _submitPayment(1 ether);
        vm.prank(owner2);
        vm.expectRevert(bytes("MSIG: not confirmed"));
        msig.revoke(0);
    }

    function test_Revoke_RevertsAfterExecution() public {
        uint256 txId = _submitPayment(1 ether);
        vm.prank(owner2);
        msig.confirm(txId);
        vm.prank(owner1);
        msig.execute(txId);
        vm.prank(owner2);
        vm.expectRevert(bytes("MSIG: already executed"));
        msig.revoke(txId);
    }

    function test_Revoke_RemovesConfirmation_BlocksExecution() public {
        uint256 txId = _submitPayment(1 ether);
        vm.prank(owner2);
        msig.confirm(txId); // 2 confirmations, executable

        vm.expectEmit(true, true, false, false);
        emit Revoked(txId, owner2);
        vm.prank(owner2);
        msig.revoke(txId); // back to 1

        (,,,, uint256 confs) = msig.getTransaction(txId);
        assertEq(confs, 1);
        assertFalse(msig.confirmedBy(txId, owner2));

        vm.prank(owner1);
        vm.expectRevert(bytes("MSIG: below threshold"));
        msig.execute(txId);
    }

    function test_Revoke_ThenReconfirm() public {
        uint256 txId = _submitPayment(1 ether);
        vm.startPrank(owner2);
        msig.confirm(txId);
        msig.revoke(txId);
        msig.confirm(txId); // re-confirm allowed after revoke
        vm.stopPrank();
        (,,,, uint256 confs) = msig.getTransaction(txId);
        assertEq(confs, 2);
    }

    // --------------------------------------------------------------- execute

    function test_Execute_OnlyOwner() public {
        uint256 txId = _submitPayment(1 ether);
        vm.prank(owner2);
        msig.confirm(txId);
        vm.prank(outsider);
        vm.expectRevert(bytes("MSIG: not owner"));
        msig.execute(txId);
    }

    function test_Execute_RevertsOnUnknownTx() public {
        vm.prank(owner1);
        vm.expectRevert(bytes("MSIG: no such tx"));
        msig.execute(7);
    }

    function test_Execute_RevertsBelowThreshold() public {
        uint256 txId = _submitPayment(1 ether); // only proposer's confirmation
        vm.prank(owner1);
        vm.expectRevert(bytes("MSIG: below threshold"));
        msig.execute(txId);
    }

    function test_Execute_TransfersValue_MarksExecuted_Emits() public {
        uint256 txId = _submitPayment(4 ether);
        vm.prank(owner2);
        msig.confirm(txId);

        vm.expectEmit(true, true, false, false);
        emit Executed(txId, owner3);
        vm.prank(owner3); // any owner may execute, not only a confirmer
        msig.execute(txId);

        assertEq(payee.balance, 4 ether);
        assertEq(address(msig).balance, 6 ether);
        (,,, bool executed,) = msig.getTransaction(txId);
        assertTrue(executed);
    }

    function test_Execute_RevertsOnSecondExecution() public {
        uint256 txId = _submitPayment(1 ether);
        vm.prank(owner2);
        msig.confirm(txId);
        vm.startPrank(owner1);
        msig.execute(txId);
        vm.expectRevert(bytes("MSIG: already executed"));
        msig.execute(txId);
        vm.stopPrank();
    }

    function test_Execute_WorksWithAllThreeConfirmations() public {
        uint256 txId = _submitPayment(1 ether);
        vm.prank(owner2);
        msig.confirm(txId);
        vm.prank(owner3);
        msig.confirm(txId);
        vm.prank(owner1);
        msig.execute(txId);
        assertEq(payee.balance, 1 ether);
    }

    function test_Execute_FailedCallReverts_TxStaysPendingAndRetryable() public {
        RevertingTarget target = new RevertingTarget();
        vm.prank(owner1);
        uint256 txId = msig.submit(address(target), 0, abi.encodeWithSignature("poke()"));
        vm.prank(owner2);
        msig.confirm(txId);

        vm.prank(owner1);
        vm.expectRevert(bytes("MSIG: call failed"));
        msig.execute(txId);

        // state fully rolled back: still pending
        (,,, bool executed, uint256 confs) = msig.getTransaction(txId);
        assertFalse(executed);
        assertEq(confs, 2);

        // once the target stops reverting, the same tx executes fine
        target.disarm();
        vm.prank(owner1);
        msig.execute(txId);
        (,,, executed,) = msig.getTransaction(txId);
        assertTrue(executed);
    }

    function test_Execute_RevertsWhenValueExceedsBalance() public {
        uint256 txId = _submitPayment(100 ether); // msig only holds 10
        vm.prank(owner2);
        msig.confirm(txId);
        vm.prank(owner1);
        vm.expectRevert(bytes("MSIG: call failed"));
        msig.execute(txId);
    }

    function test_GetTransaction_RevertsOnUnknownTx() public {
        vm.expectRevert(bytes("MSIG: no such tx"));
        msig.getTransaction(0);
    }

    // -------------------------------------------------------- threshold edges

    function test_OneOfOne_SubmitAloneIsExecutable() public {
        address[] memory solo = new address[](1);
        solo[0] = owner1;
        MinimalMultisig m = new MinimalMultisig(solo, 1);
        vm.deal(address(m), 1 ether);
        vm.startPrank(owner1);
        uint256 txId = m.submit(payee, 1 ether, "");
        m.execute(txId); // auto-confirm satisfied 1-of-1
        vm.stopPrank();
        assertEq(payee.balance, 1 ether);
    }

    function test_NOfN_RequiresEveryOwner() public {
        MinimalMultisig m = new MinimalMultisig(_owners(), 3);
        vm.deal(address(m), 1 ether);
        vm.prank(owner1);
        uint256 txId = m.submit(payee, 1 ether, "");
        vm.prank(owner2);
        m.confirm(txId);
        vm.prank(owner1);
        vm.expectRevert(bytes("MSIG: below threshold"));
        m.execute(txId);
        vm.prank(owner3);
        m.confirm(txId);
        vm.prank(owner1);
        m.execute(txId);
        assertEq(payee.balance, 1 ether);
    }

    function testFuzz_SubmitConfirmExecute_Value(uint96 rawValue) public {
        uint256 value = bound(uint256(rawValue), 0, 10 ether);
        uint256 txId = _submitPayment(value);
        vm.prank(owner2);
        msig.confirm(txId);
        vm.prank(owner1);
        msig.execute(txId);
        assertEq(payee.balance, value);
    }

    // =====================================================================
    //            Integration: multisig as AZNT admin / factory collector
    // =====================================================================

    function test_Integration_MultisigGrantsAZNTRole() public {
        AZNT aznt = new AZNT(address(msig));
        address minter = makeAddr("minter");
        bytes memory data = abi.encodeWithSignature("grantRole(bytes32,address)", aznt.MINTER(), minter);

        vm.prank(owner1);
        uint256 txId = msig.submit(address(aznt), 0, data);
        vm.prank(owner2);
        msig.confirm(txId);
        vm.prank(owner1);
        msig.execute(txId);

        assertTrue(aznt.hasRole(aznt.MINTER(), minter));
        vm.prank(minter);
        aznt.mint(minter, 123);
        assertEq(aznt.balanceOf(minter), 123);
    }

    function test_Integration_MultisigCollectsAndSetsFactoryFee() public {
        TokenFactory factory = new TokenFactory(address(msig));

        // launch fee lands in the multisig
        address creator = makeAddr("creator");
        vm.deal(creator, 10 ether);
        vm.prank(creator);
        factory.launch{value: 10 ether}("Coin", "COIN", 18, 1e18, 0, false);
        assertEq(address(msig).balance, 20 ether); // 10 seeded + 10 fee

        // multisig lowers the fee via governance
        vm.prank(owner1);
        uint256 txId = msig.submit(address(factory), 0, abi.encodeWithSignature("setFee(uint256)", 1 ether));
        vm.prank(owner3);
        msig.confirm(txId);
        vm.prank(owner2);
        msig.execute(txId);
        assertEq(factory.launchFee(), 1 ether);
    }

    function test_Integration_MultisigAcceptsAZNTAdminHandover() public {
        // AZNT deployed with an EOA admin, then handed to the multisig two-step
        address eoaAdmin = makeAddr("eoaAdmin");
        AZNT aznt = new AZNT(eoaAdmin);
        vm.prank(eoaAdmin);
        aznt.transferAdmin(address(msig));

        vm.prank(owner1);
        uint256 txId = msig.submit(address(aznt), 0, abi.encodeWithSignature("acceptAdmin()"));
        vm.prank(owner2);
        msig.confirm(txId);
        vm.prank(owner1);
        msig.execute(txId);

        assertEq(aznt.admin(), address(msig));
    }
}
