// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title LiquidityRewards
 * @notice Pays a fixed, pre-funded reward budget to people who provide
 *         liquidity, in proportion to HOW MUCH they provided and FOR HOW LONG.
 *
 *         One instance per pool. Generic on both sides: stake any LP token, pay
 *         any reward token. The wFMX/BNB PancakeSwap pair and the Ferminux DEX
 *         pools are separate deployments, not special cases in here.
 *
 * ---------------------------------------------------------------------------
 * WHY TIME-WEIGHTED, AND WHY THAT IS THE WHOLE DESIGN
 *
 * The naive version — "snapshot the LP holders, divide the airdrop" — is farmed
 * in one block: add liquidity, be in the snapshot, remove liquidity, claim. The
 * project pays out its budget and the pool is exactly as thin as before.
 *
 * So rewards accrue per second against the share held at that second. Liquidity
 * present for one block earns one block's worth. There is no snapshot to stand
 * in front of, which means there is nothing to game — the incentive and the
 * behaviour it wants are the same thing.
 *
 * WHY VESTING. Rewards paid instantly are sold instantly, into the very pool
 * they were meant to deepen. Claimed rewards therefore vest linearly, so the
 * incentive to keep providing outlives the claim.
 *
 * WHY THE BUDGET IS PRE-FUNDED. `fund()` moves real tokens in before the
 * program starts. The contract cannot promise what it does not hold, so
 * "rewards ran out" is impossible by construction rather than by monitoring.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE OPERATOR CANNOT DO, and this is deliberate:
 *
 *   • take staked LP — there is no path from `owner` to anyone's stake
 *   • stop a withdrawal — `withdraw` and `exit` are ungated and unpausable
 *   • claw back rewards already earned
 *   • extend or shorten the program once it starts
 *
 * A liquidity provider is putting real assets somewhere on a promise. The
 * promise has to be enforced by the contract, not by us continuing to behave.
 */
