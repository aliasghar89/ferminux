// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title FMXStaking — native FMX staking vault (Ferminux chain 3961)
 * @notice Four-tier weighted staking against a prefunded, fail-closed reward
 *         pool, per staking/DESIGN.md:
 *
 *           Tier            Lock                       Weight   APY cap
 *           Flexible        none                       1.0x     10%
 *           Locked-90       90 days                    1.5x     15%
 *           Locked-180      180 days                   2.0x     20%
 *           Validator-track to block 4,680,000         2.0x     20%  (base)
 *                           (fork + ~15 days)          3.0x     30%  (uptime-boosted)
 *
 *         Reward economics:
 *           - Rewards accrue continuously via an accumulator (accRewardPerUnit),
 *             NOT distribution snapshots — depositing just before a funding or
 *             a claim earns nothing extra; only stake-seconds earn.
 *           - Weighted units = principal (wei) x tier weight in tenths
 *             (10 / 15 / 20 / 30). Each unit accrues at 1%/year of a tenth,
 *             i.e. a 1.0x-weight stake earns exactly the 10%/yr tier cap.
 *           - Global budget: at most `dripPerYear` FMX is released per year
 *             (hard-capped at 1,200,000 FMX/yr in-contract). Effective rate is
 *             min(tier-cap accrual, drip cap), whichever binds.
 *           - FAIL-CLOSED: accrual is additionally capped by the unallocated
 *             pool balance. When the pool hits zero, accrual stops — principal
 *             and already-accrued rewards remain fully withdrawable/claimable.
 *             The contract can never owe more than it actually holds.
 *
 *         Exit rules:
 *           - Every unstake passes a 7-day cooldown; nothing accrues during it.
 *           - Emergency exit is available at ANY time, even while paused:
 *             it forfeits all unclaimed rewards (back into the pool) and, only
 *             if the position's lock has not yet expired, a 5% principal
 *             penalty (also into the pool). Principal is then withdrawable
 *             after the cooldown, unconditionally: the withdraw path performs
 *             no reward math, no external calls, and has no pause check —
 *             a staker can never be locked out of their own money.
 *
 *         Governance (owner = MinimalMultisig):
 *           - Deposits are pausable; withdrawals, claims and emergency exits
 *             are NOT pausable, ever.
 *           - The owner can never move staked principal. It can move only
 *             unallocated pool funds (timelocked defund) and parameters
 *             (48h timelock), and every change is evented.
 *           - Premine wallets are deny-listed from staking at deploy.
 *
 * STATUS (2026-09-26): not deployed on chain 3961. Chain 3961 runs Clique
 *         proof-of-authority with an authorised signer set; the stake-based
 *         hand-off at FORK_BLOCK that the surface below was written for was
 *         dropped, and no client reads it. Staking here is a yield product only.
 *
 * FORMER MIGRATION SURFACE (designed for a hand-off that was dropped):
 *           - getPosition(id): owner / tier / amount (bond) / state / boosted.
 *           - MIN_VALIDATOR_STAKE, FORK_BLOCK, VALIDATOR_LOCK_BLOCK constants.
 *         NodeRegistry.getValidators() composes these into a validator list;
 *         see NodeRegistry.sol.
 *
 * Self-contained: no external imports, compiles standalone with solc >=0.8.24,
 * evm_version = paris (zero PUSH0 — ferminux-geth is pre-Shanghai).
 */
