// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AgentAccount} from "../src/AgentAccount.sol";
import {AgentAccountFactory} from "../src/AgentAccountFactory.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";
import {ServiceEscrow} from "../src/ServiceEscrow.sol";

contract Target {
    uint256 public last;
    address public lastSender;
    uint256 public received;

    function ping(uint256 x) external payable returns (uint256) {
        last = x;
        lastSender = msg.sender;
        received += msg.value;
        return x * 2;
    }

    function boom() external pure {
        revert("boom");
    }

    receive() external payable {
        received += msg.value;
    }
}

/// @dev Minimal ERC-1271 wallet standing in for a multisig owner.
contract Wallet1271 {
    address public signer;

    constructor(address s) {
        signer = s;
    }

    function isValidSignature(bytes32 hash, bytes calldata sig) external view returns (bytes4) {
        (bytes32 r, bytes32 s, uint8 v) = abi.decode(sig, (bytes32, bytes32, uint8));
        return ecrecover(hash, v, r, s) == signer ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }
}

contract AgentAccountTest is Test {
    AgentAccountFactory internal factory;
    AgentAccount internal acct;
    Target internal target;

    address internal owner;
    uint256 internal ownerPk;
    address internal key;
    uint256 internal keyPk;
    address internal stranger;
    uint256 internal strangerPk;
    address internal relayer = makeAddr("relayer");

    function setUp() public {
        (owner, ownerPk) = makeAddrAndKey("owner");
        (key, keyPk) = makeAddrAndKey("key");
        (stranger, strangerPk) = makeAddrAndKey("stranger");
        vm.warp(1_700_000_000);
        factory = new AgentAccountFactory();
        acct = AgentAccount(payable(factory.create(owner, bytes32("a"))));
        target = new Target();
        vm.deal(address(acct), 10 ether);
    }

    function _addKey(uint256 cap, address[] memory targets) internal {
        vm.prank(owner);
        acct.addSession(key, cap, uint64(block.timestamp + 7 days), targets);
    }

    function _none() internal pure returns (address[] memory a) {}

    function _sigFor(uint256 pk, address to, uint256 value, bytes memory data, uint64 deadline)
        internal
        view
        returns (bytes memory)
    {
        bytes32 digest = acct.hashExecute(to, value, keccak256(data), acct.nonce(), deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    // ───────────────────────────── factory ─────────────────────────────

    function test_factory_createAndPredict() public {
        address predicted = factory.predict(owner, bytes32("b"));
        vm.expectEmit(true, true, true, true);
        emit AgentAccountFactory.AccountCreated(owner, predicted);
        address created = factory.create(owner, bytes32("b"));
        assertEq(created, predicted);
        assertEq(AgentAccount(payable(created)).owner(), owner);
        assertEq(factory.accountCount(owner), 2);
        assertTrue(factory.isAccount(created));
        assertFalse(factory.isAccount(address(target)));
        // EIP-1167 runtime: 45 bytes pointing at the implementation
        assertEq(created.code.length, 45);
        assertEq(
            created.code,
            abi.encodePacked(
                hex"363d3d373d3d3d363d73", address(factory.implementation()), hex"5af43d82803e903d91602b57fd5bf3"
            )
        );
    }

    function test_factory_sameSaltTwiceReverts() public {
        vm.expectRevert(AgentAccountFactory.CreateFailed.selector);
        factory.create(owner, bytes32("a"));
    }

    function test_factory_saltIsPerOwner() public {
        address a = factory.create(stranger, bytes32("a")); // same salt, different owner → different address
        assertTrue(a != address(acct));
        assertEq(AgentAccount(payable(a)).owner(), stranger);
    }

    function test_factory_zeroOwnerReverts() public {
        vm.expectRevert(AgentAccountFactory.ZeroAddress.selector);
        factory.create(address(0), bytes32(0));
    }

    function test_implementationIsBricked() public {
        AgentAccount impl = factory.implementation();
        assertEq(impl.owner(), address(1));
        vm.expectRevert(AgentAccount.AlreadyInitialized.selector);
        impl.initialize(owner);
    }

    function test_initialize_onlyOnce() public {
        vm.expectRevert(AgentAccount.AlreadyInitialized.selector);
        acct.initialize(stranger);
    }

    function test_receive() public {
        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        vm.expectEmit(true, true, true, true);
        emit AgentAccount.Received(stranger, 1 ether);
        (bool ok,) = address(acct).call{value: 1 ether}("");
        assertTrue(ok);
        assertEq(address(acct).balance, 11 ether);
    }

    // ───────────────────────────── owner execute ─────────────────────────────

    function test_execute_owner() public {
        vm.prank(owner);
        vm.expectEmit(true, true, true, true);
        emit AgentAccount.Executed(owner, address(target), 1 ether, true);
        bytes memory ret = acct.execute(address(target), 1 ether, abi.encodeCall(Target.ping, (21)));
        assertEq(abi.decode(ret, (uint256)), 42);
        assertEq(target.last(), 21);
        assertEq(target.lastSender(), address(acct));
        assertEq(target.received(), 1 ether);
        assertEq(address(acct).balance, 9 ether);
    }

    function test_execute_plainTransfer() public {
        vm.prank(owner);
        acct.execute(stranger, 2 ether, "");
        assertEq(stranger.balance, 2 ether);
    }

    function test_execute_strangerReverts() public {
        vm.prank(stranger);
        vm.expectRevert(AgentAccount.NotAuthorized.selector);
        acct.execute(address(target), 0, "");
    }

    function test_execute_bubblesRevert() public {
        vm.prank(owner);
        vm.expectRevert(bytes("boom"));
        acct.execute(address(target), 0, abi.encodeCall(Target.boom, ()));
    }

    function test_execute_emptyRevertData() public {
        vm.prank(owner);
        vm.expectRevert(AgentAccount.CallFailed.selector);
        acct.execute(address(target), 100 ether, ""); // insufficient balance → empty revert
    }

    function test_executeBatch_owner() public {
        address[] memory to = new address[](2);
        uint256[] memory value = new uint256[](2);
        bytes[] memory data = new bytes[](2);
        to[0] = address(target);
        to[1] = stranger;
        value[0] = 1 ether;
        value[1] = 1 ether;
        data[0] = abi.encodeCall(Target.ping, (5));
        vm.prank(owner);
        acct.executeBatch(to, value, data);
        assertEq(target.last(), 5);
        assertEq(stranger.balance, 1 ether);
    }

    function test_executeBatch_lengthMismatch() public {
        address[] memory to = new address[](2);
        uint256[] memory value = new uint256[](1);
        bytes[] memory data = new bytes[](2);
        vm.prank(owner);
        vm.expectRevert(AgentAccount.LengthMismatch.selector);
        acct.executeBatch(to, value, data);
    }

    // ───────────────────────────── sessions ─────────────────────────────

    function test_addSession_ownerOnlyAndValidation() public {
        vm.prank(stranger);
        vm.expectRevert(AgentAccount.NotOwner.selector);
        acct.addSession(key, 1, uint64(block.timestamp + 1), _none());
        vm.prank(owner);
        vm.expectRevert(AgentAccount.ZeroAddress.selector);
        acct.addSession(address(0), 1, uint64(block.timestamp + 1), _none());
        vm.prank(owner);
        vm.expectRevert(AgentAccount.SessionExpired.selector);
        acct.addSession(key, 1, uint64(block.timestamp), _none());
    }

    function test_addSession_anyTargetWhenEmpty() public {
        vm.prank(owner);
        vm.expectEmit(true, true, true, true);
        emit AgentAccount.SessionAdded(key, 1 ether, uint64(block.timestamp + 7 days));
        acct.addSession(key, 1 ether, uint64(block.timestamp + 7 days), _none());
        (uint256 cap, uint256 spent, uint64 dayStart, uint64 expiry, bool anyTarget) = acct.sessions(key);
        assertEq(cap, 1 ether);
        assertEq(spent, 0);
        assertEq(dayStart, uint64(block.timestamp));
        assertEq(expiry, uint64(block.timestamp + 7 days));
        assertTrue(anyTarget);
        assertTrue(acct.isSigner(key));
        assertTrue(acct.isSigner(owner));
        assertFalse(acct.isSigner(stranger));
    }

    function test_session_executeWithinCap() public {
        _addKey(1 ether, _none());
        vm.prank(key);
        acct.execute(address(target), 0.6 ether, abi.encodeCall(Target.ping, (1)));
        vm.prank(key);
        acct.execute(address(target), 0.4 ether, "");
        (, uint256 spent,,,) = acct.sessions(key);
        assertEq(spent, 1 ether);
        vm.prank(key);
        vm.expectRevert(abi.encodeWithSelector(AgentAccount.CapExceeded.selector, 1, 0));
        acct.execute(address(target), 1, "");
    }

    function test_session_capResetsAfterADay() public {
        _addKey(1 ether, _none());
        vm.prank(key);
        acct.execute(address(target), 1 ether, "");
        vm.warp(block.timestamp + 1 days - 1);
        vm.prank(key);
        vm.expectRevert(abi.encodeWithSelector(AgentAccount.CapExceeded.selector, 1 ether, 0));
        acct.execute(address(target), 1 ether, "");
        vm.warp(block.timestamp + 1);
        vm.prank(key);
        acct.execute(address(target), 1 ether, "");
        (, uint256 spent, uint64 dayStart,,) = acct.sessions(key);
        assertEq(spent, 1 ether);
        assertEq(dayStart, uint64(block.timestamp));
    }

    function test_session_zeroValueCallsIgnoreCap() public {
        _addKey(0, _none());
        vm.prank(key);
        acct.execute(address(target), 0, abi.encodeCall(Target.ping, (9)));
        assertEq(target.last(), 9);
        vm.prank(key);
        vm.expectRevert(abi.encodeWithSelector(AgentAccount.CapExceeded.selector, 1, 0));
        acct.execute(address(target), 1, "");
    }

    function test_session_targetAllowlist() public {
        address[] memory ts = new address[](1);
        ts[0] = address(target);
        _addKey(1 ether, ts);
        assertTrue(acct.allowedTarget(key, address(target)));
        assertEq(acct.sessionTargets(key).length, 1);
        vm.prank(key);
        acct.execute(address(target), 0.1 ether, "");
        vm.prank(key);
        vm.expectRevert(abi.encodeWithSelector(AgentAccount.TargetNotAllowed.selector, stranger));
        acct.execute(stranger, 0.1 ether, "");
    }

    function test_session_reAddClearsOldTargets() public {
        address[] memory ts = new address[](1);
        ts[0] = address(target);
        _addKey(1 ether, ts);
        address[] memory ts2 = new address[](1);
        ts2[0] = stranger;
        _addKey(1 ether, ts2);
        assertFalse(acct.allowedTarget(key, address(target)));
        assertTrue(acct.allowedTarget(key, stranger));
        vm.prank(key);
        vm.expectRevert(abi.encodeWithSelector(AgentAccount.TargetNotAllowed.selector, address(target)));
        acct.execute(address(target), 0, "");
    }

    function test_session_expiry() public {
        _addKey(1 ether, _none());
        vm.warp(block.timestamp + 7 days);
        assertFalse(acct.isSigner(key));
        vm.prank(key);
        vm.expectRevert(AgentAccount.NotAuthorized.selector);
        acct.execute(address(target), 0, "");
    }

    function test_revokeSession() public {
        address[] memory ts = new address[](1);
        ts[0] = address(target);
        _addKey(1 ether, ts);
        vm.prank(stranger);
        vm.expectRevert(AgentAccount.NotOwner.selector);
        acct.revokeSession(key);
        vm.prank(owner);
        vm.expectEmit(true, true, true, true);
        emit AgentAccount.SessionRevoked(key);
        acct.revokeSession(key);
        (,,, uint64 expiry,) = acct.sessions(key);
        assertEq(expiry, 0);
        assertFalse(acct.allowedTarget(key, address(target)));
        assertEq(acct.sessionTargets(key).length, 0);
        vm.prank(key);
        vm.expectRevert(AgentAccount.NotAuthorized.selector);
        acct.execute(address(target), 0, "");
    }

    function test_session_batchCountsCapPerItem() public {
        _addKey(1 ether, _none());
        address[] memory to = new address[](2);
        uint256[] memory value = new uint256[](2);
        bytes[] memory data = new bytes[](2);
        to[0] = address(target);
        to[1] = address(target);
        value[0] = 0.7 ether;
        value[1] = 0.7 ether;
        vm.prank(key);
        vm.expectRevert(abi.encodeWithSelector(AgentAccount.CapExceeded.selector, 0.7 ether, 0.3 ether));
        acct.executeBatch(to, value, data);
    }

    // ───────────────────────────── executeWithSig ─────────────────────────────

    function test_executeWithSig_ownerSigned() public {
        bytes memory data = abi.encodeCall(Target.ping, (3));
        uint64 deadline = uint64(block.timestamp + 60);
        bytes memory sig = _sigFor(ownerPk, address(target), 1 ether, data, deadline);
        vm.prank(relayer);
        vm.expectEmit(true, true, true, true);
        emit AgentAccount.Executed(owner, address(target), 1 ether, true);
        bytes memory ret = acct.executeWithSig(address(target), 1 ether, data, deadline, sig);
        assertEq(abi.decode(ret, (uint256)), 6);
        assertEq(acct.nonce(), 1);
        assertEq(target.received(), 1 ether);
    }

    function test_executeWithSig_sessionKeyPolicyApplies() public {
        address[] memory ts = new address[](1);
        ts[0] = address(target);
        _addKey(1 ether, ts);
        uint64 deadline = uint64(block.timestamp + 60);
        bytes memory sig = _sigFor(keyPk, address(target), 0.5 ether, "", deadline);
        vm.prank(relayer);
        acct.executeWithSig(address(target), 0.5 ether, "", deadline, sig);
        (, uint256 spent,,,) = acct.sessions(key);
        assertEq(spent, 0.5 ether);
        // over cap
        sig = _sigFor(keyPk, address(target), 0.6 ether, "", deadline);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(AgentAccount.CapExceeded.selector, 0.6 ether, 0.5 ether));
        acct.executeWithSig(address(target), 0.6 ether, "", deadline, sig);
        // disallowed target
        sig = _sigFor(keyPk, stranger, 0.1 ether, "", deadline);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(AgentAccount.TargetNotAllowed.selector, stranger));
        acct.executeWithSig(stranger, 0.1 ether, "", deadline, sig);
    }

    function test_executeWithSig_replayRejected() public {
        uint64 deadline = uint64(block.timestamp + 60);
        bytes memory sig = _sigFor(ownerPk, address(target), 0, "", deadline);
        acct.executeWithSig(address(target), 0, "", deadline, sig);
        vm.expectRevert(AgentAccount.BadSignature.selector);
        acct.executeWithSig(address(target), 0, "", deadline, sig);
    }

    function test_executeWithSig_deadline() public {
        uint64 deadline = uint64(block.timestamp + 60);
        bytes memory sig = _sigFor(ownerPk, address(target), 0, "", deadline);
        vm.warp(deadline + 1);
        vm.expectRevert(abi.encodeWithSelector(AgentAccount.Expired.selector, deadline));
        acct.executeWithSig(address(target), 0, "", deadline, sig);
    }

    function test_executeWithSig_strangerAndTamper() public {
        uint64 deadline = uint64(block.timestamp + 60);
        bytes memory sig = _sigFor(strangerPk, address(target), 0, "", deadline);
        vm.expectRevert(AgentAccount.BadSignature.selector);
        acct.executeWithSig(address(target), 0, "", deadline, sig);
        sig = _sigFor(ownerPk, address(target), 0, "", deadline);
        vm.expectRevert(AgentAccount.BadSignature.selector);
        acct.executeWithSig(address(target), 1, "", deadline, sig); // value tampered
        vm.expectRevert(AgentAccount.BadSignature.selector);
        acct.executeWithSig(address(target), 0, hex"01", deadline, sig); // data tampered
    }

    function test_executeWithSig_expiredSessionKey() public {
        _addKey(1 ether, _none());
        uint64 deadline = uint64(block.timestamp + 8 days);
        bytes memory sig = _sigFor(keyPk, address(target), 0, "", deadline);
        vm.warp(block.timestamp + 7 days);
        vm.expectRevert(AgentAccount.BadSignature.selector);
        acct.executeWithSig(address(target), 0, "", deadline, sig);
    }

    function test_executeWithSig_domainIsPerClone() public {
        AgentAccount other = AgentAccount(payable(factory.create(owner, bytes32("z"))));
        vm.deal(address(other), 1 ether);
        uint64 deadline = uint64(block.timestamp + 60);
        bytes32 digest = other.hashExecute(address(target), 0, keccak256(""), 0, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerPk, digest);
        bytes memory sig = abi.encodePacked(r, s, v);
        vm.expectRevert(AgentAccount.BadSignature.selector);
        acct.executeWithSig(address(target), 0, "", deadline, sig);
        other.executeWithSig(address(target), 0, "", deadline, sig);
        assertEq(other.nonce(), 1);
    }

    function test_executeWithSig_failedCallKeepsNonce() public {
        uint64 deadline = uint64(block.timestamp + 60);
        bytes memory data = abi.encodeCall(Target.boom, ());
        bytes memory sig = _sigFor(ownerPk, address(target), 0, data, deadline);
        vm.expectRevert(bytes("boom"));
        acct.executeWithSig(address(target), 0, data, deadline, sig);
        assertEq(acct.nonce(), 0);
    }

    function test_executeWithSig_contractOwner1271() public {
        (address ms, uint256 msPk) = makeAddrAndKey("multisig-signer");
        Wallet1271 wallet = new Wallet1271(ms);
        AgentAccount a = AgentAccount(payable(factory.create(address(wallet), bytes32("w"))));
        vm.deal(address(a), 1 ether);
        uint64 deadline = uint64(block.timestamp + 60);
        bytes32 digest = a.hashExecute(address(target), 0.5 ether, keccak256(""), 0, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(msPk, digest);
        bytes memory sig = abi.encode(r, s, v); // wallet's own encoding (not 65-byte packed)
        vm.prank(relayer);
        a.executeWithSig(address(target), 0.5 ether, "", deadline, sig);
        assertEq(target.received(), 0.5 ether);
        assertEq(a.isValidSignature(digest, sig), bytes4(0x1626ba7e));
    }

    // ───────────────────────────── ERC-1271 ─────────────────────────────

    function test_isValidSignature() public {
        _addKey(1 ether, _none());
        bytes32 h = keccak256("hello");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerPk, h);
        assertEq(acct.isValidSignature(h, abi.encodePacked(r, s, v)), bytes4(0x1626ba7e));
        (v, r, s) = vm.sign(keyPk, h);
        bytes memory keySig = abi.encodePacked(r, s, v);
        assertEq(acct.isValidSignature(h, keySig), bytes4(0x1626ba7e));
        (v, r, s) = vm.sign(strangerPk, h);
        assertEq(acct.isValidSignature(h, abi.encodePacked(r, s, v)), bytes4(0xffffffff));
        assertEq(acct.isValidSignature(h, hex"00"), bytes4(0xffffffff));
        vm.warp(block.timestamp + 7 days);
        assertEq(acct.isValidSignature(h, keySig), bytes4(0xffffffff));
    }

    // ───────────────────────────── ownership ─────────────────────────────

    function test_transferOwnership() public {
        vm.prank(stranger);
        vm.expectRevert(AgentAccount.NotOwner.selector);
        acct.transferOwnership(stranger);
        vm.prank(owner);
        vm.expectRevert(AgentAccount.ZeroAddress.selector);
        acct.transferOwnership(address(0));
        vm.prank(owner);
        vm.expectEmit(true, true, true, true);
        emit AgentAccount.OwnershipTransferred(owner, stranger);
        acct.transferOwnership(stranger);
        assertEq(acct.owner(), stranger);
        vm.prank(owner);
        vm.expectRevert(AgentAccount.NotAuthorized.selector);
        acct.execute(address(target), 0, "");
    }

    // ───────────────────────────── reentrancy ─────────────────────────────

    function test_execute_reentrancyBlocked() public {
        Reenterer re = new Reenterer(acct);
        vm.prank(owner);
        vm.expectRevert(AgentAccount.Reentrancy.selector);
        acct.execute(address(re), 0, abi.encodeCall(Reenterer.go, ()));
    }

    // ───────────────────────────── integration: account as agent owner ─────────────────────────────

    function test_integration_accountRegistersAgentAndGetsPaid() public {
        AgentRegistry registry = new AgentRegistry(owner, 100 ether);
        ServiceEscrow escrow = new ServiceEscrow(registry, owner, makeAddr("treasury"));
        vm.prank(owner);
        registry.setEscrow(address(escrow));
        vm.deal(address(acct), 200 ether);

        address[] memory ts = new address[](2);
        ts[0] = address(registry);
        ts[1] = address(escrow);
        _addKey(150 ether, ts);

        vm.prank(key);
        bytes memory ret = acct.execute(
            address(registry), 100 ether, abi.encodeCall(AgentRegistry.register, ("Bot", "https://bot", "", 1 ether))
        );
        uint256 id = abi.decode(ret, (uint256));
        assertEq(registry.getAgent(id).owner, address(acct));

        vm.deal(stranger, 5 ether);
        vm.prank(stranger);
        uint256 jobId = escrow.requestJob{value: 1 ether}(id, keccak256("in"), "");
        vm.prank(key);
        acct.execute(address(escrow), 0, abi.encodeCall(ServiceEscrow.deliver, (jobId, keccak256("out"), "")));
        vm.prank(stranger);
        escrow.release(jobId, 5);
        vm.prank(key);
        acct.execute(address(escrow), 0, abi.encodeCall(ServiceEscrow.withdraw, ()));
        assertEq(address(acct).balance, 100 ether + 0.975 ether);
    }
}

contract Reenterer {
    AgentAccount public acct;

    constructor(AgentAccount a) {
        acct = a;
    }

    function go() external {
        acct.execute(address(this), 0, "");
    }
}
