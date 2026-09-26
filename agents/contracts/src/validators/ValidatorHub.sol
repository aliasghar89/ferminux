// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Sig} from "../lib/Sig.sol";
import {SealEvidence} from "./HeaderRLP.sol";

/// @title ValidatorHub: Ferminux validator seats, checkpoint attestations and deposits (Step 1)
/// @notice Anyone deposits exactly 2,000 FMX per seat and runs a validator node that checks every
///         block. Every 200 blocks the node's attester key signs "at height h I see block hash H".
///         When at least max(20, ceil(2/3 of eligible seats)) seats sign the same checkpoint, and at
///         least 30 seats are eligible, the checkpoint is marked certified.
///
///         Step 1 changes nothing in consensus: blocks are still confirmed by the foundation signers
///         under proof-of-authority. Validator seats check blocks and sign checkpoints; they do not
///         produce blocks. Slots 0-5 are reserved for Step 2 (community signing seats from block V),
///         so deposits made today carry over without any migration.
///
///         Money rules (see README.md next to this file):
///           - the owner (the foundation multisig) can never move deposits; the only exits for a
///             deposit are withdraw() by the seat owner after the 14-day unbond, and an executed
///             slash (10% of 2,000 FMX: 10% of that to the reporter, the rest to 0x...dEaD);
///           - the owner can never start or enlarge a slash; it can only veto one inside the 48 h
///             window, and only until the veto power sunsets (180 days, a fixed block height);
///           - downtime never costs deposit: a seat below 50% participation over 124 checkpoints
///             is jailed (no rewards, not counted) and its owner unjails it after 24 h;
///           - rewards (0.025 FMX per accepted attestation, halving at block 4,500,000 or at V)
///             move from the funded pool to a seat only if the pool covers them. An empty pool pays
///             0 and attestations still count;
///           - maxSeats x rewardPerAttest <= 7.5 FMX per checkpoint (3.75 after the halving).
///
///         Durations are counted in blocks at the chain's 7-second period (12,343 blocks = 24 h).
///         The signers never confirm blocks faster than the period, so a block window is never
///         shorter in wall time than the day count it stands for, and it does not run out during a
///         halt.
///
/// @dev solc 0.8.24, evm paris (no PUSH0). No upgradeability, no delegatecall, no selfdestruct,
///      no inheritance, so the storage layout below is exactly the declaration order.
contract ValidatorHub {
    // =====================================================================================
    // Step 2 consensus-read slots. The node engine reads these raw storage slots from block V.
    // They are declared first, are never packed, and must never move (pinned by a vm.load test).
    // =====================================================================================

    /// slot 0: signing keys of seats currently qualified to sign (<= 1,000, swap-and-pop).
    address[] internal _signingKeys;
    /// slot 1: 2,000e18 while the key's seat is qualified and bonded, else 0.
    mapping(address => uint256) internal _countedBond;
    /// slot 2: block at which the key's seat qualified (display, debugging).
    mapping(address => uint256) internal _qualifiedAt;
    /// slot 3: payee for the key's Step 2 signing rewards.
    mapping(address => address) internal _rewardTo;
    /// slot 4: ENGINE-OWNED jail word: jailedUntil (bits 0-63), offences (64-95), lastOffence (96-159).
    ///         This contract never writes it (ValidatorHubLens.jailOf decodes it).
    mapping(address => uint256) internal _jail;
    /// slot 5: bit 0 = communitySeatsOpen.
    uint256 internal _flags;

    // =====================================================================================
    // Types
    // =====================================================================================

    struct Seat {
        // slot a: everything the attestation path reads and writes
        uint96 claimable; // allocated, unclaimed rewards
        uint32 lastAttestedCp; // checkpoint index (height / 200) of the last accepted attestation; 0 = none
        uint32 dutyStartCp; // participation is measured from this checkpoint index
        uint40 activationBlock; // attestations accepted from this block
        uint40 countedSince; // block the seat entered the eligible count; 0 = not counted
        uint8 status; // NONE, BONDED, EXITING, WITHDRAWN
        bool jailed;
        // slot b
        address owner; // cold wallet: the only account that can claim, exit, withdraw or change keys
        uint40 unjailBlock; // while jailed: first block unjail() is allowed
        uint40 unbondEndBlock; // while exiting: first block withdraw() is allowed
        uint8 slashState; // SLASH_NONE, SLASH_PENDING, SLASH_EXECUTED
        bool qualified; // signing key is in the Step 2 candidate list (slot 0)
        // slot c
        address attester; // hot key on the node; it can only attest
        uint96 deposit; // FMX still bonded for this seat (2,000, or 1,800 after a slash)
        // slot d
        address pendingAttester;
        uint40 attesterRotateBlock;
        // slot e, f (Step 2)
        address signingKey;
        address rewardTo;
    }

    struct KeyInfo {
        uint64 seatId; // 0 = never registered. A key is bound to one seat for ever and never reused.
        uint8 role; // ROLE_ATTESTER or ROLE_SIGNING
        bool active; // current attester (or current signing key) of a bonded seat
    }

    struct Checkpoint {
        bytes32 blockHash; // blockhash(height), checked on-chain
        uint32 count; // attestations by seats that were eligible at the snapshot
        uint32 eligible; // eligible seats, snapshotted at the first accepted attestation
        uint32 total; // all accepted attestations (including seats not yet eligible)
        uint40 snapshotBlock;
        bool certified;
    }

    struct Slash {
        uint64 seatId;
        uint8 kind; // KIND_DOUBLE_ATTESTATION or KIND_DOUBLE_SEAL
        uint8 status; // SLASH_PENDING, SLASH_EXECUTED, SLASH_VETOED
        uint40 executableBlock; // executeSlash() allowed from here; veto() only before it
        uint40 vetoSunsetBlock; // veto() impossible from this block
        uint96 amount;
        address reporter;
        uint64 height; // checkpoint height or header number of the offence
    }

    /// Running totals. Conservation (checked by the invariant tests):
    ///   totalDeposited = bondedTotal + totalWithdrawn + totalSlashed
    ///   totalFunded    = rewardPool + totalClaimable + totalClaimed + totalReturned
    ///   totalSlashed   = totalCredits + credits paid + totalBurned + pendingBurn
    struct Accounting {
        uint256 totalDeposited;
        uint256 totalWithdrawn;
        uint256 totalSlashed;
        uint256 totalBurned;
        uint256 pendingBurn; // burn share whose transfer to BURN_ADDRESS failed
        uint256 totalCredits; // reporter credits not yet withdrawn
        uint256 totalFunded;
        uint256 totalAllocated;
        uint256 totalClaimable; // sum of seat.claimable
        uint256 totalClaimed;
        uint256 totalReturned;
    }

    /// Working state of one attest/attestBatch call.
    struct Batch {
        uint256 height;
        uint256 cp;
        bytes32 digest;
        uint256 rate;
        uint256 pool;
        uint256 paid;
        uint256 snapshotBlock;
        uint256 eligible;
        uint256 count;
        uint256 total;
        uint256 added;
        bool fresh;
    }

    // =====================================================================================
    // Constants (PLAN.md section 3 and 5.1; the README lists each with its source)
    // =====================================================================================

    uint256 public constant SEAT_DEPOSIT = 2_000 ether;

    uint256 internal constant BLOCKS_PER_DAY = 12_343; // 86,400 s / 7 s
    uint256 internal constant ACTIVATION_DELAY = 12_343; // 24 h after deposit
    uint256 internal constant ELIGIBILITY_DELAY = 86_400; // counts for certification 7 days after activation
    uint256 internal constant UNBONDING_PERIOD = 172_800; // 14 days
    uint256 internal constant UNJAIL_DELAY = 12_343; // 24 h
    uint256 internal constant ROTATE_DELAY = 12_343; // attester key rotation: 24 h
    uint256 internal constant TIMELOCK = 24_686; // 48 h on every parameter
    uint256 internal constant SLASH_WINDOW = 24_686; // 48 h veto window before executeSlash
    uint256 internal constant VETO_SUNSET_PERIOD = 2_221_715; // 180 days
    uint256 internal constant LAUNCH_PERIOD = 370_286; // 30 days at <= 100 seats
    uint256 internal constant QUALIFY_ACTIVE_PERIOD = 370_286; // Step 2: 30 days active before qualify()
    uint256 internal constant RESERVE_CHECKPOINTS = 11_109; // 180 days of checkpoints (returnExcess)

    uint256 internal constant CHECKPOINT_INTERVAL = 200;
    uint256 internal constant INCLUSION_DELAY = 64; // = FerminuxMaxReorgDepth
    uint256 internal constant INCLUSION_END = 250; // inside the 256-block BLOCKHASH window
    uint256 internal constant MIN_CERT_ATTESTATIONS = 20;
    uint256 internal constant MIN_ELIGIBLE_FOR_CERT = 30;
    uint256 internal constant JAIL_WINDOW = 124; // checkpoints, about 48 h
    uint256 internal constant JAIL_BPS = 5_000; // jailed below 50%
    uint256 internal constant QUALIFY_WINDOW = 432; // checkpoints, about 7 days
    uint256 internal constant QUALIFY_BPS = 9_000; // qualify at >= 90%
    uint256 internal constant RING = 512; // participation ring size, in checkpoints
    uint256 internal constant MAX_PARTICIPATION_WINDOW = 511;

    uint256 internal constant LAUNCH_MAX_SEATS = 100;
    uint256 internal constant HARD_MAX_SEATS = 1_000;
    uint256 internal constant DEFAULT_ACTIVATIONS_PER_DAY = 10;
    uint256 internal constant MAX_ACTIVATIONS_PER_DAY = 50;
    uint256 internal constant INITIAL_REWARD_PER_ATTEST = 0.025 ether;
    uint256 internal constant MAX_REWARD_PER_ATTEST = 0.05 ether;
    uint256 internal constant BUDGET_PER_CHECKPOINT = 7.5 ether;
    uint256 internal constant HALVING_BLOCK = 4_500_000;

    uint256 internal constant SLASH_BPS = 1_000; // 10% of the seat deposit
    uint256 internal constant REPORTER_BPS = 1_000; // 10% of the slash to the reporter
    uint256 internal constant BPS = 10_000;
    address internal constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    uint256 internal constant MAX_SIGNING_CANDIDATES = 1_000;
    uint256 internal constant MIN_COMMUNITY_SEATS = 4;
    uint256 internal constant MAX_COMMUNITY_SEATS = 64;
    uint256 internal constant ROTATION_INTERVAL = 600;
    uint256 internal constant OPEN_SEATS_EPOCH = 30_000; // V is a multiple of the Clique epoch

    string internal constant NAME = "Ferminux Validator Hub";
    string internal constant VERSION = "1";
    bytes32 public constant ATTESTATION_TYPEHASH = keccak256("Attestation(uint64 height,bytes32 blockHash)");
    bytes32 internal constant ATTESTER_KEY_TYPEHASH = keccak256("AttesterKey(address owner,address attester)");

    // seat status
    uint8 internal constant NONE = 0;
    uint8 internal constant BONDED = 1;
    uint8 internal constant EXITING = 2;
    uint8 internal constant WITHDRAWN = 3;
    // key roles
    uint8 internal constant ROLE_ATTESTER = 1;
    uint8 internal constant ROLE_SIGNING = 2;
    // slash
    uint8 internal constant SLASH_NONE = 0;
    uint8 internal constant SLASH_PENDING = 1;
    uint8 internal constant SLASH_EXECUTED = 2;
    uint8 internal constant SLASH_VETOED = 3;
    uint8 internal constant KIND_DOUBLE_ATTESTATION = 1;
    uint8 internal constant KIND_DOUBLE_SEAL = 2;
    // attestation result codes
    uint256 internal constant OK = 0;
    uint256 internal constant R_BAD_SIGNATURE = 1;
    uint256 internal constant R_UNKNOWN_KEY = 2;
    uint256 internal constant R_NOT_ACTIVE = 3;
    uint256 internal constant R_DUPLICATE = 4;
    // timelocked parameters
    uint8 internal constant P_MAX_SEATS = 0;
    uint8 internal constant P_REWARD_PER_ATTEST = 1;
    uint8 internal constant P_ACTIVATIONS_PER_DAY = 2;
    uint8 internal constant P_OPEN_SEATS_BLOCK = 3;
    uint8 internal constant P_OPEN_COMMUNITY_SEATS = 4;
    uint8 internal constant P_DENY = 5;
    uint8 internal constant P_ALLOW = 6;

    // =====================================================================================
    // Immutables
    // =====================================================================================

    uint256 public immutable deployBlock;
    /// Veto of a double-attestation slash is impossible from this block (deploy + 180 days).
    uint256 public immutable vetoSunsetBlock;
    /// FMXRewardSink: where returnExcess() sends unallocated FMX beyond 180 days of spend.
    address public immutable rewardSink;
    /// Stateless RLP checker for Step 2 header evidence, deployed by this constructor.
    SealEvidence public immutable sealEvidence;
    uint256 internal immutable _cachedChainId;
    bytes32 internal immutable _cachedDomain;

    // =====================================================================================
    // Storage (slot 6 onward)
    // =====================================================================================

    address public owner;
    address public pendingOwner;

    uint256 public maxSeats;
    uint256 public rewardPerAttest; // base rate; halves automatically at the halving (see currentRewardPerAttest)
    uint256 public activationsPerDay;
    uint256 public openSeatsBlock; // V; 0 until set once by timelock

    bool public seatsPaused; // openSeat() only
    bool public attestationsPaused; // attest()/attestBatch()/jail()
    uint256 public globalDutyStartCp; // participation is measured from here after an attestation pause

    uint256 public seatCount; // seat ids run 1..seatCount
    uint256 public occupiedSeats; // seats in BONDED status (pending activation, active or jailed)
    uint256 public eligibleCount; // seats counted toward certification
    uint256 internal _eligCursor; // next seat id the eligibility cursor examines
    uint256 internal _queueDay; // activation queue: current day bucket
    uint256 internal _queueCount; // activations already scheduled in that bucket

    // money
    uint256 public rewardPool; // funded, unallocated
    uint256 public bondedTotal; // sum of seat deposits not yet withdrawn or slashed
    Accounting internal _acct; // running totals, see accounting()

    mapping(uint256 => Seat) internal _seats;
    mapping(address => KeyInfo) internal _keys;
    mapping(uint256 => bytes32[2]) internal _enode; // 64-byte devp2p public key
    mapping(uint256 => uint256[2]) internal _bits; // 512-checkpoint participation ring
    mapping(uint256 => Checkpoint) internal _checkpoints; // by height
    mapping(address => uint256) internal _signingIndex; // index in _signingKeys + 1
    mapping(uint256 => Slash) internal _slashes;
    uint256 public slashCount;
    mapping(bytes32 => bool) public evidenceUsed;
    mapping(address => uint256) public credits;
    mapping(address => bool) public denied;
    mapping(bytes32 => uint256) public timelockEta; // keccak(param, value) => executable block

    uint256 private _lock = 1;

    /// Block at which a hot key stopped being the seat's key through replacement (an applied or
    /// superseded attester rotation, a replaced signing key). Evidence against such a key is
    /// accepted for UNBONDING_PERIOD after it, the same exposure an exit has; afterwards a leaked
    /// old key can no longer slash the seat. Keys deactivated by exit or slash are bounded by the
    /// seat's own unbond instead and never get an entry. (ValidatorHubLens.keyRetiredAt, slot 46.)
    mapping(address => uint256) internal _retiredAt;

    // =====================================================================================
    // Events
    // =====================================================================================

    event SeatOpened(
        uint256 indexed seatId,
        address indexed owner,
        address indexed attester,
        uint256 activationBlock,
        uint256 eligibleBlock
    );
    event EnodeSet(uint256 indexed seatId, address indexed nodeAddress, bytes pubkey);
    event SeatEligible(uint256 indexed seatId, uint256 eligibleCount);
    event AttesterRotationQueued(uint256 indexed seatId, address indexed newAttester, uint256 effectiveBlock);
    event AttesterRotated(uint256 indexed seatId, address indexed oldAttester, address indexed newAttester);
    event RewardToSet(uint256 indexed seatId, address rewardTo);
    event SigningKeySet(uint256 indexed seatId, address indexed signingKey);
    event Qualified(uint256 indexed seatId, address indexed signingKey);
    event Disqualified(uint256 indexed seatId, address indexed signingKey);
    event ExitRequested(uint256 indexed seatId, uint256 unbondEndBlock);
    event Withdrawn(uint256 indexed seatId, address indexed to, uint256 amount);
    event Claimed(uint256 indexed seatId, address indexed to, uint256 amount);
    event Funded(address indexed from, uint256 amount);
    event CheckpointOpened(uint256 indexed height, bytes32 blockHash, uint256 eligible);
    event Attested(uint256 indexed seatId, uint256 indexed height, uint256 reward);
    event CheckpointCertified(uint256 indexed height, bytes32 blockHash, uint256 count, uint256 eligible);
    event Jailed(uint256 indexed seatId, uint256 attested, uint256 window, uint256 unjailBlock);
    event Unjailed(uint256 indexed seatId, uint256 dutyStartCheckpoint);
    event SlashProposed(
        uint256 indexed slashId,
        uint256 indexed seatId,
        uint8 kind,
        uint256 height,
        address reporter,
        uint256 amount,
        uint256 executableBlock
    );
    event SlashVetoed(uint256 indexed slashId, uint256 indexed seatId);
    event SlashExecuted(
        uint256 indexed slashId, uint256 indexed seatId, uint256 amount, uint256 toReporter, uint256 burned
    );
    event CreditWithdrawn(address indexed account, address indexed to, uint256 amount);
    event BurnFlushed(uint256 amount);
    event ExcessReturned(address indexed sink, uint256 amount);
    event ParamQueued(uint8 indexed param, uint256 value, uint256 eta);
    event ParamCancelled(uint8 indexed param, uint256 value);
    event ParamApplied(uint8 indexed param, uint256 value);
    event SeatsPausedSet(bool paused);
    event AttestationsPausedSet(bool paused, uint256 dutyStartCheckpoint);
    event CommunitySeatsSet(bool open);
    event DenySet(address indexed account, bool denied);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    // =====================================================================================
    // Errors
    // =====================================================================================

    error NotOwner();
    error NotSeatOwner();
    error ZeroAddress();
    error Reentrancy();
    error WrongDeposit();
    error Denied();
    error SeatsFull();
    error Paused();
    error BadKey();
    error KeyUsed();
    error BadPossession();
    error BadEnode();
    error BadStatus();
    error TooEarly();
    error NotCheckpoint();
    error OutsideWindow();
    error WrongBlockHash();
    error BadSignatureBlob();
    error AttestationRejected(uint256 code);
    error NotJailable();
    error NotQualifiable();
    error NotDisqualifiable();
    error BadEvidence();
    error EvidenceUsed();
    error SlashNotPending();
    error VetoClosed();
    error NothingToPay();
    error TransferFailed();
    error BadParam();
    error NotQueued();
    error AlreadyQueued();
    error BadWindow();

    // =====================================================================================
    // Modifiers
    // =====================================================================================

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier nonReentrant() {
        _enter();
        _;
        _lock = 1;
    }

    function _enter() private {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
    }

    // =====================================================================================
    // Constructor
    // =====================================================================================

    /// @param owner_   the foundation multisig on mainnet (0x910B...fEfe); a lab or testnet owner elsewhere.
    ///                 Not pinned here: the lab runs a copy of mainnet with chain id 3961 and its own
    ///                 owner. DeployValidatorsMainnet pins the owner and sink and checks them after deploy.
    /// @param sink_    FMXRewardSink; returnExcess() pays back into it
    /// @param denied_  seat owners refused as policy (premine and foundation wallets)
    constructor(address owner_, address sink_, address[] memory denied_) {
        if (owner_ == address(0) || sink_ == address(0)) revert ZeroAddress();
        owner = owner_;
        rewardSink = sink_;
        deployBlock = block.number;
        vetoSunsetBlock = block.number + VETO_SUNSET_PERIOD;
        maxSeats = LAUNCH_MAX_SEATS;
        rewardPerAttest = INITIAL_REWARD_PER_ATTEST;
        activationsPerDay = DEFAULT_ACTIVATIONS_PER_DAY;
        _eligCursor = 1;
        sealEvidence = new SealEvidence();
        _cachedChainId = block.chainid;
        _cachedDomain = _buildDomain();
        for (uint256 i; i < denied_.length; ++i) {
            denied[denied_[i]] = true;
            emit DenySet(denied_[i], true);
        }
        emit OwnershipTransferred(address(0), owner_);
    }

    // =====================================================================================
    // Funding
    // =====================================================================================

    /// @notice Add FMX to the reward pool. FMXRewardSink.withdraw() and SinkRouter use this or
    ///         a plain transfer (receive), which does the same.
    function fund() external payable {
        _fund();
    }

    receive() external payable {
        _fund();
    }

    function _fund() internal {
        if (msg.value == 0) return;
        rewardPool += msg.value;
        _acct.totalFunded += msg.value;
        emit Funded(msg.sender, msg.value);
    }

    /// @notice Send unallocated FMX beyond 180 days of maximum spend back to FMXRewardSink.
    ///         Permissionless.
    function returnExcess() external nonReentrant returns (uint256 excess) {
        uint256 reserve = maxSeats * currentRewardPerAttest() * RESERVE_CHECKPOINTS;
        uint256 pool = rewardPool;
        if (pool <= reserve) revert NothingToPay();
        excess = pool - reserve;
        rewardPool = reserve;
        _acct.totalReturned += excess;
        _send(rewardSink, excess);
        emit ExcessReturned(rewardSink, excess);
    }

    // =====================================================================================
    // Seats
    // =====================================================================================

    /// @notice Open one seat with exactly 2,000 FMX. The caller becomes the seat owner.
    /// @param attester     hot key on the node; it only signs attestations
    /// @param attesterSig  EIP-712 AttesterKey(owner, attester) signed by `attester`
    /// @param enodePubkey  the node's 64-byte devp2p public key (enode id)
    /// @param enodeSig     signature by the node key over enodeDigest(owner, attester)
    function openSeat(
        address attester,
        bytes calldata attesterSig,
        bytes calldata enodePubkey,
        bytes calldata enodeSig
    ) external payable returns (uint256 seatId) {
        if (seatsPaused) revert Paused();
        if (msg.value != SEAT_DEPOSIT) revert WrongDeposit();
        if (denied[msg.sender]) revert Denied();
        if (occupiedSeats >= maxSeats) revert SeatsFull();
        _checkAttester(msg.sender, attester, attesterSig);

        uint256 act = _scheduleActivation();
        seatId = ++seatCount;
        Seat storage s = _seats[seatId];
        s.owner = msg.sender;
        s.attester = attester;
        s.deposit = uint96(SEAT_DEPOSIT);
        s.status = BONDED;
        s.activationBlock = uint40(act);
        s.dutyStartCp = uint32(act / CHECKPOINT_INTERVAL + 1);
        _keys[attester] = KeyInfo({seatId: uint64(seatId), role: ROLE_ATTESTER, active: true});

        ++occupiedSeats;
        bondedTotal += SEAT_DEPOSIT;
        _acct.totalDeposited += SEAT_DEPOSIT;
        emit SeatOpened(seatId, msg.sender, attester, act, act + ELIGIBILITY_DELAY);
        _setEnode(seatId, msg.sender, attester, enodePubkey, enodeSig);
    }

    /// @notice Replace the seat's registered enode (for example after reinstalling the node).
    function setEnode(uint256 seatId, bytes calldata enodePubkey, bytes calldata enodeSig) external {
        Seat storage s = _ownedSeat(seatId);
        if (s.status != BONDED) revert BadStatus();
        _setEnode(seatId, s.owner, s.attester, enodePubkey, enodeSig);
    }

    /// @notice Queue a new attester key; it replaces the current one after 24 h. The current key
    ///         keeps attesting until then. Both keys stay bound to this seat for ever; a replaced
    ///         key stays usable as slashing evidence for 14 days after it stops attesting.
    function rotateAttester(uint256 seatId, address newAttester, bytes calldata attesterSig) external {
        Seat storage s = _ownedSeat(seatId);
        if (s.status != BONDED) revert BadStatus();
        _checkAttester(s.owner, newAttester, attesterSig);
        _keys[newAttester] = KeyInfo({seatId: uint64(seatId), role: ROLE_ATTESTER, active: false});
        address superseded = s.pendingAttester;
        if (superseded != address(0)) _retiredAt[superseded] = block.number;
        uint256 eff = block.number + ROTATE_DELAY;
        s.pendingAttester = newAttester;
        s.attesterRotateBlock = uint40(eff);
        emit AttesterRotationQueued(seatId, newAttester, eff);
    }

    /// @notice Complete a queued attester rotation after its 24 h delay. Permissionless.
    function applyAttesterRotation(uint256 seatId) external {
        Seat storage s = _seats[seatId];
        address next = s.pendingAttester;
        if (next == address(0) || s.status != BONDED) revert BadStatus();
        if (block.number < s.attesterRotateBlock) revert TooEarly();
        address old = s.attester;
        _keys[old].active = false;
        _retiredAt[old] = block.number;
        _keys[next].active = true;
        s.attester = next;
        s.pendingAttester = address(0);
        s.attesterRotateBlock = 0;
        emit AttesterRotated(seatId, old, next);
    }

    /// @notice Payee for Step 2 signing rewards (zero = the seat owner).
    function setRewardTo(uint256 seatId, address to) external {
        Seat storage s = _ownedSeat(seatId);
        s.rewardTo = to;
        if (s.qualified) _rewardTo[s.signingKey] = to == address(0) ? s.owner : to;
        emit RewardToSet(seatId, to);
    }

    /// @notice Start the 14-day unbond. Rewards stop at once; evidence stays usable until withdraw.
    function requestExit(uint256 seatId) external {
        Seat storage s = _ownedSeat(seatId);
        if (s.status != BONDED) revert BadStatus();
        _eject(seatId, s);
    }

    /// @notice Return the remaining deposit after the unbond. Blocked while a slash is pending.
    function withdraw(uint256 seatId, address payable to) external nonReentrant {
        Seat storage s = _ownedSeat(seatId);
        if (to == address(0)) revert ZeroAddress();
        if (s.status != EXITING) revert BadStatus();
        if (block.number < s.unbondEndBlock || s.slashState == SLASH_PENDING) revert TooEarly();
        uint256 amount = s.deposit;
        s.status = WITHDRAWN;
        s.deposit = 0;
        bondedTotal -= amount;
        _acct.totalWithdrawn += amount;
        _send(to, amount);
        emit Withdrawn(seatId, to, amount);
    }

    /// @notice Pay out all of the seat's claimable rewards.
    function claim(uint256 seatId, address payable to) external nonReentrant returns (uint256 amount) {
        Seat storage s = _ownedSeat(seatId);
        if (to == address(0)) revert ZeroAddress();
        amount = s.claimable;
        _payClaim(seatId, s, to, amount);
    }

    /// @notice Send part of the seat's rewards to its attester key as gas for self-submission.
    function claimToAttester(uint256 seatId, uint256 amount) external nonReentrant {
        Seat storage s = _ownedSeat(seatId);
        if (amount > s.claimable) revert NothingToPay();
        _payClaim(seatId, s, s.attester, amount);
    }

    function _payClaim(uint256 seatId, Seat storage s, address to, uint256 amount) internal {
        if (amount == 0) revert NothingToPay();
        s.claimable -= uint96(amount);
        _acct.totalClaimable -= amount;
        _acct.totalClaimed += amount;
        _send(to, amount);
        emit Claimed(seatId, to, amount);
    }

    // =====================================================================================
    // Attestations
    // =====================================================================================

    /// @notice Record one attestation. Anyone may submit it (the attester itself or a relay).
    /// @param height    checkpoint height, a multiple of 200
    /// @param blockHash must equal blockhash(height); included while block.number is in [h+64, h+250]
    /// @param sig       EIP-712 Attestation(height, blockHash) signed by a seat's attester key
    function attest(uint64 height, bytes32 blockHash, bytes calldata sig) external returns (uint256 seatId) {
        Batch memory b = _openBatch(height, blockHash);
        uint256 code;
        (code, seatId) = _attestOne(b, blockHash, sig);
        if (code != OK) revert AttestationRejected(code);
        _closeBatch(b, blockHash);
    }

    /// @notice Record many attestations for one checkpoint. `sigs` is 65-byte signatures packed
    ///         back to back. A bad, unknown, inactive or duplicate signature is skipped, so one
    ///         bad entry cannot sink a relay's batch; a wrong block hash reverts the whole call.
    function attestBatch(uint64 height, bytes32 blockHash, bytes calldata sigs) external returns (uint256 accepted) {
        uint256 len = sigs.length;
        if (len == 0 || len % 65 != 0) revert BadSignatureBlob();
        Batch memory b = _openBatch(height, blockHash);
        for (uint256 off; off < len; off += 65) {
            (uint256 code,) = _attestOne(b, blockHash, sigs[off:off + 65]);
            if (code == OK) ++accepted;
        }
        _closeBatch(b, blockHash);
    }

    function _openBatch(uint256 height, bytes32 blockHash) internal returns (Batch memory b) {
        if (attestationsPaused) revert Paused();
        if (height == 0 || height % CHECKPOINT_INTERVAL != 0) revert NotCheckpoint();
        if (block.number < height + INCLUSION_DELAY || block.number > height + INCLUSION_END) revert OutsideWindow();
        if (blockHash == bytes32(0) || blockhash(height) != blockHash) revert WrongBlockHash();
        // Complete, so the snapshot below is exact. The backlog is bounded by the churn limit
        // (<= 50 seats a day) times the days since the last attestation call.
        _sync(type(uint256).max);
        b.height = height;
        b.cp = height / CHECKPOINT_INTERVAL;
        b.digest = attestationDigest(uint64(height), blockHash);
        b.rate = currentRewardPerAttest();
        b.pool = rewardPool;
        Checkpoint storage cp = _checkpoints[height];
        if (cp.snapshotBlock == 0) {
            b.fresh = true;
            b.snapshotBlock = block.number;
            b.eligible = eligibleCount;
        } else {
            b.snapshotBlock = cp.snapshotBlock;
            b.eligible = cp.eligible;
            b.count = cp.count;
            b.total = cp.total;
        }
    }

    function _attestOne(Batch memory b, bytes32 blockHash, bytes calldata sig)
        internal
        returns (uint256 code, uint256 seatId)
    {
        address key = Sig.recover(b.digest, sig);
        if (key == address(0)) return (R_BAD_SIGNATURE, 0);
        KeyInfo memory k = _keys[key];
        if (!k.active || k.role != ROLE_ATTESTER) return (R_UNKNOWN_KEY, 0);
        seatId = k.seatId;
        Seat storage s = _seats[seatId];
        if (s.status != BONDED || s.jailed || block.number < s.activationBlock) return (R_NOT_ACTIVE, seatId);
        uint256 last = s.lastAttestedCp;
        if (last >= b.cp) return (R_DUPLICATE, seatId);

        _markParticipation(seatId, last, b.cp);
        s.lastAttestedCp = uint32(b.cp);

        uint256 reward;
        if (b.rate != 0 && b.pool >= b.rate) {
            reward = b.rate;
            b.pool -= reward;
            b.paid += reward;
            s.claimable += uint96(reward);
        }
        uint256 since = s.countedSince;
        if (since != 0 && since <= b.snapshotBlock) ++b.count;
        ++b.total;
        if (b.added == 0 && b.fresh) emit CheckpointOpened(b.height, blockHash, b.eligible);
        ++b.added;
        emit Attested(seatId, b.height, reward);
    }

    function _closeBatch(Batch memory b, bytes32 blockHash) internal {
        if (b.added == 0) return;
        Checkpoint storage cp = _checkpoints[b.height];
        if (b.fresh) {
            cp.blockHash = blockHash;
            cp.eligible = uint32(b.eligible);
            cp.snapshotBlock = uint40(b.snapshotBlock);
        }
        cp.count = uint32(b.count);
        cp.total = uint32(b.total);
        if (b.paid != 0) {
            rewardPool = b.pool;
            _acct.totalAllocated += b.paid;
            _acct.totalClaimable += b.paid;
        }
        if (!cp.certified && certifies(b.count, b.eligible)) {
            cp.certified = true;
            emit CheckpointCertified(b.height, blockHash, b.count, b.eligible);
        }
    }

    /// @notice Certification rule: at least 30 eligible seats, and at least
    ///         max(20, ceil(2/3 x eligible)) of them attested the same block.
    function certifies(uint256 count, uint256 eligible) public pure returns (bool) {
        if (eligible < MIN_ELIGIBLE_FOR_CERT) return false;
        uint256 twoThirds = (2 * eligible + 2) / 3;
        uint256 need = twoThirds > MIN_CERT_ATTESTATIONS ? twoThirds : MIN_CERT_ATTESTATIONS;
        return count >= need;
    }

    // =====================================================================================
    // Participation: jail, unjail
    // =====================================================================================

    /// @notice Jail a seat that attested to fewer than 50% of the last 124 closed checkpoints.
    ///         Permissionless. The seat stops earning and leaves the certification count. No
    ///         deposit is taken.
    function jail(uint256 seatId) external {
        if (attestationsPaused) revert Paused();
        Seat storage s = _seats[seatId];
        if (s.status != BONDED || s.jailed) revert NotJailable();
        (bool covered, uint256 hits) = _participationCheck(seatId, s, JAIL_WINDOW);
        if (!covered || hits * BPS >= JAIL_WINDOW * JAIL_BPS) revert NotJailable();
        s.jailed = true;
        uint256 unjailAt = block.number + UNJAIL_DELAY;
        s.unjailBlock = uint40(unjailAt);
        _uncount(seatId, s);
        _disqualify(seatId, s);
        emit Jailed(seatId, hits, JAIL_WINDOW, unjailAt);
    }

    /// @notice Resume a jailed seat, 24 h after it was jailed. Participation is measured afresh
    ///         from the next checkpoint.
    function unjail(uint256 seatId) external {
        Seat storage s = _ownedSeat(seatId);
        if (!s.jailed || s.status != BONDED) revert BadStatus();
        if (block.number < s.unjailBlock) revert TooEarly();
        s.jailed = false;
        s.unjailBlock = 0;
        uint256 duty = block.number / CHECKPOINT_INTERVAL + 1;
        s.dutyStartCp = uint32(duty);
        if (uint256(s.activationBlock) + ELIGIBILITY_DELAY <= block.number) _count(seatId, s);
        emit Unjailed(seatId, duty);
    }

    // =====================================================================================
    // Step 2 (callable from day one; the engine reads slots 0-5 only from block V)
    // =====================================================================================

    /// @notice Register the seat's block-signing key (one per network). The key proves possession
    ///         by signing keccak256("FERMINUX-SIGNKEY-V1", chainid, hub, seatId, key, owner).
    function setSigningKey(uint256 seatId, address key, bytes calldata pop) external {
        Seat storage s = _ownedSeat(seatId);
        if (s.status != BONDED || s.qualified) revert BadStatus();
        if (key == address(0) || key == s.owner) revert BadKey();
        if (_keys[key].seatId != 0) revert KeyUsed();
        if (Sig.recover(signingKeyDigest(seatId, key, s.owner), pop) != key) revert BadPossession();
        address old = s.signingKey;
        if (old != address(0)) {
            _keys[old].active = false;
            _retiredAt[old] = block.number;
        }
        _keys[key] = KeyInfo({seatId: uint64(seatId), role: ROLE_SIGNING, active: true});
        s.signingKey = key;
        emit SigningKeySet(seatId, key);
    }

    /// @notice Put a seat's signing key into the Step 2 candidate list (slots 0-3). Permissionless.
    ///         Needs 30 days active, >= 90% of the last 432 checkpoints, not jailed, not exiting,
    ///         no slash, and a signing key.
    function qualify(uint256 seatId) external {
        Seat storage s = _seats[seatId];
        address key = s.signingKey;
        if (
            s.status != BONDED || s.jailed || s.qualified || s.slashState != SLASH_NONE || key == address(0)
                || block.number < uint256(s.activationBlock) + QUALIFY_ACTIVE_PERIOD
                || _signingKeys.length >= MAX_SIGNING_CANDIDATES
        ) revert NotQualifiable();
        (bool covered, uint256 hits) = _participationCheck(seatId, s, QUALIFY_WINDOW);
        if (!covered || hits * BPS < QUALIFY_WINDOW * QUALIFY_BPS) revert NotQualifiable();
        _signingKeys.push(key);
        _signingIndex[key] = _signingKeys.length;
        _countedBond[key] = SEAT_DEPOSIT;
        _qualifiedAt[key] = block.number;
        address payee = s.rewardTo;
        _rewardTo[key] = payee == address(0) ? s.owner : payee;
        s.qualified = true;
        emit Qualified(seatId, key);
    }

    /// @notice Remove a seat from the candidate list. The seat owner may always do it; anyone may
    ///         once participation fell below 50% over the last 124 checkpoints (not while
    ///         attestations are paused). Exit, jail and slash disqualify automatically.
    function disqualify(uint256 seatId) external {
        Seat storage s = _seats[seatId];
        if (!s.qualified) revert NotDisqualifiable();
        if (msg.sender != s.owner) {
            // Like jail(): an attestation pause empties every seat's recent checkpoints, so it must
            // not let anyone strip the whole candidate list while it lasts.
            if (attestationsPaused) revert Paused();
            (bool covered, uint256 hits) = _participationCheck(seatId, s, JAIL_WINDOW);
            if (!covered || hits * BPS >= JAIL_WINDOW * JAIL_BPS) revert NotDisqualifiable();
        }
        _disqualify(seatId, s);
    }

    // =====================================================================================
    // Slashing: double attestation (live) and Step 2 double-sign of headers (inert until V is set)
    // =====================================================================================

    /// @notice Prove that one attester key signed two different block hashes for one checkpoint
    ///         height. Permissionless and fully checked on-chain. Starts a 10% slash that executes
    ///         after 48 h unless the multisig vetoes it inside the window.
    function proveDoubleAttestation(
        uint64 height,
        bytes32 hashA,
        bytes calldata sigA,
        bytes32 hashB,
        bytes calldata sigB
    ) external returns (uint256 slashId) {
        if (height == 0 || height % CHECKPOINT_INTERVAL != 0 || hashA == hashB) revert BadEvidence();
        address key = Sig.recover(attestationDigest(height, hashA), sigA);
        if (key == address(0) || Sig.recover(attestationDigest(height, hashB), sigB) != key) revert BadEvidence();
        KeyInfo memory k = _keys[key];
        if (k.seatId == 0 || k.role != ROLE_ATTESTER) revert BadEvidence();
        slashId = _proposeSlash(key, k.seatId, KIND_DOUBLE_ATTESTATION, height, vetoSunsetBlock);
    }

    /// @notice Step 2 double-sign evidence: prove that one signing key confirmed two different
    ///         headers with the same number and parent. Each preimage is the RLP the header
    ///         signature covers (the header with the 65-byte signature removed from extraData);
    ///         only item 0 (parentHash) and item 8 (number) are parsed. Inert until openSeatsBlock
    ///         (V) is set, and only for headers at or above V. (Named after the Clique Seal() method.)
    function proveDoubleSeal(
        bytes calldata preimageA,
        bytes calldata sigA,
        bytes calldata preimageB,
        bytes calldata sigB
    ) external returns (uint256 slashId) {
        uint256 v = openSeatsBlock;
        if (v == 0) revert BadEvidence();
        (uint256 number, bytes32 sealA, bytes32 sealB) = sealEvidence.check(preimageA, preimageB);
        if (number < v) revert BadEvidence();
        address key = Sig.recover(sealA, sigA);
        if (key == address(0) || Sig.recover(sealB, sigB) != key) revert BadEvidence();
        KeyInfo memory k = _keys[key];
        if (k.seatId == 0 || k.role != ROLE_SIGNING) revert BadEvidence();
        slashId = _proposeSlash(key, k.seatId, KIND_DOUBLE_SEAL, number, v + VETO_SUNSET_PERIOD);
    }

    function _proposeSlash(address key, uint256 seatId, uint8 kind, uint256 height, uint256 sunset)
        internal
        returns (uint256 slashId)
    {
        // A replaced key stays evidence for one unbonding period, then rotation has fully retired
        // it: an old key leaked from a decommissioned PC cannot slash the seat years later.
        uint256 retired = _retiredAt[key];
        if (retired != 0 && block.number >= retired + UNBONDING_PERIOD) revert BadEvidence();
        bytes32 ev = keccak256(abi.encode(kind, seatId, height));
        if (evidenceUsed[ev]) revert EvidenceUsed();
        Seat storage s = _seats[seatId];
        uint8 st = s.status;
        if ((st != BONDED && st != EXITING) || s.slashState != SLASH_NONE) revert BadStatus();
        evidenceUsed[ev] = true;

        uint256 amount = SEAT_DEPOSIT * SLASH_BPS / BPS;
        if (amount > s.deposit) amount = s.deposit;
        uint256 exec = block.number + SLASH_WINDOW;
        slashId = ++slashCount;
        _slashes[slashId] = Slash({
            seatId: uint64(seatId),
            kind: kind,
            status: SLASH_PENDING,
            executableBlock: uint40(exec),
            vetoSunsetBlock: uint40(sunset),
            amount: uint96(amount),
            reporter: msg.sender,
            height: uint64(height)
        });
        s.slashState = SLASH_PENDING;
        // Ban the keys and eject the seat into unbonding. A queued attester rotation can never
        // complete afterwards (it needs a bonded seat), and every key stays bound to this seat.
        _keys[s.attester].active = false;
        address sk = s.signingKey;
        if (sk != address(0)) _keys[sk].active = false;
        if (st == BONDED) _eject(seatId, s);
        emit SlashProposed(slashId, seatId, kind, height, msg.sender, amount, exec);
    }

    /// @notice Execute a slash after its 48 h window. Permissionless. 10% of the slash is credited
    ///         to the reporter (withdrawCredit), the rest is sent to 0x...dEaD.
    function executeSlash(uint256 slashId) external nonReentrant {
        Slash storage sl = _slashes[slashId];
        if (sl.status != SLASH_PENDING) revert SlashNotPending();
        if (block.number < sl.executableBlock) revert TooEarly();
        sl.status = SLASH_EXECUTED;
        uint256 seatId = sl.seatId;
        Seat storage s = _seats[seatId];
        uint256 amount = sl.amount;
        s.deposit -= uint96(amount);
        s.slashState = SLASH_EXECUTED;
        bondedTotal -= amount;
        _acct.totalSlashed += amount;
        uint256 toReporter = amount * REPORTER_BPS / BPS;
        uint256 burned = amount - toReporter;
        credits[sl.reporter] += toReporter;
        _acct.totalCredits += toReporter;
        (bool ok,) = BURN_ADDRESS.call{value: burned, gas: 30_000}("");
        if (ok) _acct.totalBurned += burned;
        else _acct.pendingBurn += burned;
        emit SlashExecuted(slashId, seatId, amount, toReporter, burned);
    }

    /// @notice Cancel a pending slash caused by a software bug. Multisig only, only inside the
    ///         48 h window and only before the veto power sunsets. It cannot start or enlarge a
    ///         slash. The seat stays ejected and its keys stay banned.
    function veto(uint256 slashId) external onlyOwner {
        Slash storage sl = _slashes[slashId];
        if (sl.status != SLASH_PENDING) revert SlashNotPending();
        if (block.number >= sl.executableBlock || block.number >= sl.vetoSunsetBlock) revert VetoClosed();
        sl.status = SLASH_VETOED;
        _seats[sl.seatId].slashState = SLASH_NONE;
        emit SlashVetoed(slashId, sl.seatId);
    }

    /// @notice Withdraw reporter credits.
    function withdrawCredit(address payable to) external nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        uint256 amount = credits[msg.sender];
        if (amount == 0) revert NothingToPay();
        credits[msg.sender] = 0;
        _acct.totalCredits -= amount;
        _send(to, amount);
        emit CreditWithdrawn(msg.sender, to, amount);
    }

    /// @notice Retry sending burned FMX whose first transfer to 0x...dEaD failed. Permissionless.
    function flushBurn() external nonReentrant {
        uint256 amount = _acct.pendingBurn;
        if (amount == 0) revert NothingToPay();
        _acct.pendingBurn = 0;
        _acct.totalBurned += amount;
        _send(BURN_ADDRESS, amount);
        emit BurnFlushed(amount);
    }

    // =====================================================================================
    // Eligibility cursor
    // =====================================================================================

    /// @notice Advance the eligibility cursor by up to `maxSteps` seats. Every attestation call
    ///         runs it to completion before snapshotting; this lets anyone bring eligibleCount up
    ///         to date in between (for example after a long idle spell). Counting is idempotent.
    function sync(uint256 maxSteps) external {
        _sync(maxSteps);
    }

    /// Activation blocks are non-decreasing in seat id (the activation queue only moves forward),
    /// so eligibility blocks are too, and one cursor walking seat ids in order finds every seat
    /// that became eligible.
    function _sync(uint256 maxSteps) internal {
        uint256 cur = _eligCursor;
        uint256 n = seatCount;
        uint256 steps;
        while (cur <= n && steps < maxSteps) {
            Seat storage s = _seats[cur];
            if (uint256(s.activationBlock) + ELIGIBILITY_DELAY > block.number) break;
            if (s.status == BONDED && !s.jailed) _count(cur, s);
            unchecked {
                ++cur;
                ++steps;
            }
        }
        _eligCursor = cur;
    }

    function _count(uint256 seatId, Seat storage s) internal {
        if (s.countedSince != 0) return;
        s.countedSince = uint40(block.number);
        uint256 c = ++eligibleCount;
        emit SeatEligible(seatId, c);
    }

    function _uncount(uint256, Seat storage s) internal {
        if (s.countedSince == 0) return;
        s.countedSince = 0;
        --eligibleCount;
    }

    // =====================================================================================
    // Owner: pause, community-seat switch, timelocked parameters, ownership
    // =====================================================================================

    /// @notice Stop or resume new deposits. Exits, withdrawals, claims and slashes are never paused.
    function setSeatsPaused(bool paused) external onlyOwner {
        seatsPaused = paused;
        emit SeatsPausedSet(paused);
    }

    /// @notice Stop or resume attestations (emergency). While paused nobody can be jailed, and on
    ///         resume participation is measured afresh from the next checkpoint for every seat.
    function setAttestationsPaused(bool paused) external onlyOwner {
        attestationsPaused = paused;
        uint256 duty = globalDutyStartCp;
        if (!paused) {
            duty = block.number / CHECKPOINT_INTERVAL + 1;
            globalDutyStartCp = duty;
        }
        emit AttestationsPausedSet(paused, duty);
    }

    /// @notice Kill switch for Step 2: clear communitySeatsOpen at once. Setting it again needs
    ///         the 48 h timelock (P_OPEN_COMMUNITY_SEATS).
    function closeCommunitySeats() external onlyOwner {
        _flags &= ~uint256(1);
        emit CommunitySeatsSet(false);
    }

    function queueParam(uint8 param, uint256 value) external onlyOwner {
        uint256 eta = block.number + TIMELOCK;
        _validateParam(param, value, eta);
        bytes32 key = keccak256(abi.encode(param, value));
        if (timelockEta[key] != 0) revert AlreadyQueued();
        timelockEta[key] = eta;
        emit ParamQueued(param, value, eta);
    }

    function cancelParam(uint8 param, uint256 value) external onlyOwner {
        bytes32 key = keccak256(abi.encode(param, value));
        if (timelockEta[key] == 0) revert NotQueued();
        delete timelockEta[key];
        emit ParamCancelled(param, value);
    }

    function applyParam(uint8 param, uint256 value) external onlyOwner {
        bytes32 key = keccak256(abi.encode(param, value));
        uint256 eta = timelockEta[key];
        if (eta == 0) revert NotQueued();
        if (block.number < eta) revert TooEarly();
        delete timelockEta[key];
        _validateParam(param, value, block.number);
        if (param == P_MAX_SEATS) {
            maxSeats = value;
        } else if (param == P_REWARD_PER_ATTEST) {
            rewardPerAttest = value;
        } else if (param == P_ACTIVATIONS_PER_DAY) {
            activationsPerDay = value;
        } else if (param == P_OPEN_SEATS_BLOCK) {
            openSeatsBlock = value;
        } else if (param == P_OPEN_COMMUNITY_SEATS) {
            _flags |= 1;
            emit CommunitySeatsSet(true);
        } else {
            address a = address(uint160(value));
            bool d = param == P_DENY;
            denied[a] = d;
            emit DenySet(a, d);
        }
        emit ParamApplied(param, value);
    }

    /// Hard caps, checked when queued (against the block the change could take effect) and again
    /// when applied.
    function _validateParam(uint8 param, uint256 value, uint256 atBlock) internal view {
        if (param == P_MAX_SEATS) {
            if (value == 0 || value > HARD_MAX_SEATS || value < occupiedSeats) revert BadParam();
            if (atBlock < deployBlock + LAUNCH_PERIOD && value > LAUNCH_MAX_SEATS) revert BadParam();
            if (value * rewardPerAttest > BUDGET_PER_CHECKPOINT) revert BadParam();
        } else if (param == P_REWARD_PER_ATTEST) {
            if (value > MAX_REWARD_PER_ATTEST || maxSeats * value > BUDGET_PER_CHECKPOINT) revert BadParam();
        } else if (param == P_ACTIVATIONS_PER_DAY) {
            if (value == 0 || value > MAX_ACTIVATIONS_PER_DAY) revert BadParam();
        } else if (param == P_OPEN_SEATS_BLOCK) {
            if (openSeatsBlock != 0 || value == 0 || value % OPEN_SEATS_EPOCH != 0 || value <= atBlock) {
                revert BadParam();
            }
        } else if (param == P_OPEN_COMMUNITY_SEATS) {
            if (value != 1) revert BadParam();
        } else if (param == P_DENY || param == P_ALLOW) {
            if (value == 0 || value > type(uint160).max) revert BadParam();
        } else {
            revert BadParam();
        }
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotOwner();
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }

    // =====================================================================================
    // Views
    // =====================================================================================

    /// @notice Reward per accepted attestation right now: the base rate, halved from block
    ///         4,500,000 or from V (whichever comes first), and never above the budget guard
    ///         BUDGET_PER_CHECKPOINT (halved likewise) / maxSeats.
    function currentRewardPerAttest() public view returns (uint256 r) {
        r = rewardPerAttest;
        uint256 cap = BUDGET_PER_CHECKPOINT;
        if (halvingActive()) {
            r >>= 1;
            cap >>= 1;
        }
        uint256 perSeat = cap / maxSeats;
        if (r > perSeat) r = perSeat;
    }

    function halvingActive() public view returns (bool) {
        uint256 v = openSeatsBlock;
        return block.number >= HALVING_BLOCK || (v != 0 && block.number >= v);
    }

    /// @notice Latest checkpoint index (height / 200) whose inclusion window has closed.
    function lastClosedCheckpoint() public view returns (uint256) {
        if (block.number <= INCLUSION_END) return 0;
        return (block.number - INCLUSION_END - 1) / CHECKPOINT_INTERVAL;
    }

    function keyInfo(address key) external view returns (KeyInfo memory) {
        return _keys[key];
    }

    function checkpoint(uint256 height) external view returns (Checkpoint memory) {
        return _checkpoints[height];
    }

    function isCertified(uint256 height, bytes32 blockHash) external view returns (bool) {
        Checkpoint storage cp = _checkpoints[height];
        return cp.certified && cp.blockHash == blockHash;
    }

    /// @notice Did the seat attest checkpoint `height`? Used by the node's anti-slashing check.
    ///         Reliable for the last 511 checkpoints before the seat's latest attestation.
    function attested(uint256 seatId, uint256 height) external view returns (bool) {
        if (height % CHECKPOINT_INTERVAL != 0) return false;
        uint256 c = height / CHECKPOINT_INTERVAL;
        uint256 last = _seats[seatId].lastAttestedCp;
        if (c == 0 || c > last || c + RING <= last) return false;
        uint256 pos = c % RING;
        return (_bits[seatId][pos >> 8] >> (pos & 255)) & 1 == 1;
    }

    /// @notice Checkpoints attested among the last `n` closed checkpoints (n <= 511).
    function participation(uint256 seatId, uint256 n) external view returns (uint256) {
        if (n == 0 || n > MAX_PARTICIPATION_WINDOW) revert BadWindow();
        uint256 last = lastClosedCheckpoint();
        if (last == 0) return 0;
        uint256 from = last >= n ? last - n + 1 : 1;
        return _countBits(seatId, _seats[seatId].lastAttestedCp, from, last);
    }

    /// @notice Raw storage reads for ValidatorHubLens and other read-only tools (the same data
    ///         eth_getStorageAt returns). Seat, slash, enode, accounting and Step 2 slot views live
    ///         in the lens to keep this contract under the 24 KB code limit.
    function extsload(bytes32[] calldata slots) external view returns (bytes32[] memory values) {
        values = new bytes32[](slots.length);
        for (uint256 i; i < slots.length; ++i) {
            bytes32 slot = slots[i];
            bytes32 v;
            assembly {
                v := sload(slot)
            }
            values[i] = v;
        }
    }

    function communitySeatsOpen() public view returns (bool) {
        return _flags & 1 == 1;
    }

    // ---- digests ----

    function domainSeparator() public view returns (bytes32) {
        return block.chainid == _cachedChainId ? _cachedDomain : _buildDomain();
    }

    function attestationDigest(uint64 height, bytes32 blockHash) public view returns (bytes32) {
        return Sig.typedDataHash(domainSeparator(), keccak256(abi.encode(ATTESTATION_TYPEHASH, height, blockHash)));
    }

    function attesterKeyDigest(address seatOwner, address attester) public view returns (bytes32) {
        return Sig.typedDataHash(domainSeparator(), keccak256(abi.encode(ATTESTER_KEY_TYPEHASH, seatOwner, attester)));
    }

    /// Raw digest the node (devp2p) key signs, in the NodeRegistry.registerNode pattern.
    function enodeDigest(address seatOwner, address attester) public view returns (bytes32) {
        return keccak256(abi.encodePacked("FMX_VALIDATOR_NODE_V1", block.chainid, address(this), seatOwner, attester));
    }

    /// Raw digest the Step 2 signing key signs (PLAN 5.1).
    function signingKeyDigest(uint256 seatId, address key, address seatOwner) public view returns (bytes32) {
        return keccak256(abi.encodePacked("FERMINUX-SIGNKEY-V1", block.chainid, address(this), seatId, key, seatOwner));
    }

    // =====================================================================================
    // Internals
    // =====================================================================================

    function _buildDomain() internal view returns (bytes32) {
        return Sig.domainSeparator(NAME, VERSION, address(this));
    }

    function _ownedSeat(uint256 seatId) internal view returns (Seat storage s) {
        s = _seats[seatId];
        if (s.owner != msg.sender) revert NotSeatOwner();
    }

    function _checkAttester(address seatOwner, address attester, bytes calldata sig) internal view {
        if (attester == address(0) || attester == seatOwner) revert BadKey();
        if (_keys[attester].seatId != 0) revert KeyUsed();
        if (Sig.recover(attesterKeyDigest(seatOwner, attester), sig) != attester) revert BadPossession();
    }

    function _setEnode(uint256 seatId, address seatOwner, address attester, bytes calldata pubkey, bytes calldata sig)
        internal
    {
        if (pubkey.length != 64) revert BadEnode();
        address nodeAddress = address(uint160(uint256(keccak256(pubkey))));
        if (Sig.recover(enodeDigest(seatOwner, attester), sig) != nodeAddress) revert BadPossession();
        bytes32[2] storage e = _enode[seatId];
        e[0] = bytes32(pubkey[0:32]);
        e[1] = bytes32(pubkey[32:64]);
        emit EnodeSet(seatId, nodeAddress, pubkey);
    }

    /// Activation queue: a seat activates 24 h after deposit, in a day bucket (12,343 blocks) that
    /// has fewer than `activationsPerDay` activations; buckets only move forward.
    function _scheduleActivation() internal returns (uint256 act) {
        uint256 earliest = block.number + ACTIVATION_DELAY;
        uint256 day = earliest / BLOCKS_PER_DAY;
        uint256 qd = _queueDay;
        uint256 qc = _queueCount;
        if (day <= qd) {
            day = qd;
            if (qc >= activationsPerDay) {
                day = qd + 1;
                qc = 0;
            }
        } else {
            qc = 0;
        }
        act = day * BLOCKS_PER_DAY;
        if (act < earliest) act = earliest;
        _queueDay = day;
        _queueCount = qc + 1;
    }

    /// Move a bonded seat into the 14-day unbond: rewards stop, it leaves the certification count
    /// and the signing list, and its attester key stops attesting.
    function _eject(uint256 seatId, Seat storage s) internal {
        s.status = EXITING;
        uint256 end = block.number + UNBONDING_PERIOD;
        s.unbondEndBlock = uint40(end);
        --occupiedSeats;
        _keys[s.attester].active = false;
        _uncount(seatId, s);
        _disqualify(seatId, s);
        emit ExitRequested(seatId, end);
    }

    function _disqualify(uint256 seatId, Seat storage s) internal {
        if (!s.qualified) return;
        address key = s.signingKey;
        uint256 idx = _signingIndex[key] - 1;
        uint256 lastIdx = _signingKeys.length - 1;
        if (idx != lastIdx) {
            address moved = _signingKeys[lastIdx];
            _signingKeys[idx] = moved;
            _signingIndex[moved] = idx + 1;
        }
        _signingKeys.pop();
        delete _signingIndex[key];
        _countedBond[key] = 0;
        _qualifiedAt[key] = 0;
        s.qualified = false;
        emit Disqualified(seatId, key);
    }

    /// Participation over the last `window` closed checkpoints; `covered` is false unless the seat
    /// was on duty (active, not jailed, attestations not paused) for the whole window.
    function _participationCheck(uint256 seatId, Seat storage s, uint256 window)
        internal
        view
        returns (bool covered, uint256 count)
    {
        if (block.number < s.activationBlock) return (false, 0);
        uint256 last = lastClosedCheckpoint();
        if (last < window) return (false, 0);
        uint256 from = last - window + 1;
        uint256 duty = s.dutyStartCp;
        uint256 g = globalDutyStartCp;
        if (g > duty) duty = g;
        if (duty > from) return (false, 0);
        return (true, _countBits(seatId, s.lastAttestedCp, from, last));
    }

    /// Set bit `c` in the seat's ring and clear the bits of the checkpoints it skipped since `last`,
    /// so every bit in (c - 512, c] is exact afterwards.
    function _markParticipation(uint256 seatId, uint256 last, uint256 c) internal {
        uint256[2] storage bits = _bits[seatId];
        uint256 w0 = bits[0];
        uint256 w1 = bits[1];
        uint256 o0 = w0;
        uint256 o1 = w1;
        if (last == 0 || c - last >= RING) {
            w0 = 0;
            w1 = 0;
        } else if (c - last > 1) {
            (uint256 m0, uint256 m1) = _ringMask(last + 1, c - last - 1);
            w0 &= ~m0;
            w1 &= ~m1;
        }
        uint256 pos = c % RING;
        if (pos < 256) w0 |= uint256(1) << pos;
        else w1 |= uint256(1) << (pos - 256);
        if (w0 != o0) bits[0] = w0;
        if (w1 != o1) bits[1] = w1;
    }

    /// Attested checkpoints in [from, to]; bits after the seat's last attestation count as 0.
    function _countBits(uint256 seatId, uint256 last, uint256 from, uint256 to) internal view returns (uint256) {
        if (last < from) return 0;
        if (to > last) to = last;
        (uint256 m0, uint256 m1) = _ringMask(from, to - from + 1);
        uint256[2] storage bits = _bits[seatId];
        return _popcount(bits[0] & m0) + _popcount(bits[1] & m1);
    }

    /// Mask of `count` consecutive ring positions starting at checkpoint `from` (count < 512).
    function _ringMask(uint256 from, uint256 count) internal pure returns (uint256 m0, uint256 m1) {
        uint256 p = from % RING;
        uint256 end = p + count;
        if (end <= RING) return _span(p, end);
        (m0, m1) = _span(p, RING);
        (uint256 a0, uint256 a1) = _span(0, end - RING);
        return (m0 | a0, m1 | a1);
    }

    function _span(uint256 lo, uint256 hi) internal pure returns (uint256, uint256) {
        return (
            _wordSpan(lo < 256 ? lo : 256, hi < 256 ? hi : 256),
            _wordSpan(lo > 256 ? lo - 256 : 0, hi > 256 ? hi - 256 : 0)
        );
    }

    function _wordSpan(uint256 lo, uint256 hi) internal pure returns (uint256) {
        if (hi <= lo) return 0;
        uint256 n = hi - lo;
        if (n == 256) return type(uint256).max;
        return ((uint256(1) << n) - 1) << lo;
    }

    function _popcount(uint256 x) internal pure returns (uint256) {
        unchecked {
            x = x - ((x >> 1) & 0x5555555555555555555555555555555555555555555555555555555555555555);
            x = (x & 0x3333333333333333333333333333333333333333333333333333333333333333)
                + ((x >> 2) & 0x3333333333333333333333333333333333333333333333333333333333333333);
            x = (x + (x >> 4)) & 0x0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f;
            x = (x + (x >> 8)) & 0x00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff;
            x = (x + (x >> 16)) & 0x0000ffff0000ffff0000ffff0000ffff0000ffff0000ffff0000ffff0000ffff;
            x = (x + (x >> 32)) & 0x00000000ffffffff00000000ffffffff00000000ffffffff00000000ffffffff;
            x = (x + (x >> 64)) & 0x0000000000000000ffffffffffffffff0000000000000000ffffffffffffffff;
            x = (x + (x >> 128)) & 0x00000000000000000000000000000000ffffffffffffffffffffffffffffffff;
            return x;
        }
    }

    function _send(address to, uint256 amount) internal {
        (bool ok,) = payable(to).call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