contract FMXStaking {
    // ---------------------------------------------------------------- Types
    enum Tier {
        Flexible,
        Locked90,
        Locked180,
        Validator
    }

    enum PositionState {
        Active,
        Cooldown,
        Withdrawn
    }

    struct Position {
        address owner;
        Tier tier;
        PositionState state;
        bool boosted; // Validator tier only: uptime-gated 2.0x -> 3.0x
        uint64 startTime;
        uint64 lockEnd; // timestamp lock (Locked90/180); 0 for Flexible/Validator
        uint64 cooldownEnd; // set on unstake request / emergency exit
        uint128 amount; // principal, wei
        uint128 units; // amount x weight-tenths while Active; 0 otherwise
        uint256 rewardDebt; // units x accRewardPerUnit / PRECISION at last touch
        uint256 banked; // rewards banked (claimable) but not yet transferred
    }

    // ------------------------------------------------------------ Constants
    uint256 public constant PRECISION = 1e18;
    uint256 public constant YEAR = 365 days;
    uint256 public constant COOLDOWN = 7 days;
    uint256 public constant LOCK_90 = 90 days;
    uint256 public constant LOCK_180 = 180 days;

    /// @notice Block of the dropped stake-based hand-off (design section 5). Slashing hooks are inert before it.
    uint256 public constant FORK_BLOCK = 4_500_000;
    /// @notice Validator-track stake is locked until this block (fork + ~15 days).
    uint256 public constant VALIDATOR_LOCK_BLOCK = 4_680_000;

    /// @notice Minimum bond for a Validator-track position (per registered node).
    uint256 public constant MIN_VALIDATOR_STAKE = 25_000 ether;

    /// @notice Hard cap on the reward drip — 1,200,000 FMX/yr (design section 1).
    uint256 public constant MAX_DRIP_PER_YEAR = 1_200_000 ether;

    /// @notice Principal penalty for breaking an unexpired lock: 5%.
    uint256 public constant EARLY_EXIT_PENALTY_BPS = 500;
    /// @notice Maximum slash per event (post-fork double-sign): 5% of bond.
    uint256 public constant MAX_SLASH_BPS = 500;
    /// @notice Lifetime slash cap per position: 10% of the ORIGINAL bond, ever.
    ///         The adjudicator is a trusted key, not a proof (design section 4);
    ///         this cap bounds what that trust can ever cost an operator.
    uint256 public constant MAX_TOTAL_SLASH_BPS = 1_000;
    /// @notice Minimum time between slashes of the same position. Keyed by
    ///         positionId (not node id) so deregister/re-register games in the
    ///         registry can never reset it.
    uint256 public constant SLASH_COOLDOWN = 7 days;
    uint256 public constant BPS = 10_000;

    /// @notice All parameter changes wait 48 hours (design section 6).
    uint256 public constant TIMELOCK = 48 hours;

    // Weight in tenths per tier: 1.0x / 1.5x / 2.0x / 2.0x (3.0x boosted).
    uint256 internal constant W_FLEX = 10;
    uint256 internal constant W_90 = 15;
    uint256 internal constant W_180 = 20;
    uint256 internal constant W_VAL = 20;
    uint256 internal constant W_VAL_BOOST = 30;

    // ------------------------------------------------------------ Ownership
    address public owner;
    address public pendingOwner;

    // ----------------------------------------------------------- Vault state
    bool public paused; // deposits only — never withdrawals
    address public nodeRegistry; // sole caller of setBoost/slashBond

    /// @notice Budget: FMX released per year at most. <= MAX_DRIP_PER_YEAR.
    uint256 public dripPerYear;

    /// @notice Unallocated reward pool (funds not yet accrued to stakers).
    uint256 public rewardPool;
    /// @notice Principal owed to stakers (active + cooldown positions).
    uint256 public totalPrincipal;
    /// @notice Sum of weighted units across active positions.
    uint256 public totalUnits;

    uint256 public accRewardPerUnit; // scaled by PRECISION
    uint256 public lastAccrual;

    Position[] internal _positions;
    mapping(address => uint256[]) internal _ownerPositions;

    /// @notice Principal at stake time, per position. Fixed forever at stake();
    ///         the base for the lifetime slash cap (MAX_TOTAL_SLASH_BPS).
    mapping(uint256 => uint256) public originalBond;
    /// @notice Cumulative FMX slashed from a position over its lifetime.
    mapping(uint256 => uint256) public slashedTotal;
    /// @notice Timestamp of the last slash of a position (0 = never slashed).
    mapping(uint256 => uint256) public lastSlashAt;

    /// @notice Premine wallets barred from staking (design section 3).
    mapping(address => bool) public denied;

    /// @notice Timelock queue: action key => eta (0 = not queued).
    mapping(bytes32 => uint256) public queuedEta;

    uint256 private _entered; // reentrancy guard

    // --------------------------------------------------------------- Events
    event Staked(uint256 indexed positionId, address indexed staker, Tier tier, uint256 amount, uint256 units);
    event UnstakeRequested(uint256 indexed positionId, uint256 cooldownEnd);
    event Withdrawn(uint256 indexed positionId, address indexed staker, uint256 amount);
    event Claimed(uint256 indexed positionId, address indexed staker, uint256 amount);
    event EmergencyExited(
        uint256 indexed positionId, uint256 forfeitedRewards, uint256 principalPenalty, uint256 cooldownEnd
    );
    event BoostSet(uint256 indexed positionId, bool boosted);
    event BondSlashed(uint256 indexed positionId, uint256 amount, address indexed recipient);
    event RewardsFunded(address indexed funder, uint256 amount, uint256 poolBalance);
    event PoolDefunded(address indexed to, uint256 amount, uint256 poolBalance);
    event DepositsPaused(address account);
    event DepositsUnpaused(address account);
    event DripPerYearSet(uint256 oldValue, uint256 newValue);
    event NodeRegistrySet(address oldRegistry, address newRegistry);
    event DenySet(address indexed account, bool deniedFlag);
    event ParamQueued(bytes32 indexed key, uint256 eta);
    event ParamCancelled(bytes32 indexed key);
    event OwnerTransferStarted(address indexed newOwner);
    event OwnerTransferred(address indexed oldOwner, address indexed newOwner);

    // ------------------------------------------------------------ Modifiers
    modifier onlyOwner() {
        require(msg.sender == owner, "STK: not owner");
        _;
    }

    modifier onlyRegistry() {
        require(msg.sender == nodeRegistry && nodeRegistry != address(0), "STK: not registry");
        _;
    }

    modifier positionExists(uint256 positionId) {
        require(positionId < _positions.length, "STK: no such position");
        _;
    }

    modifier onlyPositionOwner(uint256 positionId) {
        require(_positions[positionId].owner == msg.sender, "STK: not position owner");
        _;
    }

    modifier nonReentrant() {
        require(_entered == 0, "STK: reentrancy");
        _entered = 1;
        _;
        _entered = 0;
    }

    // ---------------------------------------------------------- Constructor
    /// @param _owner   the MinimalMultisig
    /// @param _denied  premine wallets barred from earning (design section 3)
    constructor(address _owner, address[] memory _denied) {
        require(_owner != address(0), "STK: zero owner");
        owner = _owner;
        dripPerYear = MAX_DRIP_PER_YEAR;
        lastAccrual = block.timestamp;
        for (uint256 i = 0; i < _denied.length; i++) {
            require(_denied[i] != address(0), "STK: zero deny entry");
            denied[_denied[i]] = true;
            emit DenySet(_denied[i], true);
        }
        emit OwnerTransferred(address(0), _owner);
        emit DripPerYearSet(0, MAX_DRIP_PER_YEAR);
    }

    // ------------------------------------------------------------- Accrual
    /**
     * @dev Continuous accumulator. Per elapsed second the vault releases
     *          min(totalUnits x 1%/tenth-year, dripPerYear/YEAR)
     *      further capped by the unallocated pool (fail-closed). The released
     *      amount raises accRewardPerUnit; the pool is charged the CEILING of
     *      what that raise can ever entitle stakers to, so cumulative floored
     *      entitlements can never exceed what was charged — strict solvency,
     *      at the cost of at most 1 wei of pool dust per accrual segment.
     *      Pure arithmetic — cannot revert.
     */
    function _accrue() internal {
        uint256 nowTs = block.timestamp;
        if (nowTs == lastAccrual) return;
        if (totalUnits == 0 || rewardPool == 0) {
            lastAccrual = nowTs;
            return;
        }
        uint256 dt = nowTs - lastAccrual;
        uint256 ideal = (totalUnits * dt) / (100 * YEAR); // tier-cap accrual
        uint256 budget = (dripPerYear * dt) / YEAR; // drip cap
        uint256 amount = ideal < budget ? ideal : budget;
        if (amount > rewardPool) amount = rewardPool; // fail-closed
        uint256 inc = (amount * PRECISION) / totalUnits;
        uint256 charged = (inc * totalUnits + PRECISION - 1) / PRECISION; // ceil <= amount <= pool
        accRewardPerUnit += inc;
        rewardPool -= charged;
        lastAccrual = nowTs;
    }

    function _weight(Tier tier, bool boosted) internal pure returns (uint256) {
        if (tier == Tier.Flexible) return W_FLEX;
        if (tier == Tier.Locked90) return W_90;
        if (tier == Tier.Locked180) return W_180;
        return boosted ? W_VAL_BOOST : W_VAL;
    }

    function _lockExpired(Position storage p) internal view returns (bool) {
        if (p.tier == Tier.Flexible) return true;
        if (p.tier == Tier.Validator) return block.number >= VALIDATOR_LOCK_BLOCK;
        return block.timestamp >= p.lockEnd;
    }

    /// @dev Move a position's earned-but-unbanked rewards into `banked`.
    function _bank(Position storage p) internal {
        uint256 accrued = (uint256(p.units) * accRewardPerUnit) / PRECISION;
        p.banked += accrued - p.rewardDebt;
        p.rewardDebt = accrued;
    }

    // -------------------------------------------------------------- Staking
    /// @notice Stake native FMX into `tier`. Validator tier requires >= 25,000 FMX.
    function stake(Tier tier) external payable returns (uint256 positionId) {
        require(!paused, "STK: deposits paused");
        require(!denied[msg.sender], "STK: staker denied");
        require(msg.value > 0, "STK: zero amount");
        if (tier == Tier.Validator) {
            require(msg.value >= MIN_VALIDATOR_STAKE, "STK: below validator minimum");
        }
        _accrue();

        uint256 units = msg.value * _weight(tier, false);
        uint64 lockEnd = 0;
        if (tier == Tier.Locked90) lockEnd = uint64(block.timestamp + LOCK_90);
        if (tier == Tier.Locked180) lockEnd = uint64(block.timestamp + LOCK_180);

        positionId = _positions.length;
        _positions.push(
            Position({
                owner: msg.sender,
                tier: tier,
                state: PositionState.Active,
                boosted: false,
                startTime: uint64(block.timestamp),
                lockEnd: lockEnd,
                cooldownEnd: 0,
                amount: uint128(msg.value),
                units: uint128(units),
                rewardDebt: (units * accRewardPerUnit) / PRECISION,
                banked: 0
            })
        );
        _ownerPositions[msg.sender].push(positionId);
        originalBond[positionId] = msg.value;
        totalUnits += units;
        totalPrincipal += msg.value;
        emit Staked(positionId, msg.sender, tier, msg.value, units);
    }

    /// @notice Begin the 7-day cooldown. Requires the lock to have expired.
    ///         Accrued rewards are banked and stay claimable; accrual stops.
    function requestUnstake(uint256 positionId) external positionExists(positionId) onlyPositionOwner(positionId) {
        Position storage p = _positions[positionId];
        require(p.state == PositionState.Active, "STK: not active");
        require(_lockExpired(p), "STK: lock not expired");
        _accrue();
        _bank(p);
        totalUnits -= p.units;
        p.units = 0;
        p.rewardDebt = 0;
        p.boosted = false;
        p.state = PositionState.Cooldown;
        p.cooldownEnd = uint64(block.timestamp + COOLDOWN);
        emit UnstakeRequested(positionId, p.cooldownEnd);
    }

    /**
     * @notice Withdraw principal after the cooldown. Deliberately minimal:
     *         no pause check, no reward math, no dependence on the pool or the
     *         registry — this path can never be blocked by any other state.
     */
    function withdraw(uint256 positionId)
        external
        positionExists(positionId)
        onlyPositionOwner(positionId)
        nonReentrant
    {
        Position storage p = _positions[positionId];
        require(p.state == PositionState.Cooldown, "STK: not in cooldown");
        require(block.timestamp >= p.cooldownEnd, "STK: cooldown not over");
        uint256 amount = p.amount;
        p.amount = 0;
        p.state = PositionState.Withdrawn;
        totalPrincipal -= amount;
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "STK: withdraw transfer failed");
        emit Withdrawn(positionId, msg.sender, amount);
    }

    /// @notice Claim accrued rewards. Does NOT unstake. Works in cooldown and
    ///         after withdrawal (banked rewards survive both).
    function claim(uint256 positionId)
        external
        positionExists(positionId)
        onlyPositionOwner(positionId)
        nonReentrant
        returns (uint256 amount)
    {
        _accrue();
        Position storage p = _positions[positionId];
        _bank(p);
        amount = p.banked;
        require(amount > 0, "STK: nothing to claim");
        p.banked = 0;
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "STK: claim transfer failed");
        emit Claimed(positionId, msg.sender, amount);
    }

    /**
     * @notice Emergency exit — available at ANY time, in any vault state,
     *         including while deposits are paused. Forfeits ALL unclaimed
     *         rewards back into the pool. If the position's lock has not yet
     *         expired a 5% principal penalty also goes to the pool (locks must
     *         bind — design section 3). Principal (less any penalty) becomes
     *         withdrawable after the normal 7-day cooldown.
     */
    function emergencyExit(uint256 positionId) external positionExists(positionId) onlyPositionOwner(positionId) {
        Position storage p = _positions[positionId];
        require(p.state == PositionState.Active, "STK: not active");
        _accrue();
        _bank(p);
        uint256 forfeited = p.banked;
        p.banked = 0;

        uint256 penalty = 0;
        if (!_lockExpired(p)) {
            penalty = (uint256(p.amount) * EARLY_EXIT_PENALTY_BPS) / BPS;
            p.amount -= uint128(penalty);
            totalPrincipal -= penalty;
        }
        rewardPool += forfeited + penalty;

        totalUnits -= p.units;
        p.units = 0;
        p.rewardDebt = 0;
        p.boosted = false;
        p.state = PositionState.Cooldown;
        p.cooldownEnd = uint64(block.timestamp + COOLDOWN);
        emit EmergencyExited(positionId, forfeited, penalty, p.cooldownEnd);
    }

    // ------------------------------------------------- Registry-only actions
    /**
     * @notice Toggle the uptime boost (2.0x <-> 3.0x) on a Validator-track
     *         position. Only the NodeRegistry (watchtower pipeline) may call.
     *         This is the FULL extent of the oracle's power over the vault:
     *         it can move one tier between two weights and nothing else.
     * @return changed false (no-op) if the position is not active or already
     *         in the requested state — never reverts on state, so epoch
     *         finalization loops cannot be bricked by a single exited position.
     */
    function setBoost(uint256 positionId, bool boosted)
        external
        onlyRegistry
        positionExists(positionId)
        returns (bool changed)
    {
        Position storage p = _positions[positionId];
        require(p.tier == Tier.Validator, "STK: not validator tier");
        if (p.state != PositionState.Active || p.boosted == boosted) return false;
        _accrue();
        _bank(p);
        uint256 newUnits = uint256(p.amount) * _weight(Tier.Validator, boosted);
        totalUnits = totalUnits - p.units + newUnits;
        p.units = uint128(newUnits);
        p.rewardDebt = (newUnits * accRewardPerUnit) / PRECISION;
        p.boosted = boosted;
        emit BoostSet(positionId, boosted);
        return true;
    }

    /**
     * @notice SLASHING HOOK for the dropped hand-off (inert until block 4,500,000).
     *         Slashes at most 5% of a Validator-track bond to `recipient`
     *         (the SystemRewards contract, once it exists). Callable only by
     *         the NodeRegistry on adjudicated double-sign evidence.
     *
     *         The adjudicator is a TRUSTED key, so the vault itself bounds the
     *         damage that trust can do to any position, unconditionally:
     *           - per event:   <= 5% of the current bond (MAX_SLASH_BPS);
     *           - lifetime:    <= 10% of the ORIGINAL bond (MAX_TOTAL_SLASH_BPS)
     *                          — the final event is clamped to the remainder;
     *           - cadence:     >= 7 days between slashes of the same position
     *                          (SLASH_COOLDOWN), giving the multisig time to
     *                          rotate a misbehaving adjudicator before repeat
     *                          damage lands.
     *         All three are keyed by positionId and enforced HERE, so no
     *         registry behaviour (deregister/re-register, even a registry
     *         swap) can reset them. Full confiscation is impossible: a
     *         position always retains >= 90% of its original bond less any
     *         early-exit penalty.
     */
    function slashBond(uint256 positionId, uint256 bps, address recipient)
        external
        onlyRegistry
        positionExists(positionId)
        nonReentrant
        returns (uint256 slashed)
    {
        require(block.number >= FORK_BLOCK, "STK: slashing inert pre-fork");
        require(bps > 0 && bps <= MAX_SLASH_BPS, "STK: slash bps out of bounds");
        require(recipient != address(0), "STK: zero slash recipient");
        Position storage p = _positions[positionId];
        require(p.tier == Tier.Validator, "STK: not validator tier");
        require(p.state != PositionState.Withdrawn, "STK: position withdrawn");
        require(p.amount > 0, "STK: nothing to slash");
        uint256 last = lastSlashAt[positionId];
        require(last == 0 || block.timestamp >= last + SLASH_COOLDOWN, "STK: slash cooldown active");
        uint256 lifetimeCap = (originalBond[positionId] * MAX_TOTAL_SLASH_BPS) / BPS;
        uint256 already = slashedTotal[positionId];
        require(already < lifetimeCap, "STK: lifetime slash cap reached");
        _accrue();
        slashed = (uint256(p.amount) * bps) / BPS;
        if (already + slashed > lifetimeCap) slashed = lifetimeCap - already; // clamp final event
        require(slashed > 0, "STK: nothing to slash");
        slashedTotal[positionId] = already + slashed;
        lastSlashAt[positionId] = block.timestamp;
        if (p.state == PositionState.Active) {
            _bank(p);
            uint256 newUnits = uint256(p.amount - uint128(slashed)) * _weight(Tier.Validator, p.boosted);
            totalUnits = totalUnits - p.units + newUnits;
            p.units = uint128(newUnits);
            p.rewardDebt = (newUnits * accRewardPerUnit) / PRECISION;
        }
        p.amount -= uint128(slashed);
        totalPrincipal -= slashed;
        (bool ok,) = recipient.call{value: slashed}("");
        require(ok, "STK: slash transfer failed");
        emit BondSlashed(positionId, slashed, recipient);
    }

    // -------------------------------------------------------------- Funding
    /// @notice Add FMX to the reward pool. Anyone may fund. Funding does NOT
    ///         bump the accumulator — it only extends the runway, so there is
    ///         no distribution event to snipe.
    function fundRewards() external payable {
        require(msg.value > 0, "STK: zero funding");
        _accrue();
        rewardPool += msg.value;
        emit RewardsFunded(msg.sender, msg.value, rewardPool);
    }

    // ------------------------------------------- Owner actions (immediate)
    /// @notice Pause deposits. Emergency response — immediate, owner-only.
    ///         Withdrawals, claims and emergency exits are never pausable.
    function pauseDeposits() external onlyOwner {
        require(!paused, "STK: already paused");
        paused = true;
        emit DepositsPaused(msg.sender);
    }

    function unpauseDeposits() external onlyOwner {
        require(paused, "STK: not paused");
        paused = false;
        emit DepositsUnpaused(msg.sender);
    }

    /// @notice One-time registry wiring at deployment (before the system is
    ///         live). Any later change goes through the 48h timelock.
    function initNodeRegistry(address registry) external onlyOwner {
        require(nodeRegistry == address(0), "STK: registry already set");
        require(registry != address(0), "STK: zero registry");
        nodeRegistry = registry;
        emit NodeRegistrySet(address(0), registry);
    }

    /// @notice Two-step owner transfer (multisig rotation).
    function transferOwner(address newOwner) external onlyOwner {
        require(newOwner != address(0), "STK: zero new owner");
        pendingOwner = newOwner;
        emit OwnerTransferStarted(newOwner);
    }

    function acceptOwner() external {
        require(msg.sender == pendingOwner, "STK: not pending owner");
        emit OwnerTransferred(owner, pendingOwner);
        owner = pendingOwner;
        pendingOwner = address(0);
    }

    // --------------------------------------- Owner actions (48h timelocked)
    function _queue(bytes32 key) internal {
        require(queuedEta[key] == 0, "STK: already queued");
        queuedEta[key] = block.timestamp + TIMELOCK;
        emit ParamQueued(key, queuedEta[key]);
    }

    function _consume(bytes32 key) internal {
        uint256 eta = queuedEta[key];
        require(eta != 0, "STK: not queued");
        require(block.timestamp >= eta, "STK: timelock not elapsed");
        delete queuedEta[key];
    }

    function cancelQueued(bytes32 key) external onlyOwner {
        require(queuedEta[key] != 0, "STK: not queued");
        delete queuedEta[key];
        emit ParamCancelled(key);
    }

    function dripKey(uint256 newDrip) public pure returns (bytes32) {
        return keccak256(abi.encode("STK_DRIP", newDrip));
    }

    function queueSetDripPerYear(uint256 newDrip) external onlyOwner {
        require(newDrip <= MAX_DRIP_PER_YEAR, "STK: drip above hard cap");
        _queue(dripKey(newDrip));
    }

    function applySetDripPerYear(uint256 newDrip) external onlyOwner {
        require(newDrip <= MAX_DRIP_PER_YEAR, "STK: drip above hard cap");
        _consume(dripKey(newDrip));
        _accrue(); // settle at the old rate first
        emit DripPerYearSet(dripPerYear, newDrip);
        dripPerYear = newDrip;
    }

    function registryKey(address registry) public pure returns (bytes32) {
        return keccak256(abi.encode("STK_REGISTRY", registry));
    }

    function queueSetNodeRegistry(address registry) external onlyOwner {
        require(registry != address(0), "STK: zero registry");
        _queue(registryKey(registry));
    }

    function applySetNodeRegistry(address registry) external onlyOwner {
        _consume(registryKey(registry));
        emit NodeRegistrySet(nodeRegistry, registry);
        nodeRegistry = registry;
    }

    function denyKey(address account, bool deniedFlag) public pure returns (bytes32) {
        return keccak256(abi.encode("STK_DENY", account, deniedFlag));
    }

    function queueSetDenied(address account, bool deniedFlag) external onlyOwner {
        require(account != address(0), "STK: zero deny entry");
        _queue(denyKey(account, deniedFlag));
    }

    function applySetDenied(address account, bool deniedFlag) external onlyOwner {
        _consume(denyKey(account, deniedFlag));
        denied[account] = deniedFlag;
        emit DenySet(account, deniedFlag);
    }

    function defundKey(address to, uint256 amount) public pure returns (bytes32) {
        return keccak256(abi.encode("STK_DEFUND", to, amount));
    }

    /// @notice Recover UNALLOCATED pool funds (e.g. when the programme ends).
    ///         Can never touch principal or already-accrued rewards.
    function queueDefund(address to, uint256 amount) external onlyOwner {
        require(to != address(0), "STK: zero defund target");
        require(amount > 0, "STK: zero defund amount");
        _queue(defundKey(to, amount));
    }

    function applyDefund(address to, uint256 amount) external onlyOwner nonReentrant {
        _consume(defundKey(to, amount));
        _accrue(); // stakers are owed accrual up to this second first
        require(amount <= rewardPool, "STK: exceeds unallocated pool");
        rewardPool -= amount;
        (bool ok,) = to.call{value: amount}("");
        require(ok, "STK: defund transfer failed");
        emit PoolDefunded(to, amount, rewardPool);
    }

    // ---------------------------------------------------------------- Views
    function positionCount() external view returns (uint256) {
        return _positions.length;
    }

    /// @notice Former migration surface — NodeRegistry.getValidators() reads
    ///         owner/tier/state/amount/boosted from here to build the set.
    function getPosition(uint256 positionId) external view positionExists(positionId) returns (Position memory) {
        return _positions[positionId];
    }

    function positionsOf(address account) external view returns (uint256[] memory) {
        return _ownerPositions[account];
    }

    /// @dev Accumulator as it would be after settling to `block.timestamp`.
    function _simulatedAcc() internal view returns (uint256) {
        if (block.timestamp == lastAccrual || totalUnits == 0 || rewardPool == 0) return accRewardPerUnit;
        uint256 dt = block.timestamp - lastAccrual;
        uint256 ideal = (totalUnits * dt) / (100 * YEAR);
        uint256 budget = (dripPerYear * dt) / YEAR;
        uint256 amount = ideal < budget ? ideal : budget;
        if (amount > rewardPool) amount = rewardPool;
        return accRewardPerUnit + (amount * PRECISION) / totalUnits;
    }

    /// @notice Claimable rewards for a position right now.
    function pendingRewards(uint256 positionId) external view positionExists(positionId) returns (uint256) {
        Position storage p = _positions[positionId];
        return p.banked + (uint256(p.units) * _simulatedAcc()) / PRECISION - p.rewardDebt;
    }

    /// @notice Current annual outlay in FMX/yr — min(tier caps, drip), zero if
    ///         the pool is empty. The UI shows this and the runway.
    function outlayPerYear() public view returns (uint256) {
        if (totalUnits == 0 || rewardPool == 0) return 0;
        uint256 ideal = totalUnits / 100;
        return ideal < dripPerYear ? ideal : dripPerYear;
    }

    /// @notice Seconds until the pool is exhausted at the current outlay.
    ///         type(uint256).max when nothing is being paid out.
    function poolRunwaySeconds() external view returns (uint256) {
        uint256 outlay = outlayPerYear();
        if (outlay == 0) return type(uint256).max;
        return (rewardPool * YEAR) / outlay;
    }

    /// @notice Fraction (bps) of the tier-cap APY currently payable: 10000
    ///         until the drip cap binds, then pro-rata; 0 with an empty pool.
    function effectiveRateBps() external view returns (uint256) {
        if (totalUnits == 0) return BPS;
        if (rewardPool == 0) return 0;
        uint256 ideal = totalUnits / 100;
        if (ideal <= dripPerYear) return BPS;
        return (dripPerYear * BPS) / ideal;
    }

    /// @notice Tier weight in tenths (10 = 1.0x).
    function tierWeight(Tier tier, bool boosted) external pure returns (uint256) {
        return _weight(tier, boosted);
    }
}
