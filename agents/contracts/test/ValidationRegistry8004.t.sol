// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseTest} from "./Base.t.sol";
import {IdentityRegistry8004} from "../src/erc8004/IdentityRegistry8004.sol";
import {ValidationRegistry8004} from "../src/erc8004/ValidationRegistry8004.sol";

contract ValidationRegistry8004Test is BaseTest {
    IdentityRegistry8004 internal id8004;
    ValidationRegistry8004 internal val;
    uint256 internal agentId;
    address internal oracle = makeAddr("oracle");
    bytes32 internal constant REQ = keccak256("request-1");

    function setUp() public override {
        super.setUp();
        id8004 = new IdentityRegistry8004(registry);
        val = new ValidationRegistry8004(id8004);
        agentId = _registerAlice();
    }

    function _request(bytes32 h) internal {
        vm.prank(alice);
        val.validationRequest(oracle, agentId, "fmx://payload/0xreq", h);
    }

    function _respond(bytes32 h, uint8 score, string memory tag) internal {
        vm.prank(oracle);
        val.validationResponse(h, score, "fmx://payload/0xres", keccak256("res"), tag);
    }

    function test_deployState() public view {
        assertEq(val.getIdentityRegistry(), address(id8004));
        assertEq(val.getVersion(), "ferminux-2.0.0");
    }

    function test_constructor_revertsZero() public {
        vm.expectRevert(ValidationRegistry8004.ZeroAddress.selector);
        new ValidationRegistry8004(IdentityRegistry8004(address(0)));
    }

    function test_request_byOwner() public {
        vm.prank(alice);
        vm.expectEmit(true, true, true, true);
        emit ValidationRegistry8004.ValidationRequest(oracle, agentId, "fmx://payload/0xreq", REQ);
        val.validationRequest(oracle, agentId, "fmx://payload/0xreq", REQ);
        (address v, uint256 a, uint8 r, bytes32 rh, string memory tag, uint256 lu) = val.getValidationStatus(REQ);
        assertEq(v, oracle);
        assertEq(a, agentId);
        assertEq(r, 0);
        assertEq(rh, bytes32(0));
        assertEq(tag, "");
        assertEq(lu, block.timestamp);
        assertFalse(val.hasResponse(REQ));
        assertEq(val.getAgentValidations(agentId).length, 1);
        assertEq(val.getAgentValidations(agentId)[0], REQ);
        assertEq(val.getValidatorRequests(oracle)[0], REQ);
    }

    function test_request_validation() public {
        vm.prank(alice);
        vm.expectRevert(ValidationRegistry8004.ZeroAddress.selector);
        val.validationRequest(address(0), agentId, "", REQ);
        vm.prank(bob);
        vm.expectRevert(ValidationRegistry8004.NotAuthorized.selector);
        val.validationRequest(oracle, agentId, "", REQ);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IdentityRegistry8004.NonexistentAgent.selector, 5));
        val.validationRequest(oracle, 5, "", REQ);
        _request(REQ);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ValidationRegistry8004.RequestExists.selector, REQ));
        val.validationRequest(oracle, agentId, "", REQ);
    }

    function test_request_byNamedValidator() public {
        // not named yet → the validator cannot open a request itself
        vm.prank(oracle);
        vm.expectRevert(ValidationRegistry8004.NotAuthorized.selector);
        val.validationRequest(oracle, agentId, "", REQ);
        vm.prank(alice);
        id8004.setMetadata(agentId, "validator", abi.encodePacked(oracle));
        vm.prank(oracle);
        val.validationRequest(oracle, agentId, "", REQ);
        assertEq(val.getValidatorRequests(oracle).length, 1);
        // a different validator naming itself in the call still fails
        vm.prank(bob);
        vm.expectRevert(ValidationRegistry8004.NotAuthorized.selector);
        val.validationRequest(bob, agentId, "", keccak256("other"));
        // the named validator may not open requests for OTHER validators
        vm.prank(oracle);
        vm.expectRevert(ValidationRegistry8004.NotAuthorized.selector);
        val.validationRequest(bob, agentId, "", keccak256("other"));
    }

    function test_response_onlyValidator() public {
        _request(REQ);
        vm.prank(alice);
        vm.expectRevert(ValidationRegistry8004.NotValidator.selector);
        val.validationResponse(REQ, 90, "", bytes32(0), "");
        vm.prank(oracle);
        vm.expectRevert(abi.encodeWithSelector(ValidationRegistry8004.UnknownRequest.selector, keccak256("nope")));
        val.validationResponse(keccak256("nope"), 90, "", bytes32(0), "");
        vm.prank(oracle);
        vm.expectRevert(ValidationRegistry8004.ResponseOutOfRange.selector);
        val.validationResponse(REQ, 101, "", bytes32(0), "");
    }

    function test_response_happyAndUpdatable() public {
        _request(REQ);
        vm.warp(block.timestamp + 10);
        vm.prank(oracle);
        vm.expectEmit(true, true, true, true);
        emit ValidationRegistry8004.ValidationResponse(
            oracle, agentId, REQ, 88, "fmx://payload/0xres", keccak256("res"), "job:1"
        );
        val.validationResponse(REQ, 88, "fmx://payload/0xres", keccak256("res"), "job:1");
        (,, uint8 r, bytes32 rh, string memory tag, uint256 lu) = val.getValidationStatus(REQ);
        assertEq(r, 88);
        assertEq(rh, keccak256("res"));
        assertEq(tag, "job:1");
        assertEq(lu, block.timestamp);
        assertTrue(val.hasResponse(REQ));
        _respond(REQ, 100, "job:1");
        (,, r,,,) = val.getValidationStatus(REQ);
        assertEq(r, 100);
        assertEq(val.getAgentValidations(agentId).length, 1);
    }

    function test_getValidationStatus_unknown() public {
        vm.expectRevert(abi.encodeWithSelector(ValidationRegistry8004.UnknownRequest.selector, REQ));
        val.getValidationStatus(REQ);
    }

    function test_getSummary_filters() public {
        bytes32 h1 = keccak256("1");
        bytes32 h2 = keccak256("2");
        bytes32 h3 = keccak256("3");
        _request(h1);
        _request(h2);
        _request(h3);
        address other = makeAddr("other-validator");
        vm.prank(alice);
        val.validationRequest(other, agentId, "", keccak256("4"));
        _respond(h1, 80, "a");
        _respond(h2, 100, "b");
        vm.prank(other);
        val.validationResponse(keccak256("4"), 20, "", bytes32(0), "a");
        // h3 unanswered → excluded
        address[] memory none;
        (uint64 count, uint8 avg) = val.getSummary(agentId, none, "");
        assertEq(count, 3);
        assertEq(avg, 66); // floor(200 / 3)
        address[] memory onlyOracle = new address[](1);
        onlyOracle[0] = oracle;
        (count, avg) = val.getSummary(agentId, onlyOracle, "");
        assertEq(count, 2);
        assertEq(avg, 90);
        (count, avg) = val.getSummary(agentId, none, "a");
        assertEq(count, 2);
        assertEq(avg, 50);
        (count, avg) = val.getSummary(agentId, onlyOracle, "b");
        assertEq(count, 1);
        assertEq(avg, 100);
        (count, avg) = val.getSummary(agentId, onlyOracle, "zzz");
        assertEq(count, 0);
        assertEq(avg, 0);
        (count, avg) = val.getSummary(99, none, "");
        assertEq(count, 0);
    }
}
