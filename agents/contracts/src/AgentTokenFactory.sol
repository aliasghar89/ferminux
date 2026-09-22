// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AgentRegistry} from "./AgentRegistry.sol";

/// @title AgentToken — minimal ERC-20 for an agent (mint/burn only by the factory) with pull distributions
/// @dev Paris EVM, dependency-free. Holds the dividend accounting (magnified points per share) so that
///      `AgentTokenFactory.distribute` can share FMX pro-rata to holders as of each distribution;
///      transfers carry the correction so nobody can claim twice. FMX itself never touches the token.
contract AgentToken {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    address public immutable factory;
    uint256 public immutable agentId;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    uint256 private constant MAGNITUDE = 2 ** 128;
    uint256 public magnifiedPerShare;
    mapping(address => int256) private _corrections;
    mapping(address => uint256) public distributionsClaimed;
    uint256 public totalDistributed;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    error NotFactory();
    error ZeroAddress();
    error InsufficientBalance();
    error InsufficientAllowance();
    error NoSupply();

    modifier onlyFactory() {
        if (msg.sender != factory) revert NotFactory();
        _;
    }

    constructor(string memory name_, string memory symbol_, uint256 agentId_) {
        name = name_;
        symbol = symbol_;
        agentId = agentId_;
        factory = msg.sender;
    }

    // ───────────────────────────── ERC-20 ─────────────────────────────

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _transfer(msg.sender, to, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        if (a != type(uint256).max) {
            if (a < value) revert InsufficientAllowance();
            allowance[from][msg.sender] = a - value;
        }
        _transfer(from, to, value);
        return true;
    }

    // ───────────────────────────── factory hooks ─────────────────────────────

    function mint(address to, uint256 value) external onlyFactory {
        if (to == address(0)) revert ZeroAddress();
        totalSupply += value;
        balanceOf[to] += value;
        _corrections[to] -= int256(magnifiedPerShare * value);
        emit Transfer(address(0), to, value);
    }

    function burn(address from, uint256 value) external onlyFactory {
        uint256 b = balanceOf[from];
        if (b < value) revert InsufficientBalance();
        balanceOf[from] = b - value;
        totalSupply -= value;
        _corrections[from] += int256(magnifiedPerShare * value);
        emit Transfer(from, address(0), value);
    }

    /// @dev Record `amount` of FMX (held by the factory) as distributed pro-rata to current holders.
    function addDistribution(uint256 amount) external onlyFactory {
        if (totalSupply == 0) revert NoSupply();
        magnifiedPerShare += (amount * MAGNITUDE) / totalSupply;
        totalDistributed += amount;
    }

    /// @dev Mark `account`'s claimable distribution as paid; returns the amount for the factory to credit.
    function settleClaimable(address account) external onlyFactory returns (uint256 amount) {
        amount = claimable(account);
        if (amount != 0) distributionsClaimed[account] += amount;
    }

    // ───────────────────────────── views ─────────────────────────────

    function accumulative(address account) public view returns (uint256) {
        return uint256(int256(magnifiedPerShare * balanceOf[account]) + _corrections[account]) / MAGNITUDE;
    }

    function claimable(address account) public view returns (uint256) {
        return accumulative(account) - distributionsClaimed[account];
    }

    // ───────────────────────────── internals ─────────────────────────────

    function _transfer(address from, address to, uint256 value) internal {
        if (to == address(0)) revert ZeroAddress();
        uint256 b = balanceOf[from];
        if (b < value) revert InsufficientBalance();
        balanceOf[from] = b - value;
        balanceOf[to] += value;
        int256 c = int256(magnifiedPerShare * value);
        _corrections[from] += c;
        _corrections[to] -= c;
        emit Transfer(from, to, value);
    }
}

