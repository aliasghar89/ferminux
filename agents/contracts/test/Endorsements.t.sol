// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";
import {ServiceEscrow} from "../src/ServiceEscrow.sol";
import {AgentAccount} from "../src/AgentAccount.sol";
import {AgentAccountFactory} from "../src/AgentAccountFactory.sol";
import {Endorsements} from "../src/Endorsements.sol";
import {IAccountFactoryLike} from "../src/lib/IAccount.sol";

contract EndorsementsTest is Test {
    AgentRegistry internal registry;
    ServiceEscrow internal escrow;
    AgentAccountFactory internal factory;
    Endorsements internal endorsements;

    address internal gov = makeAddr("governance");
    address internal treasury = makeAddr("treasury");
    address internal relayer = makeAddr("relayer");
    address internal stranger = makeAddr("stranger");
    address internal dave = makeAddr("dave"); // arm's-length client

    address internal alice; // owner of agent A (the endorser)
    uint256 internal alicePk;
    address internal bob; // owner of agent B (the endorsee)
    uint256 internal bobPk;
    address internal carol; // owner of agent C
    uint256 internal carolPk;

    uint256 internal A;
    uint256 internal B;
    uint256 internal C;

    uint256 internal constant MIN_BOND = 100 ether;
    uint256 internal constant PRICE = 1 ether;

    function setUp() public {
        (alice, alicePk) = makeAddrAndKey("alice");
        (bob, bobPk) = makeAddrAndKey("bob");
        (carol, carolPk) = makeAddrAndKey("carol");

        registry = new AgentRegistry(address(this), MIN_BOND);
        escrow = new ServiceEscrow(registry, address(this), treasury);
        registry.setEscrow(address(escrow));
        factory = new AgentAccountFactory();
        endorsements = new Endorsements(registry, escrow, IAccountFactoryLike(address(factory)), gov);

        vm.deal(alice, 10_000 ether);
        vm.deal(bob, 10_000 ether);
        vm.deal(carol, 10_000 ether);
        vm.deal(dave, 10_000 ether);
        vm.deal(stranger, 10_000 ether);
        vm.deal(makeAddr("stranger2"), 10_000 ether);
        vm.warp(1_700_000_000);

        A = _register(alice, "Toolbox");
        B = _register(bob, "Oracle");
        C = _register(carol, "Wizrd");
    }

    // ───────────────────────────── fixtures ─────────────────────────────

    function _register(address owner, string memory name) internal returns (uint256 id) {
        vm.prank(owner);
        id = registry.register{value: MIN_BOND}(name, "https://agent.example", "", PRICE);
    }

    /// @dev A completed escrow job for `agentId`, paid by `client`, rated `rating` (0 = unrated).
    function _completedJob(uint256 agentId, address owner, address client, uint256 amount, uint8 rating)
        internal
        returns (uint256 jobId)
    {
        vm.prank(client);
        jobId = escrow.requestJob{value: amount}(agentId, keccak256("in"), "");
        vm.prank(owner);
        escrow.deliver(jobId, keccak256("out"), "");
        vm.prank(client);
        escrow.release(jobId, rating);
    }

    function _openJob(uint256 agentId, address client, uint256 amount) internal returns (uint256 jobId) {
        vm.prank(client);
        jobId = escrow.requestJob{value: amount}(agentId, keccak256("in"), "");
    }

    function _sign(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    // ───────────────────────────── deploy ─────────────────────────────

    function test_deployState() public view {
        assertEq(address(endorsements.registry()), address(registry));
        assertEq(address(endorsements.escrow()), address(escrow));
        assertEq(address(endorsements.accountFactory()), address(factory));
        assertEq(endorsements.governance(), gov);
        assertEq(endorsements.minPaidWei(), 1 ether);
        assertEq(endorsements.weightCap(), 1000);
        assertEq(endorsements.maxUriBytes(), 256);
        assertEq(endorsements.nextId(), 0);
        assertEq(endorsements.NAME(), "FerminuxEndorsements");
        assertEq(
            endorsements.ENDORSE_TYPEHASH(),
            keccak256(
                "Endorse(uint256 fromAgentId,uint256 toAgentId,string capability,string uri,uint256 evidenceJobId,uint256 nonce,uint64 deadline)"
            )
        );
        assertEq(
            endorsements.REVOKE_TYPEHASH(), keccak256("Revoke(uint256 endorsementId,uint256 nonce,uint64 deadline)")
        );
    }

    function test_constructor_revertsZero() public {
        IAccountFactoryLike f = IAccountFactoryLike(address(factory));
        vm.expectRevert(Endorsements.ZeroAddress.selector);
        new Endorsements(AgentRegistry(address(0)), escrow, f, gov);
        vm.expectRevert(Endorsements.ZeroAddress.selector);
        new Endorsements(registry, ServiceEscrow(address(0)), f, gov);
        vm.expectRevert(Endorsements.ZeroAddress.selector);
        new Endorsements(registry, escrow, f, address(0));
    }

    // ───────────────────────────── unbacked endorsements ─────────────────────────────

    function test_endorse_unbackedCarriesNoWeight() public {
        vm.prank(alice);
        uint256 id = endorsements.endorse(A, B, "hash", "", 0);
        assertEq(id, 1);

        Endorsements.Endorsement memory e = endorsements.getEndorsement(id);
        assertEq(e.fromAgentId, A);
        assertEq(e.toAgentId, B);
        assertEq(e.weight, 0);
        assertEq(uint8(e.basis), uint8(Endorsements.Basis.Unbacked));
        assertEq(e.evidenceJobId, 0);
        assertEq(e.evidenceAmountWei, 0);
        assertEq(e.endorser, alice);
        assertEq(e.capability, "hash");
        assertEq(e.capabilityId, keccak256("hash"));
        assertFalse(e.revoked);

        Endorsements.Summary memory s = endorsements.summary(B);
        assertEq(s.total, 1);
        assertEq(s.backed, 0);
        assertEq(s.unbacked, 1);
        assertEq(s.weight, 0);
    }

    // ───────────────────────────── backed endorsements ─────────────────────────────

    function test_endorse_backedByArmsLengthPaidJob() public {
        uint256 jobId = _completedJob(A, alice, dave, 5 ether, 5);
        vm.prank(alice);
        vm.expectEmit(true, true, true, true);
        emit Endorsements.Endorsed(
            1, A, B, keccak256("hash"), "hash", Endorsements.Basis.PaidWork, 25, uint64(jobId), 5 ether, "fmx://note"
        );
        uint256 id = endorsements.endorse(A, B, "hash", "fmx://note", jobId);

        Endorsements.Endorsement memory e = endorsements.getEndorsement(id);
        assertEq(uint8(e.basis), uint8(Endorsements.Basis.PaidWork));
        assertEq(e.weight, 25, "5 FMX proven x average rating 5");
        assertEq(e.evidenceJobId, jobId);
        assertEq(e.evidenceAmountWei, 5 ether);

        Endorsements.Summary memory s = endorsements.summary(B);
        assertEq(s.total, 1);
        assertEq(s.backed, 1);
        assertEq(s.unbacked, 0);
        assertEq(s.weight, 25);
    }

    function test_endorse_weightUsesRatingPriorWhenUnrated() public {
        uint256 jobId = _completedJob(A, alice, dave, 4 ether, 0); // released without a rating
        (uint32 w, Endorsements.Basis basis,) = endorsements.quoteWeight(A, B, jobId);
        assertEq(uint8(basis), uint8(Endorsements.Basis.PaidWork));
        assertEq(w, 4 * 3, "unrated endorser falls back to the neutral prior, not to zero");
        assertEq(endorsements.RATING_PRIOR(), 3);
    }

    function test_endorse_weightTracksRating() public {
        // two rated jobs averaging 2 (2 and 3 -> 2 after integer division)
        _completedJob(A, alice, dave, 1 ether, 2);
        _completedJob(A, alice, dave, 1 ether, 3);
        uint256 jobId = _completedJob(A, alice, dave, 10 ether, 0);
        (uint32 w,,) = endorsements.quoteWeight(A, B, jobId);
        assertEq(w, 10 * 2);
    }

    function test_endorse_weightIsCapped() public {
        uint256 jobId = _completedJob(A, alice, dave, 900 ether, 5); // 900 * 5 = 4500, capped
        (uint32 w,,) = endorsements.quoteWeight(A, B, jobId);
        assertEq(w, endorsements.weightCap());
        vm.prank(alice);
        endorsements.endorse(A, B, "hash", "", jobId);
        assertEq(endorsements.summary(B).weight, 1000);
    }

    function test_summary_distinguishesBackedFromUnbacked() public {
        // the headline requirement: a reader can always tell weightless endorsements apart
        uint256 jobId = _completedJob(A, alice, dave, 3 ether, 5);
        vm.prank(alice);
        endorsements.endorse(A, B, "hash", "", jobId); // backed, weight 15
        vm.prank(carol);
        endorsements.endorse(C, B, "hash", "", 0); // unbacked, weight 0

        Endorsements.Summary memory s = endorsements.summary(B);
        assertEq(s.total, 2);
        assertEq(s.backed, 1);
        assertEq(s.unbacked, 1);
        assertEq(s.weight, 15, "an agent with no paid work adds nothing to the number");

        Endorsements.Summary memory cs = endorsements.capabilitySummary(B, "hash");
        assertEq(cs.total, 2);
        assertEq(cs.backed, 1);
        assertEq(cs.unbacked, 1);
        assertEq(cs.weight, 15);
        assertEq(endorsements.capabilitySummary(B, "encode").total, 0);
    }

    // ───────────────────────────── evidence rules ─────────────────────────────

    function test_evidence_revertsWhenJobNotCompleted() public {
        uint256 open = _openJob(A, dave, 5 ether);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(Endorsements.EvidenceNotCompleted.selector, ServiceEscrow.JobStatus.Open)
        );
        endorsements.endorse(A, B, "hash", "", open);

        vm.prank(alice);
        escrow.deliver(open, keccak256("out"), "");
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(Endorsements.EvidenceNotCompleted.selector, ServiceEscrow.JobStatus.Delivered)
        );
        endorsements.endorse(A, B, "hash", "", open);
    }

    function test_evidence_revertsWhenJobIsSomeoneElsesWork() public {
        uint256 jobId = _completedJob(C, carol, dave, 5 ether, 5); // agent C's job
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Endorsements.EvidenceNotOwnWork.selector, C));
        endorsements.endorse(A, B, "hash", "", jobId);
    }

    function test_evidence_revertsWhenTooSmall() public {
        vm.prank(alice);
        registry.update(A, "https://agent.example", "", 0); // free jobs are allowed; they prove nothing
        uint256 jobId = _completedJob(A, alice, dave, 0.5 ether, 5);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Endorsements.EvidenceTooSmall.selector, 0.5 ether, 1 ether));
        endorsements.endorse(A, B, "hash", "", jobId);
    }

    function test_evidence_revertsWhenClientIsTheEndorserItself() public {
        // alice registers a second agent and hires it from a second address she controls? no —
        // here the client is an AgentAccount alice owns, which is the same party as alice.
        AgentAccount acct = AgentAccount(payable(factory.create(alice, bytes32("client"))));
        vm.deal(address(acct), 100 ether);
        // the account hires agent C (a genuinely different agent), then C tries to use it as evidence
        vm.prank(alice);
        bytes memory ret =
            acct.execute(address(escrow), 5 ether, abi.encodeCall(ServiceEscrow.requestJob, (C, keccak256("in"), "")));
        uint256 jobId = abi.decode(ret, (uint256));
        vm.prank(carol);
        escrow.deliver(jobId, keccak256("out"), "");
        vm.prank(alice);
        acct.execute(address(escrow), 0, abi.encodeCall(ServiceEscrow.release, (jobId, 5)));

        // carol's agent C endorsing alice's agent A, citing a job alice's own wallet paid for:
        // the payer is related to the ENDORSEE, so it proves nothing about arm's-length demand.
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(Endorsements.EvidenceNotArmsLength.selector, address(acct)));
        endorsements.endorse(C, A, "hash", "", jobId);
    }

    function test_evidence_revertsWhenClientIsTheEndorsersOwnAccount() public {
        // alice's AgentAccount pays alice's own agent A — a closed loop, worth no weight
        AgentAccount acct = AgentAccount(payable(factory.create(alice, bytes32("wash"))));
        vm.deal(address(acct), 100 ether);
        vm.prank(alice);
        bytes memory ret =
            acct.execute(address(escrow), 5 ether, abi.encodeCall(ServiceEscrow.requestJob, (A, keccak256("in"), "")));
        uint256 jobId = abi.decode(ret, (uint256));
        vm.prank(alice);
        escrow.deliver(jobId, keccak256("out"), "");
        vm.prank(alice);
        acct.execute(address(escrow), 0, abi.encodeCall(ServiceEscrow.release, (jobId, 5)));

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Endorsements.EvidenceNotArmsLength.selector, address(acct)));
        endorsements.endorse(A, B, "hash", "", jobId);
    }

    function test_evidence_revertsWhenClientIsTheEndorseeOwner() public {
        // bob pays alice's agent, then alice endorses bob's agent citing that job — circular
        uint256 jobId = _completedJob(A, alice, bob, 5 ether, 5);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Endorsements.EvidenceNotArmsLength.selector, bob));
        endorsements.endorse(A, B, "hash", "", jobId);
        // the same job DOES back an endorsement of an unrelated third agent
        vm.prank(alice);
        endorsements.endorse(A, C, "hash", "", jobId);
        assertEq(endorsements.summary(C).backed, 1);
    }

    function test_evidence_unknownJobReverts() public {
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(Endorsements.EvidenceNotCompleted.selector, ServiceEscrow.JobStatus.None)
        );
        endorsements.endorse(A, B, "hash", "", 9999);
    }

    // ───────────────────────────── self-endorsement ─────────────────────────────

    function test_endorse_revertsSameAgent() public {
        vm.prank(alice);
        vm.expectRevert(Endorsements.SelfEndorsement.selector);
        endorsements.endorse(A, A, "hash", "", 0);
    }

    function test_endorse_revertsSameOwnerTwoAgents() public {
        uint256 A2 = _register(alice, "Toolbox II");
        vm.prank(alice);
        vm.expectRevert(Endorsements.SelfEndorsement.selector);
        endorsements.endorse(A, A2, "hash", "", 0);
    }

    function test_endorse_revertsWhenEndorseeIsOwnedByTheEndorsersAccount() public {
        AgentAccount acct = AgentAccount(payable(factory.create(alice, bytes32("own"))));
        uint256 D = _register(stranger, "Puppet");
        vm.prank(stranger);
        registry.transferOwnership(D, address(acct)); // D is now owned by an account alice controls
        assertTrue(endorsements.isRelated(alice, address(acct)));
        vm.prank(alice);
        vm.expectRevert(Endorsements.SelfEndorsement.selector);
        endorsements.endorse(A, D, "hash", "", 0);
        // and the other direction: the account's agent endorsing alice's agent
        vm.prank(alice);
        vm.expectRevert(Endorsements.SelfEndorsement.selector); // AgentAccount bubbles the target's revert data
        acct.execute(address(endorsements), 0, abi.encodeCall(Endorsements.endorse, (D, A, "hash", "", 0)));
    }

    function test_endorse_revertsWhenBothAgentsOwnedByAccountsOfOneOwner() public {
        AgentAccount a1 = AgentAccount(payable(factory.create(alice, bytes32("one"))));
        AgentAccount a2 = AgentAccount(payable(factory.create(alice, bytes32("two"))));
        uint256 D = _register(stranger, "P1");
        uint256 E = _register(makeAddr("stranger2"), "P2");
        vm.prank(stranger);
        registry.transferOwnership(D, address(a1));
        vm.prank(makeAddr("stranger2"));
        registry.transferOwnership(E, address(a2));
        assertTrue(endorsements.isRelated(address(a1), address(a2)));
        vm.prank(alice);
        vm.expectRevert(Endorsements.SelfEndorsement.selector); // bubbled by AgentAccount
        a1.execute(address(endorsements), 0, abi.encodeCall(Endorsements.endorse, (D, E, "hash", "", 0)));
    }

    function test_isRelated_rules() public {
        AgentAccount acct = AgentAccount(payable(factory.create(alice, bytes32("r"))));
        assertTrue(endorsements.isRelated(alice, alice));
        assertTrue(endorsements.isRelated(alice, address(acct)));
        assertTrue(endorsements.isRelated(address(acct), alice));
        assertFalse(endorsements.isRelated(alice, bob));
        assertFalse(endorsements.isRelated(address(acct), bob));
        assertFalse(endorsements.isRelated(alice, address(0)));
    }

    // ───────────────────────────── authority ─────────────────────────────

    function test_endorse_revertsNotAuthorized() public {
        vm.prank(stranger);
        vm.expectRevert(Endorsements.NotAuthorized.selector);
        endorsements.endorse(A, B, "hash", "", 0);
        // the endorsee's own owner cannot mint an endorsement for itself either
        vm.prank(bob);
        vm.expectRevert(Endorsements.NotAuthorized.selector);
        endorsements.endorse(A, B, "hash", "", 0);
    }

    function test_endorse_byAgentAccountOfTheOwner() public {
        AgentAccount acct = AgentAccount(payable(factory.create(alice, bytes32("act"))));
        assertTrue(endorsements.canActFor(A, address(acct)));
        vm.prank(alice);
        acct.execute(address(endorsements), 0, abi.encodeCall(Endorsements.endorse, (A, B, "hash", "", 0)));
        assertEq(endorsements.summary(B).total, 1);
        assertEq(endorsements.getEndorsement(1).endorser, alice, "the endorser of record is the agent owner");
    }

    function test_endorse_revertsUnknownAgent() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Endorsements.UnknownAgent.selector, uint256(777)));
        endorsements.endorse(777, B, "hash", "", 0);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Endorsements.UnknownAgent.selector, uint256(777)));
        endorsements.endorse(A, 777, "hash", "", 0);
    }

    // ───────────────────────────── one edge per capability ─────────────────────────────

    function test_endorse_revertsDuplicateEdge() public {
        vm.prank(alice);
        uint256 id = endorsements.endorse(A, B, "hash", "", 0);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Endorsements.AlreadyEndorsed.selector, id));
        endorsements.endorse(A, B, "hash", "", 0);
    }

    function test_endorse_differentCapabilitiesAreSeparateEdges() public {
        vm.prank(alice);
        endorsements.endorse(A, B, "hash", "", 0);
        vm.prank(alice);
        endorsements.endorse(A, B, "encode", "", 0);
        assertEq(endorsements.summary(B).total, 2);
        assertEq(endorsements.capabilitySummary(B, "hash").total, 1);
        assertEq(endorsements.capabilitySummary(B, "encode").total, 1);
    }

    function test_endorse_revertsBadCapability() public {
        vm.prank(alice);
        vm.expectRevert(Endorsements.InvalidCapability.selector);
        endorsements.endorse(A, B, "", "", 0);
        vm.prank(alice);
        vm.expectRevert(Endorsements.InvalidCapability.selector);
        endorsements.endorse(A, B, new string(65), "", 0);
    }

    function test_endorse_revertsLongUri() public {
        vm.prank(alice);
        vm.expectRevert(Endorsements.StringTooLong.selector);
        endorsements.endorse(A, B, "hash", new string(257), 0);
    }

    // ───────────────────────────── revocation ─────────────────────────────

    function test_revoke_removesWeightAndFreesTheEdge() public {
        uint256 jobId = _completedJob(A, alice, dave, 6 ether, 5);
        vm.prank(alice);
        uint256 id = endorsements.endorse(A, B, "hash", "", jobId);
        assertEq(endorsements.summary(B).weight, 30);
        assertEq(endorsements.edgeOf(A, B, keccak256("hash")), id);

        vm.prank(alice);
        vm.expectEmit(true, true, true, true);
        emit Endorsements.EndorsementRevoked(id, A, B, 30);
        endorsements.revoke(id);

        Endorsements.Summary memory s = endorsements.summary(B);
        assertEq(s.total, 0);
        assertEq(s.backed, 0);
        assertEq(s.unbacked, 0);
        assertEq(s.weight, 0);
        assertEq(s.revoked, 1);
        assertEq(endorsements.capabilitySummary(B, "hash").revoked, 1);
        assertEq(endorsements.edgeOf(A, B, keccak256("hash")), 0);

        // the record itself survives — revocation is an append, not an erasure
        Endorsements.Endorsement memory e = endorsements.getEndorsement(id);
        assertTrue(e.revoked);
        assertEq(e.weight, 30, "the historical weight is preserved on the record");
        assertEq(endorsements.receivedCount(B), 1);
    }

    function test_revoke_thenReEndorse() public {
        vm.prank(alice);
        uint256 id = endorsements.endorse(A, B, "hash", "", 0);
        vm.prank(alice);
        endorsements.revoke(id);
        vm.prank(alice);
        uint256 id2 = endorsements.endorse(A, B, "hash", "", 0);
        assertEq(id2, 2);
        assertEq(endorsements.summary(B).total, 1);
        assertEq(endorsements.summary(B).revoked, 1);
    }

    function test_revoke_revertsNotAuthorized() public {
        vm.prank(alice);
        uint256 id = endorsements.endorse(A, B, "hash", "", 0);
        vm.prank(bob);
        vm.expectRevert(Endorsements.NotAuthorized.selector);
        endorsements.revoke(id); // the endorsee cannot revoke an endorsement it received
        vm.prank(stranger);
        vm.expectRevert(Endorsements.NotAuthorized.selector);
        endorsements.revoke(id);
    }

    function test_revoke_revertsTwice() public {
        vm.prank(alice);
        uint256 id = endorsements.endorse(A, B, "hash", "", 0);
        vm.prank(alice);
        endorsements.revoke(id);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Endorsements.AlreadyRevoked.selector, id));
        endorsements.revoke(id);
    }

    function test_revoke_revertsUnknown() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Endorsements.UnknownEndorsement.selector, uint256(1)));
        endorsements.revoke(1);
        vm.expectRevert(abi.encodeWithSelector(Endorsements.UnknownEndorsement.selector, uint256(0)));
        endorsements.getEndorsement(0);
    }

    // ───────────────────────────── relayed (signed) writes ─────────────────────────────

    function test_endorseFor_signedByOwner() public {
        uint64 deadline = uint64(block.timestamp + 600);
        bytes32 digest = endorsements.hashEndorse(A, B, "hash", "fmx://u", 0, 0, deadline);
        bytes memory sig = _sign(alicePk, digest);
        assertEq(endorsements.nonces(A), 0);
        vm.prank(relayer);
        uint256 id = endorsements.endorseFor(A, B, "hash", "fmx://u", 0, deadline, sig);
        assertEq(id, 1);
        assertEq(endorsements.nonces(A), 1);
        assertEq(endorsements.getEndorsement(id).endorser, alice);
    }

    function test_endorseFor_replayReverts() public {
        uint64 deadline = uint64(block.timestamp + 600);
        bytes memory sig = _sign(alicePk, endorsements.hashEndorse(A, B, "hash", "", 0, 0, deadline));
        vm.prank(relayer);
        endorsements.endorseFor(A, B, "hash", "", 0, deadline, sig);
        vm.prank(relayer);
        vm.expectRevert(Endorsements.BadSignature.selector);
        endorsements.endorseFor(A, C, "hash", "", 0, deadline, sig);
    }

    function test_endorseFor_expiredReverts() public {
        uint64 deadline = uint64(block.timestamp + 10);
        bytes memory sig = _sign(alicePk, endorsements.hashEndorse(A, B, "hash", "", 0, 0, deadline));
        vm.warp(block.timestamp + 11);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(Endorsements.ExpiredSignature.selector, deadline));
        endorsements.endorseFor(A, B, "hash", "", 0, deadline, sig);
    }

    function test_endorseFor_wrongSignerReverts() public {
        uint64 deadline = uint64(block.timestamp + 600);
        bytes memory sig = _sign(bobPk, endorsements.hashEndorse(A, B, "hash", "", 0, 0, deadline));
        vm.prank(relayer);
        vm.expectRevert(Endorsements.BadSignature.selector);
        endorsements.endorseFor(A, B, "hash", "", 0, deadline, sig);
    }

    function test_endorseFor_tamperedCapabilityReverts() public {
        uint64 deadline = uint64(block.timestamp + 600);
        bytes memory sig = _sign(alicePk, endorsements.hashEndorse(A, B, "hash", "", 0, 0, deadline));
        vm.prank(relayer);
        vm.expectRevert(Endorsements.BadSignature.selector);
        endorsements.endorseFor(A, B, "encode", "", 0, deadline, sig);
    }

    function test_endorseFor_erc1271ContractOwner() public {
        AgentAccount acct = AgentAccount(payable(factory.create(alice, bytes32("1271"))));
        vm.prank(alice);
        registry.transferOwnership(A, address(acct));
        uint64 deadline = uint64(block.timestamp + 600);
        bytes memory sig = _sign(alicePk, endorsements.hashEndorse(A, B, "hash", "", 0, 0, deadline));
        vm.prank(relayer);
        uint256 id = endorsements.endorseFor(A, B, "hash", "", 0, deadline, sig);
        assertEq(endorsements.getEndorsement(id).endorser, address(acct));
    }

    function test_revokeFor_signed() public {
        vm.prank(alice);
        uint256 id = endorsements.endorse(A, B, "hash", "", 0);
        uint64 deadline = uint64(block.timestamp + 600);
        bytes memory sig = _sign(alicePk, endorsements.hashRevoke(id, 0, deadline));
        vm.prank(relayer);
        endorsements.revokeFor(id, deadline, sig);
        assertTrue(endorsements.getEndorsement(id).revoked);
        assertEq(endorsements.nonces(A), 1);

        // replay of the same signature on a fresh endorsement fails (nonce moved)
        vm.prank(alice);
        uint256 id2 = endorsements.endorse(A, B, "hash", "", 0);
        vm.prank(relayer);
        vm.expectRevert(Endorsements.BadSignature.selector);
        endorsements.revokeFor(id2, deadline, sig);
    }

    function test_revokeFor_wrongSignerAndExpiredAndUnknown() public {
        vm.prank(alice);
        uint256 id = endorsements.endorse(A, B, "hash", "", 0);
        uint64 deadline = uint64(block.timestamp + 600);
        bytes memory wrongSig = _sign(bobPk, endorsements.hashRevoke(id, 0, deadline));
        vm.prank(relayer);
        vm.expectRevert(Endorsements.BadSignature.selector);
        endorsements.revokeFor(id, deadline, wrongSig);

        vm.expectRevert(abi.encodeWithSelector(Endorsements.UnknownEndorsement.selector, uint256(99)));
        endorsements.revokeFor(99, deadline, hex"00");

        bytes memory sig = _sign(alicePk, endorsements.hashRevoke(id, 0, uint64(block.timestamp + 5)));
        uint64 short_ = uint64(block.timestamp + 5);
        vm.warp(block.timestamp + 6);
        vm.expectRevert(abi.encodeWithSelector(Endorsements.ExpiredSignature.selector, short_));
        endorsements.revokeFor(id, short_, sig);
    }

    // ───────────────────────────── views ─────────────────────────────

    function test_receivedAndGivenPagination() public {
        vm.prank(alice);
        endorsements.endorse(A, B, "hash", "", 0);
        vm.prank(alice);
        endorsements.endorse(A, B, "encode", "", 0);
        vm.prank(alice);
        endorsements.endorse(A, C, "hash", "", 0);

        assertEq(endorsements.givenCount(A), 3);
        assertEq(endorsements.receivedCount(B), 2);
        assertEq(endorsements.receivedCount(C), 1);

        uint256[] memory page = endorsements.givenIds(A, 1, 2);
        assertEq(page.length, 2);
        assertEq(page[0], 2);
        assertEq(page[1], 3);
        assertEq(endorsements.givenIds(A, 3, 5).length, 0);
        assertEq(endorsements.givenIds(A, 0, 0).length, 0);
        assertEq(endorsements.receivedIds(B, 0, 10).length, 2);
    }

    function test_capabilityIdOf() public view {
        assertEq(endorsements.capabilityIdOf("hash"), keccak256("hash"));
    }

    function test_quoteWeight_matchesTheStoredWeight() public {
        uint256 jobId = _completedJob(A, alice, dave, 7 ether, 4);
        (uint32 quoted,,) = endorsements.quoteWeight(A, B, jobId);
        vm.prank(alice);
        uint256 id = endorsements.endorse(A, B, "hash", "", jobId);
        assertEq(endorsements.getEndorsement(id).weight, quoted);
        assertEq(quoted, 28);
    }

    // ───────────────────────────── governance ─────────────────────────────

    function test_governance_setters() public {
        vm.startPrank(gov);
        endorsements.setMinPaidWei(10 ether);
        endorsements.setWeightCap(7);
        endorsements.setMaxUriBytes(4);
        vm.stopPrank();
        assertEq(endorsements.minPaidWei(), 10 ether);
        assertEq(endorsements.weightCap(), 7);
        assertEq(endorsements.maxUriBytes(), 4);

        uint256 small = _completedJob(A, alice, dave, 5 ether, 5);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Endorsements.EvidenceTooSmall.selector, 5 ether, 10 ether));
        endorsements.endorse(A, B, "hash", "", small);

        uint256 big = _completedJob(A, alice, dave, 20 ether, 5);
        vm.prank(alice);
        endorsements.endorse(A, B, "hash", "", big);
        assertEq(endorsements.summary(B).weight, 7, "capped by the new weightCap");
    }

    function test_governance_access() public {
        vm.prank(stranger);
        vm.expectRevert(Endorsements.NotGovernance.selector);
        endorsements.setMinPaidWei(1);
        vm.prank(stranger);
        vm.expectRevert(Endorsements.NotGovernance.selector);
        endorsements.setWeightCap(1);
        vm.prank(stranger);
        vm.expectRevert(Endorsements.NotGovernance.selector);
        endorsements.setMaxUriBytes(1);
        vm.prank(stranger);
        vm.expectRevert(Endorsements.NotGovernance.selector);
        endorsements.setGovernance(stranger);
        vm.prank(gov);
        vm.expectRevert(Endorsements.ZeroAddress.selector);
        endorsements.setGovernance(address(0));

        address multisig = makeAddr("multisig");
        vm.prank(gov);
        vm.expectEmit(true, true, true, true);
        emit Endorsements.GovernanceChanged(gov, multisig);
        endorsements.setGovernance(multisig);
        assertEq(endorsements.governance(), multisig);
    }

    function test_weightIsASnapshot_notRepricedByGovernance() public {
        uint256 jobId = _completedJob(A, alice, dave, 6 ether, 5);
        vm.prank(alice);
        uint256 id = endorsements.endorse(A, B, "hash", "", jobId);
        assertEq(endorsements.getEndorsement(id).weight, 30);
        vm.prank(gov);
        endorsements.setWeightCap(1);
        assertEq(endorsements.getEndorsement(id).weight, 30, "history never silently re-prices");
        assertEq(endorsements.summary(B).weight, 30);
    }

    // ───────────────────────────── no factory configured ─────────────────────────────

    function test_worksWithoutAccountFactory() public {
        Endorsements bare = new Endorsements(registry, escrow, IAccountFactoryLike(address(0)), gov);
        assertFalse(bare.isRelated(alice, bob));
        assertTrue(bare.isRelated(alice, alice), "the same-address rule never depends on the factory");
        vm.prank(alice);
        bare.endorse(A, B, "hash", "", 0);
        assertEq(bare.summary(B).total, 1);
    }

    // ───────────────────────────── fuzz ─────────────────────────────

    function testFuzz_weightIsMonotoneInProvenAmount(uint96 rawAmount, uint8 rawRating) public {
        uint256 amount = bound(uint256(rawAmount), 1 ether, 500 ether);
        uint8 rating = uint8(bound(uint256(rawRating), 1, 5));
        uint256 jobId = _completedJob(A, alice, dave, amount, rating);
        (uint32 w, Endorsements.Basis basis,) = endorsements.quoteWeight(A, B, jobId);
        assertEq(uint8(basis), uint8(Endorsements.Basis.PaidWork));
        uint256 expected = (amount / 1 ether) * rating;
        if (expected > 1000) expected = 1000;
        assertEq(w, uint32(expected));
        assertLe(w, endorsements.weightCap());
        assertGe(w, 1, "any qualifying evidence carries at least one unit of weight");
    }
}