contract LiquidityRewards {
    // --------------------------------------------------------------- config

    /// @notice The LP token providers stake. Never moved by anyone but its owner.
    address public immutable stakeToken;

    /// @notice The token rewards are paid in.
    address public immutable rewardToken;

    /// @notice Linear vesting applied to claimed rewards.
    uint64 public immutable vestDuration;

    address public owner;

    // --------------------------------------------------------------- state

    uint64 public startTime;
    uint64 public endTime;
    /// @notice Reward tokens per second, fixed once the program starts.
    uint256 public rewardRate;
    /// @notice Total budget moved in via fund(). Never minted.
    uint256 public totalBudget;

    uint256 public totalStaked;
    mapping(address => uint256) public stakedOf;

    /// @dev Accumulated reward per staked unit, scaled by 1e18.
    uint256 public accPerShare;
    uint64 public lastUpdate;

    mapping(address => uint256) internal _debt; // accPerShare already accounted
    mapping(address => uint256) internal _accrued; // earned, not yet claimed

    struct Vest {
        uint256 amount; // total in this schedule
        uint256 released; // already paid out of it
        uint64 start;
    }

    mapping(address => Vest) internal _vest;

    // -------------------------------------------------------------- events

    event Funded(uint256 amount, uint64 startTime, uint64 endTime, uint256 rewardRate);
    event Staked(address indexed user, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount);
    event Claimed(address indexed user, uint256 amount);
    event Released(address indexed user, uint256 amount);
    event OwnerChanged(address indexed previous, address indexed current);

    uint256 private _entered;

    modifier nonReentrant() {
        require(_entered == 0, "LR: reentrant");
        _entered = 1;
        _;
        _entered = 0;
    }

    constructor(address stakeToken_, address rewardToken_, uint64 vestDuration_, address owner_) {
        require(stakeToken_ != address(0) && rewardToken_ != address(0), "LR: zero token");
        // Staking and rewarding the same token would let the reward budget be
        // staked for more rewards, and would make the solvency check below
        // meaningless because one balance would back two obligations.
        require(stakeToken_ != rewardToken_, "LR: same token");
        require(owner_ != address(0), "LR: zero owner");
        stakeToken = stakeToken_;
        rewardToken = rewardToken_;
        vestDuration = vestDuration_;
        owner = owner_;
    }

    // ------------------------------------------------------------- program

    /**
     * @notice Move the reward budget in and start the program. Once only.
     *
     * @dev    Once only, and there is no setter for the rate, the end, or the
     *         budget. A provider deciding whether to commit capital for a month
     *         is entitled to know that the terms cannot be changed underneath
     *         them — including by us, including with good intentions.
     */
    function fund(uint256 amount, uint64 duration) external nonReentrant {
        require(msg.sender == owner, "LR: not owner");
        require(startTime == 0, "LR: already funded");
        require(amount > 0 && duration > 0, "LR: zero amount or duration");

        _pull(rewardToken, msg.sender, amount);

        totalBudget = amount;
        startTime = uint64(block.timestamp);
        endTime = uint64(block.timestamp) + duration;
        lastUpdate = startTime;
        // Integer division leaves a dust remainder unpaid, which is the safe
        // direction: the contract can never owe more than it holds.
        rewardRate = amount / duration;

        emit Funded(amount, startTime, endTime, rewardRate);
    }

    // --------------------------------------------------------------- views

    function _lastApplicable() internal view returns (uint64) {
        if (startTime == 0) return 0;
        return uint64(block.timestamp) < endTime ? uint64(block.timestamp) : endTime;
    }

    /// @notice Reward-per-share brought up to now, without writing.
    function currentAccPerShare() public view returns (uint256) {
        if (totalStaked == 0 || startTime == 0) return accPerShare;
        uint64 applicable = _lastApplicable();
        if (applicable <= lastUpdate) return accPerShare;
        uint256 elapsed = applicable - lastUpdate;
        return accPerShare + (elapsed * rewardRate * 1e18) / totalStaked;
    }

    /// @notice Rewards earned and claimable now (before vesting).
    function earned(address user) public view returns (uint256) {
        uint256 acc = currentAccPerShare();
        return _accrued[user] + (stakedOf[user] * (acc - _debt[user])) / 1e18;
    }

    /// @notice Of a user's vesting schedule, how much has vested so far.
    function vestedOf(address user) public view returns (uint256) {
        Vest memory v = _vest[user];
        if (v.amount == 0) return 0;
        if (vestDuration == 0) return v.amount;
        uint256 elapsed = block.timestamp - v.start;
        if (elapsed >= vestDuration) return v.amount;
        return (v.amount * elapsed) / vestDuration;
    }

    /// @notice What `release()` would pay right now.
    function releasable(address user) public view returns (uint256) {
        return vestedOf(user) - _vest[user].released;
    }

    function vestOf(address user) external view returns (Vest memory) {
        return _vest[user];
    }

    // ------------------------------------------------------------- staking

    function _update(address user) internal {
        uint256 acc = currentAccPerShare();
        accPerShare = acc;
        uint64 applicable = _lastApplicable();
        if (applicable > lastUpdate) {
            // Emission only counts as owed while somebody was actually staked.
            if (totalStaked > 0) _emittedTotal += uint256(applicable - lastUpdate) * rewardRate;
            lastUpdate = applicable;
        }
        if (user != address(0)) {
            _accrued[user] += (stakedOf[user] * (acc - _debt[user])) / 1e18;
            _debt[user] = acc;
        }
    }

    function stake(uint256 amount) external nonReentrant {
        require(amount > 0, "LR: zero amount");
        require(startTime != 0, "LR: not funded");
        require(block.timestamp < endTime, "LR: program ended");
        _update(msg.sender);
        _pull(stakeToken, msg.sender, amount);
        stakedOf[msg.sender] += amount;
        totalStaked += amount;
        emit Staked(msg.sender, amount);
    }

    /**
     * @notice Take LP back. UNGATED and UNPAUSABLE, with no owner override.
     *
     * @dev    A provider's stake is their property being held for a purpose,
     *         not a deposit at our discretion. If this contract could ever
     *         refuse a withdrawal it would be a custodian, and it is not.
     */
    function withdraw(uint256 amount) public nonReentrant {
        require(amount > 0 && stakedOf[msg.sender] >= amount, "LR: amount exceeds stake");
        _update(msg.sender);
        stakedOf[msg.sender] -= amount;
        totalStaked -= amount;
        _push(stakeToken, msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    /**
     * @notice Move earned rewards into the vesting schedule.
     *
     * @dev    Claiming again before the previous schedule finishes releases what
     *         has vested and restarts the clock on the remainder. That is a
     *         mild disincentive to claim constantly, and it keeps the schedule
     *         a single O(1) struct — the alternative, one entry per claim,
     *         grows without bound and eventually cannot be iterated at all.
     */
    function claim() public nonReentrant {
        _update(msg.sender);
        uint256 amount = _accrued[msg.sender];
        require(amount > 0, "LR: nothing to claim");
        _accrued[msg.sender] = 0;

        _releaseInternal(msg.sender);

        Vest storage v = _vest[msg.sender];
        uint256 unvested = v.amount - v.released;
        _vest[msg.sender] = Vest({amount: unvested + amount, released: 0, start: uint64(block.timestamp)});

        emit Claimed(msg.sender, amount);
    }

    /// @notice Pay out whatever has vested.
    function release() public nonReentrant {
        uint256 paid = _releaseInternal(msg.sender);
        require(paid > 0, "LR: nothing vested");
    }

    /// @notice Withdraw everything and claim, in one transaction.
    function exit() external {
        uint256 staked = stakedOf[msg.sender];
        if (staked > 0) withdraw(staked);
        if (earned(msg.sender) > 0) claim();
    }

    function _releaseInternal(address user) internal returns (uint256) {
        uint256 amount = releasable(user);
        if (amount == 0) return 0;
        _vest[user].released += amount;
        _push(rewardToken, user, amount);
        emit Released(user, amount);
        return amount;
    }

    // ---------------------------------------------------------- governance

    function transferOwnership(address newOwner) external {
        require(msg.sender == owner, "LR: not owner");
        require(newOwner != address(0), "LR: zero owner");
        emit OwnerChanged(owner, newOwner);
        owner = newOwner;
    }

    /**
     * @notice Recover reward tokens the program will never pay out, and only
     *         after it has ended.
     *
     * @dev    Bounded to the leftover: the rate is a floor division, and if
     *         nobody stakes for a stretch nobody accrues for it. That surplus
     *         is genuinely unowed. The stake token is NOT recoverable by any
     *         path — a rescue that could touch it would be the custody power
     *         this contract exists not to have.
     */
    function sweepUnallocated(address to) external nonReentrant {
        require(msg.sender == owner, "LR: not owner");
        require(startTime != 0 && block.timestamp > endTime, "LR: program not ended");
        require(to != address(0), "LR: zero recipient");
        // Bring emission up to the end of the program first. Without this the
        // comparison below is made against a stale figure, which is exactly how
        // the sweep could have taken rewards nobody had checkpointed yet.
        _update(address(0));
        // Everything still owed: accrued-but-unclaimed plus unreleased vesting.
        // Computed as a balance floor rather than a running total, so an
        // accounting slip here can only ever under-sweep.
        uint256 held = _balanceOf(rewardToken);
        uint256 owed = _outstanding();
        require(held > owed, "LR: nothing unallocated");
        _push(rewardToken, to, held - owed);
    }

    /// @dev Emission that has actually landed on stakers, ever. NOT the budget:
    ///      if nobody is staked for a stretch, that stretch's emission is owed
    ///      to nobody and is what the sweep exists to return.
    ///
    ///      ACCUMULATED GLOBALLY, not from per-user checkpoints. The first
    ///      version added it up inside the per-user branch of _update, so a
    ///      provider who staked once and never touched the contract again
    ///      contributed ZERO to it — and sweepUnallocated would then have paid
    ///      the owner rewards that provider had genuinely earned. Their balance
    ///      was correct the whole time (earned() integrates on read); only the
    ///      figure the sweep checked itself against was wrong.
    uint256 internal _emittedTotal;
    uint256 internal _releasedTotal;

    function _outstanding() internal view returns (uint256) {
        return _emittedTotal > _releasedTotal ? _emittedTotal - _releasedTotal : 0;
    }

    /// @notice Rewards accrued to participants but not yet paid out.
    function outstandingRewards() external view returns (uint256) {
        return _outstanding();
    }

    // ------------------------------------------------------------ internal

    function _pull(address token, address from, uint256 amount) internal {
        uint256 before = _balanceOf(token);
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(0x23b872dd, from, address(this), amount));
        require(ok && (ret.length == 0 || abi.decode(ret, (bool))), "LR: transferFrom failed");
        // Measured effect: a fee-on-transfer LP token would otherwise credit a
        // stake the contract does not hold.
        require(_balanceOf(token) - before == amount, "LR: inexact transfer");
    }

    function _push(address token, address to, uint256 amount) internal {
        if (token == rewardToken) _releasedTotal += amount;
        uint256 before = _balanceOf(token);
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(0xa9059cbb, to, amount));
        require(ok && (ret.length == 0 || abi.decode(ret, (bool))), "LR: transfer failed");
        require(before - _balanceOf(token) == amount, "LR: inexact transfer");
    }

    function _balanceOf(address token) internal view returns (uint256) {
        require(token.code.length > 0, "LR: token has no code");
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeWithSelector(0x70a08231, address(this)));
        require(ok && ret.length >= 32, "LR: balanceOf failed");
        return abi.decode(ret, (uint256));
    }
}
