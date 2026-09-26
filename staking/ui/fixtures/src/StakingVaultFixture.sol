// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title StakingVaultFixture
 * @notice E2E TEST FIXTURE for the Ferminux staking UI — NOT the production
 *         vault. Implements the DESIGN.md §1/§3 economics the UI codes
 *         against, so the data layer can be exercised on a local anvil:
 *
 *           - 4 tiers (flexible 1.0×/10%, 90d 1.5×/15%, 180d 2.0×/20%,
 *             validator 3.0×/30% with a 25k FMX minimum)
 *           - stake-proportional rewards via weighted units, base 10%/yr per
 *             unit, bounded by the pool-wide drip cap — whichever binds, binds
 *           - FAIL-CLOSED accrual: rewards only ever come from the prefunded
 *             pool balance; when it is empty, accrual stops. No IOUs.
 *           - 7-day cooldown on every unstake; no accrual during cooldown
 *           - emergency exit: forfeit all unclaimed rewards + 5% of principal,
 *             both into the pool, then the normal cooldown
 *           - premine deny list: excluded addresses cannot stake
 *
 *         Native FMX throughout — staking is payable, no ERC-20 approval.
 *         Self-contained, Paris EVM, zero PUSH0 (solc 0.8.24, evm_version
 *         paris).
 */