/// @title AgentTokenFactory — one ERC-20 per agent on a linear bonding curve (Addendum v3, C6)
/// @notice price(s) = base + slope * s, where s = circulating supply in whole tokens (18 dec) and the
///         price is FMX-wei per whole token. 100 % of supply is minted by the curve; the reserve stays in
///         the factory. Buy fee `feeBps` (1 %) → feeRecipient credits; sells are fee-free and land in
///         `credits` (pull). Anyone may `distribute(token)` FMX pro-rata to holders (pull via
///         `claimDistribution`). Sell proceeds and distributions are withdrawn with `withdraw()`.
/// @dev Paris EVM. Reserve math (WAD = 1e18): R(s) = base*s/WAD + slope*s^2/(2*WAD^2).
///      quoteBuy floors the minted amount, so reserve[token] >= R(supply) always (dust stays in reserve).
///      Bounds: base, slope <= 1e30 (keeps every intermediate product < 2^256 for any FMX amount).
contract AgentTokenFactory {
    struct Curve {
        uint256 agentId;
        uint256 base;
        uint256 slope;
        uint256 reserve; // FMX backing the circulating supply
    }

    uint256 private constant WAD = 1e18;
    uint256 public constant MAX_PARAM = 1e30;
    uint16 public constant MAX_FEE_BPS = 1000;
    uint16 public constant BPS = 10000;

    AgentRegistry public immutable registry;
    address public governance;
    address public feeRecipient;
    uint16 public feeBps = 100;
    mapping(address => uint256) public credits;

    mapping(uint256 => address) public tokenOf; // agentId => token
    mapping(address => Curve) private _curves; // token => curve
    address[] public tokens;

    uint256 private _lock;

    event Launched(uint256 indexed agentId, address indexed token, string symbol);
    event Bought(address indexed token, address indexed buyer, uint256 fmxIn, uint256 fee, uint256 amountOut);
    event Sold(address indexed token, address indexed seller, uint256 amountIn, uint256 fmxOut);
    event Distributed(address indexed token, address indexed from, uint256 amount);
    event Claimed(address indexed token, address indexed holder, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);
    event FeeChanged(uint16 feeBps);
    event FeeRecipientChanged(address indexed feeRecipient);
    event GovernanceChanged(address indexed previous, address indexed current);

    error NotGovernance();
    error ZeroAddress();
    error ZeroValue();
    error NotAgentOwner();
    error UnknownAgent();
    error AlreadyLaunched(address token);
    error InvalidSymbol();
    error InvalidCurve();
    error UnknownToken();
    error Slippage(uint256 got, uint256 min);
    error FeeTooHigh();
    error NothingToClaim();
    error NothingToWithdraw();
    error TransferFailed();
    error Reentrancy();

    modifier onlyGovernance() {
        if (msg.sender != governance) revert NotGovernance();
        _;
    }

    modifier nonReentrant() {
        if (_lock == 1) revert Reentrancy();
        _lock = 1;
        _;
        _lock = 0;
    }

    constructor(AgentRegistry registry_, address governance_, address feeRecipient_) {
        if (address(registry_) == address(0) || governance_ == address(0) || feeRecipient_ == address(0)) {
            revert ZeroAddress();
        }
        registry = registry_;
        governance = governance_;
        feeRecipient = feeRecipient_;
        emit GovernanceChanged(address(0), governance_);
        emit FeeRecipientChanged(feeRecipient_);
    }

    // ───────────────────────────── launch ─────────────────────────────

    /// @notice Agent owner launches the agent's single token. name = agent name, 18 decimals.
    function launch(uint256 agentId, string calldata symbol, uint256 base, uint256 slope)
        external
        returns (address token)
    {
        AgentRegistry.Agent memory a = registry.getAgent(agentId);
        if (a.status == AgentRegistry.Status.None) revert UnknownAgent();
        if (a.owner != msg.sender) revert NotAgentOwner();
        if (tokenOf[agentId] != address(0)) revert AlreadyLaunched(tokenOf[agentId]);
        uint256 symLen = bytes(symbol).length;
        if (symLen == 0 || symLen > 11) revert InvalidSymbol();
        if ((base == 0 && slope == 0) || base > MAX_PARAM || slope > MAX_PARAM) revert InvalidCurve();

        token = address(new AgentToken(a.name, symbol, agentId));
        tokenOf[agentId] = token;
        _curves[token] = Curve({agentId: agentId, base: base, slope: slope, reserve: 0});
        tokens.push(token);
        emit Launched(agentId, token, symbol);
    }

    // ───────────────────────────── trade ─────────────────────────────

    function buy(address token, uint256 minOut) external payable {
        Curve storage c = _curve(token);
        if (msg.value == 0) revert ZeroValue();
        uint256 fee = (msg.value * feeBps) / BPS;
        uint256 net = msg.value - fee;
        uint256 supply = AgentToken(token).totalSupply();
        uint256 out = _tokensFor(c, supply, net);
        if (out == 0 || out < minOut) revert Slippage(out, minOut);
        c.reserve += net;
        if (fee != 0) credits[feeRecipient] += fee;
        emit Bought(token, msg.sender, msg.value, fee, out);
        AgentToken(token).mint(msg.sender, out);
    }

    function sell(address token, uint256 amount, uint256 minFmx) external {
        Curve storage c = _curve(token);
        if (amount == 0) revert ZeroValue();
        uint256 supply = AgentToken(token).totalSupply();
        uint256 out = _reserveAt(c, supply) - _reserveAt(c, supply - amount); // reverts if amount > supply
        if (out < minFmx) revert Slippage(out, minFmx);
        c.reserve -= out;
        credits[msg.sender] += out;
        emit Sold(token, msg.sender, amount, out);
        AgentToken(token).burn(msg.sender, amount); // reverts if msg.sender holds < amount
    }

    function quoteBuy(address token, uint256 fmxIn) external view returns (uint256 out) {
        Curve storage c = _curve(token);
        uint256 net = fmxIn - (fmxIn * feeBps) / BPS;
        return _tokensFor(c, AgentToken(token).totalSupply(), net);
    }

    function quoteSell(address token, uint256 amountIn) external view returns (uint256 fmxOut) {
        Curve storage c = _curve(token);
        uint256 supply = AgentToken(token).totalSupply();
        if (amountIn > supply) return 0;
        return _reserveAt(c, supply) - _reserveAt(c, supply - amountIn);
    }

    /// @notice Current marginal price (FMX-wei per whole token) at the circulating supply.
    function price(address token) external view returns (uint256) {
        Curve storage c = _curve(token);
        return c.base + (c.slope * AgentToken(token).totalSupply()) / WAD;
    }

    // ───────────────────────────── distributions ─────────────────────────────

    /// @notice Share `msg.value` FMX pro-rata among current holders (pull via claimDistribution).
    function distribute(address token) external payable {
        _curve(token);
        if (msg.value == 0) revert ZeroValue();
        AgentToken(token).addDistribution(msg.value); // reverts NoSupply when nobody holds the token
        emit Distributed(token, msg.sender, msg.value);
    }

    function claimDistribution(address token) external {
        _curve(token);
        uint256 amount = AgentToken(token).settleClaimable(msg.sender);
        if (amount == 0) revert NothingToClaim();
        credits[msg.sender] += amount;
        emit Claimed(token, msg.sender, amount);
    }

    function claimable(address token, address holder) external view returns (uint256) {
        _curve(token);
        return AgentToken(token).claimable(holder);
    }

    // ───────────────────────────── withdraw ─────────────────────────────

    function withdraw() external nonReentrant {
        uint256 amount = credits[msg.sender];
        if (amount == 0) revert NothingToWithdraw();
        credits[msg.sender] = 0;
        emit Withdrawn(msg.sender, amount);
        (bool ok,) = payable(msg.sender).call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    // ───────────────────────────── views ─────────────────────────────

    function getCurve(address token) external view returns (Curve memory) {
        return _curves[token];
    }

    function tokenCount() external view returns (uint256) {
        return tokens.length;
    }

    // ───────────────────────────── governance ─────────────────────────────

    function setFee(uint16 bps) external onlyGovernance {
        if (bps > MAX_FEE_BPS) revert FeeTooHigh();
        feeBps = bps;
        emit FeeChanged(bps);
    }

    function setFeeRecipient(address recipient) external onlyGovernance {
        if (recipient == address(0)) revert ZeroAddress();
        feeRecipient = recipient;
        emit FeeRecipientChanged(recipient);
    }

    function setGovernance(address newGovernance) external onlyGovernance {
        if (newGovernance == address(0)) revert ZeroAddress();
        emit GovernanceChanged(governance, newGovernance);
        governance = newGovernance;
    }

    // ───────────────────────────── curve math ─────────────────────────────

    function _curve(address token) internal view returns (Curve storage c) {
        c = _curves[token];
        if (c.agentId == 0) revert UnknownToken();
    }

    /// @dev Cumulative reserve at supply s: base*s/WAD + slope*s^2/(2*WAD^2).
    function _reserveAt(Curve storage c, uint256 s) internal view returns (uint256) {
        return (c.base * s) / WAD + (c.slope * s * s) / (2 * WAD * WAD);
    }

    /// @dev Tokens minted for `net` FMX starting at supply `s0` (floored so R(s1) - R(s0) <= net).
    function _tokensFor(Curve storage c, uint256 s0, uint256 net) internal view returns (uint256) {
        if (net == 0) return 0;
        uint256 r1 = _reserveAt(c, s0) + net;
        uint256 s1;
        if (c.slope == 0) {
            s1 = (r1 * WAD) / c.base;
        } else {
            // slope*s^2 + 2*WAD*base*s - 2*WAD^2*R = 0  →  s = WAD*(sqrt(base^2 + 2*slope*R) - base)/slope
            uint256 disc = c.base * c.base + 2 * c.slope * r1;
            s1 = (WAD * (_sqrt(disc) - c.base)) / c.slope;
        }
        // guard against sqrt rounding: step down until the reserve fits
        while (s1 > s0 && _reserveAt(c, s1) > r1) {
            s1 -= 1;
        }
        return s1 > s0 ? s1 - s0 : 0;
    }

    function _sqrt(uint256 x) internal pure returns (uint256 y) {
        if (x == 0) return 0;
        uint256 z = (x + 1) / 2;
        y = x;
        while (z < y) {
            y = z;
            z = (x / z + z) / 2;
        }
    }
}