contract StakingVaultFixture {
    // ---------------------------------------------------------------- Events
    event Staked(address indexed owner, uint256 indexed id, uint256 indexed tier, uint256 amount, uint256 unlockTime);
    event Claimed(address indexed owner, uint256 indexed id, uint256 amount);
    event CooldownStarted(address indexed owner, uint256 indexed id, uint256 cooldownEnd);
    event Withdrawn(address indexed owner, uint256 indexed id, uint256 amount);
    event EmergencyExited(address indexed owner, uint256 indexed id, uint256 penalty, uint256 forfeitedRewards);
    event PoolFunded(address indexed from, uint256 amount);

    // ---------------------------------------------------------------- Types
    struct Tier {
        uint256 lockSeconds;
        uint256 weightBps; // 10000 = 1.0x
        uint256 aprCapBps; // weight x 10%/yr
        uint256 minStake;
        bool requiresNode;
    }

    struct Position {
        uint256 id;
        address owner;
        uint256 tier;
        uint256 amount;
        uint256 units; // amount x weight while active; 0 once cooling
        uint256 startTime;
        uint256 unlockTime;
        uint256 cooldownEnd;
        uint256 state; // 0 active, 1 cooling, 2 withdrawn
        uint256 rewardDebt; // accPerUnit snapshot at last settle
        uint256 storedRewards;
    }

    struct PositionView {
        uint256 id;
        uint256 tier;
        uint256 amount;
        uint256 startTime;
        uint256 unlockTime;
        uint256 cooldownEnd;
        uint256 state;
        uint256 pendingRewards;
    }

    // ---------------------------------------------------------------- State
    uint256 private constant BPS = 10_000;
    uint256 private constant BASE_UNIT_APR_BPS = 1_000; // 10%/yr per weighted unit
    uint256 private constant YEAR = 31_536_000;
    uint256 private constant ACC_PRECISION = 1e18;

    Tier[] private _tiers;
    uint256 public immutable dripPerYear;
    uint256 public immutable cooldownSeconds;
    uint256 public constant emergencyPenaltyBps = 500;

    mapping(address => bool) public denied;

    Position[] private _positions;
    mapping(address => uint256[]) private _positionsOf;
    mapping(address => uint256) private _livePositions;

    uint256 public totalStaked;
    uint256 public totalWeightedUnits;
    uint256 public stakerCount;

    /// FMX available to pay rewards from (funded; grows with penalties).
    uint256 public rewardPool;
    /// Rewards accrued to stakers but not yet claimed (bounded by rewardPool).
    uint256 public owedRewards;

    uint256 private _accPerUnit;
    uint256 private _lastAccrual;

    // ----------------------------------------------------------- Constructor
    constructor(uint256 _dripPerYear, uint256 _cooldownSeconds, uint256 validatorLockSeconds, address[] memory denyList) {
        dripPerYear = _dripPerYear;
        cooldownSeconds = _cooldownSeconds;
        _tiers.push(Tier(0, 10_000, 1_000, 0, false));
        _tiers.push(Tier(90 days, 15_000, 1_500, 0, false));
        _tiers.push(Tier(180 days, 20_000, 2_000, 0, false));
        _tiers.push(Tier(validatorLockSeconds, 30_000, 3_000, 25_000 ether, true));
        for (uint256 i = 0; i < denyList.length; i++) {
            denied[denyList[i]] = true;
        }
        _lastAccrual = block.timestamp;
    }

    // ---------------------------------------------------------------- Pool
    function fundPool() external payable {
        require(msg.value > 0, "SV: zero funding");
        _accrue();
        rewardPool += msg.value;
        emit PoolFunded(msg.sender, msg.value);
    }

    /// Unclaimed-reward headroom left in the pool.
    function rewardPoolBalance() external view returns (uint256) {
        (uint256 acc, uint256 owed) = _accruedNow();
        acc; // silence unused warning
        return rewardPool - owed;
    }

    // -------------------------------------------------------------- Accrual
    /**
     * @dev Advance the accumulator. Rate per second = min(drip cap, units x
     *      10%/yr) / YEAR, and newly accrued rewards are capped by what the
     *      pool can still pay (fail-closed).
     */
    function _accrue() private {
        (uint256 acc, uint256 owed) = _accruedNow();
        _accPerUnit = acc;
        owedRewards = owed;
        _lastAccrual = block.timestamp;
    }

    function _accruedNow() private view returns (uint256 acc, uint256 owed) {
        acc = _accPerUnit;
        owed = owedRewards;
        uint256 elapsed = block.timestamp - _lastAccrual;
        if (elapsed == 0 || totalWeightedUnits == 0) return (acc, owed);
        uint256 demandPerYear = (totalWeightedUnits * BASE_UNIT_APR_BPS) / BPS;
        uint256 ratePerYear = demandPerYear < dripPerYear ? demandPerYear : dripPerYear;
        uint256 newRewards = (ratePerYear * elapsed) / YEAR;
        uint256 available = rewardPool - owed;
        if (newRewards > available) newRewards = available; // fail-closed
        acc += (newRewards * ACC_PRECISION) / totalWeightedUnits;
        owed += newRewards;
    }

    function _pending(Position storage p) private view returns (uint256) {
        if (p.units == 0) return p.storedRewards;
        (uint256 acc,) = _accruedNow();
        return p.storedRewards + (p.units * (acc - p.rewardDebt)) / ACC_PRECISION;
    }

    function _settle(Position storage p) private {
        _accrue();
        if (p.units > 0) {
            p.storedRewards += (p.units * (_accPerUnit - p.rewardDebt)) / ACC_PRECISION;
            p.rewardDebt = _accPerUnit;
        }
    }

    // ---------------------------------------------------------------- Views
    function tierCount() external view returns (uint256) {
        return _tiers.length;
    }

    function getTier(uint256 id)
        external
        view
        returns (uint256 lockSeconds, uint256 weightBps, uint256 aprCapBps, uint256 minStake, bool requiresNode)
    {
        require(id < _tiers.length, "SV: no such tier");
        Tier storage t = _tiers[id];
        return (t.lockSeconds, t.weightBps, t.aprCapBps, t.minStake, t.requiresNode);
    }

    function getPositions(address owner) external view returns (PositionView[] memory out) {
        uint256[] storage ids = _positionsOf[owner];
        out = new PositionView[](ids.length);
        for (uint256 i = 0; i < ids.length; i++) {
            Position storage p = _positions[ids[i]];
            out[i] = PositionView(p.id, p.tier, p.amount, p.startTime, p.unlockTime, p.cooldownEnd, p.state, _pending(p));
        }
    }

    function positionById(uint256 id) external view returns (address owner, uint256 tier, uint256 amount, uint256 state) {
        require(id < _positions.length, "SV: no such position");
        Position storage p = _positions[id];
        return (p.owner, p.tier, p.amount, p.state);
    }

    // -------------------------------------------------------------- Actions
    function stake(uint256 tierId) external payable returns (uint256 id) {
        require(tierId < _tiers.length, "SV: no such tier");
        require(!denied[msg.sender], "SV: denied address");
        Tier storage t = _tiers[tierId];
        require(msg.value > 0, "SV: zero stake");
        require(msg.value >= t.minStake, "SV: below tier minimum");

        _accrue();
        id = _positions.length;
        uint256 units = (msg.value * t.weightBps) / BPS;
        _positions.push(
            Position({
                id: id,
                owner: msg.sender,
                tier: tierId,
                amount: msg.value,
                units: units,
                startTime: block.timestamp,
                unlockTime: block.timestamp + t.lockSeconds,
                cooldownEnd: 0,
                state: 0,
                rewardDebt: _accPerUnit,
                storedRewards: 0
            })
        );
        _positionsOf[msg.sender].push(id);
        totalStaked += msg.value;
        totalWeightedUnits += units;
        if (_livePositions[msg.sender] == 0) stakerCount += 1;
        _livePositions[msg.sender] += 1;
        emit Staked(msg.sender, id, tierId, msg.value, block.timestamp + t.lockSeconds);
    }

    function claim(uint256 id) external {
        Position storage p = _own(id);
        require(p.state != 2, "SV: position withdrawn");
        _settle(p);
        uint256 amount = p.storedRewards;
        require(amount > 0, "SV: nothing to claim");
        p.storedRewards = 0;
        owedRewards -= amount;
        rewardPool -= amount;
        emit Claimed(msg.sender, id, amount);
        _pay(msg.sender, amount);
    }

    function beginUnstake(uint256 id) external {
        Position storage p = _own(id);
        require(p.state == 0, "SV: not active");
        require(block.timestamp >= p.unlockTime, "SV: still locked");
        _settle(p);
        totalWeightedUnits -= p.units;
        p.units = 0;
        p.state = 1;
        p.cooldownEnd = block.timestamp + cooldownSeconds;
        emit CooldownStarted(msg.sender, id, p.cooldownEnd);
    }

    function withdraw(uint256 id) external {
        Position storage p = _own(id);
        require(p.state == 1, "SV: not in cooldown");
        require(block.timestamp >= p.cooldownEnd, "SV: cooldown not over");
        uint256 principal = p.amount;
        uint256 rewards = p.storedRewards;
        p.state = 2;
        p.amount = 0;
        p.storedRewards = 0;
        totalStaked -= principal;
        if (rewards > 0) {
            owedRewards -= rewards;
            rewardPool -= rewards;
            emit Claimed(msg.sender, id, rewards);
        }
        _livePositions[msg.sender] -= 1;
        if (_livePositions[msg.sender] == 0) stakerCount -= 1;
        emit Withdrawn(msg.sender, id, principal);
        _pay(msg.sender, principal + rewards);
    }

    /**
     * @notice Early exit from a locked position: forfeits ALL unclaimed
     *         rewards plus 5% of principal — both go back into the reward
     *         pool — then the normal cooldown still applies.
     */
    function emergencyExit(uint256 id) external {
        Position storage p = _own(id);
        require(p.state == 0, "SV: not active");
        _settle(p);
        uint256 forfeited = p.storedRewards;
        uint256 penalty = (p.amount * emergencyPenaltyBps) / BPS;
        p.storedRewards = 0;
        if (forfeited > 0) owedRewards -= forfeited; // stays in rewardPool
        p.amount -= penalty;
        rewardPool += penalty;
        totalStaked -= penalty;
        totalWeightedUnits -= p.units;
        p.units = 0;
        p.state = 1;
        p.cooldownEnd = block.timestamp + cooldownSeconds;
        emit EmergencyExited(msg.sender, id, penalty, forfeited);
        emit CooldownStarted(msg.sender, id, p.cooldownEnd);
    }

    // -------------------------------------------------------------- Helpers
    function _own(uint256 id) private view returns (Position storage p) {
        require(id < _positions.length, "SV: no such position");
        p = _positions[id];
        require(p.owner == msg.sender, "SV: not position owner");
    }

    function _pay(address to, uint256 amount) private {
        (bool okPay,) = payable(to).call{value: amount}("");
        require(okPay, "SV: transfer failed");
    }
}
