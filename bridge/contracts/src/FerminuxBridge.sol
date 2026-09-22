// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20Minimal {
    function totalSupply() external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

interface IBridgeToken {
    function bridge() external view returns (address);
    function mint(address to, uint256 amount) external;
    function burn(address from, uint256 amount) external;
    function proposeBridge(address newBridge) external;
    function cancelBridgeRotation() external;
    function acceptBridge() external;
}

/// @dev The single question a rotation target must answer correctly before this
///      bridge will hand it a wrapper's minter seat. An EOA has no code and
///      cannot answer it at all; an unrelated contract answers wrongly or reverts.
interface IFerminuxBridgeIdentity {
    function BRIDGE_INTERFACE_ID() external view returns (bytes32);
}

/**
 * @title FerminuxBridge
 * @notice Symmetric lock-and-mint / burn-and-release bridge. ONE contract, the
 *         same bytecode, deployed on EVERY chain — including Ferminux itself.
 *         There is no "home" side and no "remote" side in the code; the only
 *         thing that differs per chain is the token registry.
 *
 *         Each local token is registered as exactly one of:
 *           CANONICAL — the real asset lives here. Leaving = LOCK, arriving = RELEASE.
 *                       address(0) is the chain's native coin (FMX on 3961, ETH on 1,
 *                       BNB on 56) and is always canonical, locked via a payable send().
 *           WRAPPED   — an IOU minted by this bridge for an asset canonical elsewhere.
 *                       Leaving = BURN, arriving = MINT.
 *
 *         Outbound  send(localToken, amount, dstChainId, recipient)
 *                     -> locks or burns, emits Sent(transferId, ...)
 *         Inbound   execute(transfer, signatures[])
 *                     -> M-of-N EIP-712 validator signatures, replay-protected by
 *                        transferId, then releases (canonical) or mints (wrapped).
 *
 *         SAFETY MODEL — fast to make safe, slow to make dangerous:
 *           * M-of-N validator set; validators only ever ATTEST, they can never
 *             move funds outside a signed transfer and can never change config.
 *           * per-token maxPerTransfer + a rolling 24h volume cap enforced
 *             SEPARATELY on the outbound and inbound direction. The window is a
 *             continuously-draining bucket, not a calendar day — there is no
 *             boundary to sit on and double-spend the cap across.
 *           * global pause + per-token pause, immediate, from a PAUSER key.
 *             Unpause is the owner multisig only.
 *           * 48h timelock on everything that could ENLARGE the blast radius:
 *             validator/threshold changes, cap increases, registry additions,
 *             fee changes, timelock changes, wrapper-minter handover and the
 *             OWNERSHIP handover itself. Cap DECREASES, pause, and every
 *             REVOCATION (cancelAction, cancelOwnershipTransfer,
 *             cancelWrapperBridgeRotation) bypass the timelock entirely,
 *             because safety must never wait.
 *           * lockedBalance is tracked per token; execute() can only release
 *             against it, and rescue() can only ever move the surplus above it.
 *           * every value movement is verified by MEASURED EFFECT, not by a
 *             returned bool: releases assert the bridge's balance fell AND the
 *             recipient's balance rose, mints assert the recipient's balance
 *             rose, burns assert supply fell. A token that has gone dark, or a
 *             wrapper that lies, reverts — it can never consume a transferId
 *             while delivering nothing.
 *           * ONE SETTLEMENT RULE, no classes, no switch. A deposit must credit
 *             exactly `amount`; a release must move exactly `amount` off the
 *             bridge AND exactly `amount` onto the recipient. Anything else
 *             reverts, so a token that skims, reflects or surcharges is refused
 *             on BOTH legs rather than silently short-paying somebody. The only
 *             way any transfer ever settles for less is the per-transfer,
 *             timelocked, loudly-evented escape in allowShortDelivery() — one
 *             named transferId at a time, never a standing licence. See
 *             README §"Settlement" for the shapes that are refused and where.
 *
 * Self-contained: no external imports, compiles standalone with solc >=0.8.24.
 */
contract FerminuxBridge {
    // ---------------------------------------------------------------- Types
    enum TokenKind {
        UNREGISTERED,
        CANONICAL,
        WRAPPED
    }

    struct TokenConfig {
        TokenKind kind;
        bool paused;
        uint64 remoteChainId; // the ONE chain this local token bridges with
        address remoteToken; // its address over there (address(0) = their native coin)
        uint256 maxPerTransfer;
        uint256 dailyCap; // per direction, per rolling 24h
    }

    /// @dev Continuously-draining volume bucket. `used` decays linearly to zero
    ///      over WINDOW seconds from `updatedAt`, so capacity comes back smoothly
    ///      instead of snapping open at a fixed hour.
    struct Window {
        uint128 used;
        uint64 updatedAt;
    }

    /// @dev The wire format. Identical on both chains; every field is signed.
    struct BridgeTransfer {
        uint64 srcChainId;
        uint64 dstChainId;
        uint64 nonce; // source-bridge outbound counter
        address srcToken; // token address on srcChainId
        address dstToken; // token address on dstChainId
        address sender;
        address recipient;
        uint256 amount; // NET amount credited on the destination (fee already taken)
    }

    struct Signature {
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    struct Action {
        bytes data; // abi-encoded call to one of the onlySelf setters
        uint64 eta;
        bool executed;
        bool canceled;
    }

    // ------------------------------------------------------------ Constants
    uint256 public constant BPS_DENOMINATOR = 10_000;
    /// @notice Hard ceiling on the bridge fee. Not governance-changeable.
    uint256 public constant MAX_FEE_BPS = 100; // 1.00%
    uint256 public constant WINDOW = 24 hours;
    uint256 public constant MAX_VALIDATORS = 32;
    uint64 public constant MIN_TIMELOCK_DELAY = 1 hours;
    uint64 public constant MAX_TIMELOCK_DELAY = 30 days;
    /// @notice A queued action that is not executed within this long after its
    ///         eta goes stale and must be re-queued.
    /// @dev    Deliberately short. ActionQueued fires ONCE, at queue time, and is
    ///         the highest-value alert in the system; a long grace period lets a
    ///         matured action be sat on until that alert has aged out of everyone's
    ///         attention and then fired with no fresh warning. 72h keeps a loaded
    ///         action inside the same operational window as its own announcement —
    ///         hold it longer and you must re-queue, which re-announces.
    uint64 public constant GRACE_PERIOD = 72 hours;
    /// @notice How long a pending ownership handover stays acceptable. An offer
    ///         that is never taken up expires instead of standing forever as a
    ///         silent takeover key.
    uint64 public constant OWNERSHIP_ACCEPT_WINDOW = 14 days;
    /// @dev secp256k1 curve order / 2 — signatures above this are malleable.
    uint256 private constant HALF_CURVE_ORDER = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    bytes32 public constant TRANSFER_TYPEHASH = keccak256(
        "BridgeTransfer(bytes32 transferId,uint64 srcChainId,uint64 dstChainId,uint64 nonce,address srcToken,address dstToken,address sender,address recipient,uint256 amount)"
    );

    /// @notice Self-identification. proposeWrapperBridge() asks a candidate for
    ///         this value and refuses to hand over a wrapper's minter seat unless
    ///         the answer matches, so the rotation target must be a contract that
    ///         positively claims to be a Ferminux bridge — never a bare key.
    bytes32 public constant BRIDGE_INTERFACE_ID = keccak256("FerminuxBridge.v1");

    // ---------------------------------------------------------------- State
    address public owner; // the multisig
    address public pendingOwner;
    /// @notice Deadline for pendingOwner to call acceptOwnership(). Past it the
    ///         offer is dead and must be re-proposed through the timelock.
    uint64 public pendingOwnerExpiry;
    mapping(address => bool) public isPauser;

    /// @dev Read through getValidators() / validatorCount(); kept internal so the
    ///      auto-generated per-index getter does not sit in the runtime for free.
    address[] internal validators;
    mapping(address => bool) public isValidator;
    uint256 public threshold;

    address public feeCollector;
    uint256 public feeBps;

    uint64 public timelockDelay;
    uint64 public outboundNonce;

    bool public paused;

    mapping(address => TokenConfig) internal _tokenConfig;
    address[] public registeredTokens;

    /// @dev Reverse index of the registry: (remote chain, remote token) => the ONE
    ///      local token that mirrors it. The registry is a bijection, which is what
    ///      every other part of this contract already assumes — without it a single
    ///      remote deposit could be credited on two local assets, each with its own
    ///      caps and its own transferId space.
    ///
    ///      Read through localTokenFor() / isRemoteRouted(). The stored value uses
    ///      NATIVE_ROUTE as a sentinel when the LOCAL side is the native coin,
    ///      because that token's address is itself address(0) and would otherwise
    ///      be indistinguishable from an empty slot — which would let a second
    ///      token claim the native coin's route.
    mapping(uint64 => mapping(address => address)) internal _localTokenFor;

    /// @dev Sentinel for "the local side of this route is the native coin". Safe
    ///      because address(1) is the ecrecover precompile: it has no code, so
    ///      registerCanonical/registerWrapped can never accept it as a token.
    address private constant NATIVE_ROUTE = address(1);

    /// @notice The counterpart bridge deployment on each remote chain, as this
    ///         chain knows it. Timelocked (setRemoteBridge) and MANDATORY: no
    ///         token may be registered for a chain whose bridge address is unset.
    ///
    /// @dev    This exists so send()'s bad-recipient guard rests on a fact rather
    ///         than an assumption. Paying the DESTINATION bridge is the address
    ///         that destroys the money (execute() rejects it there, but by then
    ///         the sender has already parted with their funds on this side), and
    ///         a chain cannot derive another chain's deployment address. So it is
    ///         recorded here, per route, by the same governance that registers the
    ///         route — and send() refuses it at origin, where the money is still
    ///         the user's. Nothing about the two deployments needs to be
    ///         address-identical, deterministic, or CREATE2'd for that to hold.
    mapping(uint64 => address) public remoteBridge;

    /// @notice keccak256 of the runtime bytecode every WRAPPED token must have.
    ///         registerWrapped pins to this, so a wrapper is the audited
    ///         BridgeToken bytecode or it is not registrable. Zero means "unset",
    ///         and unset means no wrapper can be registered at all — the control
    ///         fails closed. Changing it is timelocked, so adopting a different
    ///         wrapper implementation costs a public 48h announcement of its own.
    bytes32 public bridgeTokenCodehash;

    /// @notice Collateral the bridge OWES to inbound transfers. Never rescuable.
    mapping(address => uint256) public lockedBalance;
    /// @notice Fees taken but not yet withdrawn. Never rescuable, never releasable.
    mapping(address => uint256) public accruedFees;

    mapping(address => Window) internal _outboundWindow;
    mapping(address => Window) internal _inboundWindow;

    /// @notice transferId => already executed on this chain.
    mapping(bytes32 => bool) public processed;

    /// @notice The ONE transferId currently authorised to settle short, or zero.
    /// @dev    The whole escape hatch for a canonical token that starts taxing its
    ///         transfers AFTER collateral is already locked behind it. Set only by
    ///         allowShortDelivery(), which is onlySelf and therefore only reachable
    ///         through the 48h timelock; cleared the moment it is spent, and
    ///         revocable for free.
    ///
    ///         Deliberately ONE SLOT rather than a mapping. At most a single
    ///         transfer in the whole contract can be short at any instant, a stale
    ///         authorisation is overwritten by the next one instead of
    ///         accumulating, and the operator answering "what is armed right now?"
    ///         reads one word. A strand incident with fifty stuck transfers still
    ///         clears in one 48h window — queue all fifty actions together, then
    ///         arm-and-relay them one after another once they mature.
    bytes32 public shortDeliveryArmed;

    Action[] internal _actions;

    uint256 private immutable _cachedChainId;
    bytes32 private immutable _cachedDomainSeparator;

    uint256 private _reentrancy = 1;

    // --------------------------------------------------------------- Events
    event Sent(
        bytes32 indexed transferId,
        uint64 indexed dstChainId,
        address indexed localToken,
        uint64 srcChainId,
        uint64 nonce,
        address remoteToken,
        address sender,
        address recipient,
        uint256 amount,
        uint256 fee
    );
    event Executed(
        bytes32 indexed transferId,
        uint64 indexed srcChainId,
        address indexed localToken,
        address remoteToken,
        address recipient,
        uint256 amount,
        uint256 signatureCount
    );

    event TokenRegistered(
        address indexed localToken,
        TokenKind kind,
        uint64 indexed remoteChainId,
        address indexed remoteToken,
        uint256 maxPerTransfer,
        uint256 dailyCap
    );
    event TokenLimitsChanged(address indexed localToken, uint256 maxPerTransfer, uint256 dailyCap, bool immediate);
    event RemoteBridgeChanged(uint64 indexed remoteChainId, address indexed remoteBridgeAddress);

    /// @notice ONE inbound transfer has been authorised to settle short, by the
    ///         owner, through the 48h timelock. `owed` is what the signed transfer
    ///         promised the recipient; the transfer has NOT moved yet.
    event ShortDeliveryAllowed(
        bytes32 indexed transferId, address indexed localToken, address indexed recipient, uint256 owed
    );
    /// @notice A short-delivery authorisation withdrawn before it was used.
    event ShortDeliveryRevoked(bytes32 indexed transferId);
    /// @notice A short-delivery authorisation SPENT. `owed` is what the recipient
    ///         was promised, `delivered` is what they actually received and `paid`
    ///         is what the bridge actually parted with. Anything the transfer was
    ///         written down for beyond `paid` is now surplus — see rescue().
    /// @dev The token and the recipient are not repeated here: the Executed event
    ///      for the same indexed transferId, emitted in the same call, carries
    ///      both. What only this event can say is the three numbers.
    event ShortDelivery(bytes32 indexed transferId, uint256 owed, uint256 paid, uint256 delivered);

    event ValidatorAdded(address indexed validator);
    event ValidatorRemoved(address indexed validator);
    event ThresholdChanged(uint256 threshold);

    event FeeBpsChanged(uint256 feeBps);
    event FeeCollectorChanged(address indexed feeCollector);
    event FeesWithdrawn(address indexed token, address indexed to, uint256 amount);

    event Paused(address indexed account);
    event Unpaused(address indexed account);
    event TokenPaused(address indexed localToken, address indexed account);
    event TokenUnpaused(address indexed localToken, address indexed account);
    event PauserSet(address indexed account, bool allowed);

    event ActionQueued(uint256 indexed actionId, bytes4 indexed selector, bytes data, uint64 eta);
    event ActionExecuted(uint256 indexed actionId, bytes4 indexed selector);
    event ActionCanceled(uint256 indexed actionId, bytes4 indexed selector);
    event TimelockDelayChanged(uint64 delay);

    event OwnershipTransferStarted(address indexed newOwner, uint64 expiry);
    event OwnershipTransferCanceled(address indexed canceledOwner);
    event OwnershipTransferred(address indexed oldOwner, address indexed newOwner);

    event BridgeTokenCodehashChanged(bytes32 codehash);
    event WrapperBridgeRotationProposed(address indexed localToken, address indexed newBridge);
    event WrapperBridgeRotationCanceled(address indexed localToken);
    event WrapperAdopted(address indexed localToken);

    event Rescued(address indexed token, address indexed to, uint256 amount);
    event NativeReceived(address indexed from, uint256 amount);

    // ------------------------------------------------------------ Modifiers
    /// @dev The modifier bodies below are one-line calls into these helpers on
    ///      purpose. A `require` written inline in a modifier is copied into every
    ///      function that wears it — twelve times for onlySelf alone — and this
    ///      contract has 517 bytes of EIP-170 headroom to spend on better things.
    function _onlyOwner() internal view {
        require(msg.sender == owner, "BRIDGE: not owner");
    }

    modifier onlyOwner() {
        _onlyOwner();
        _;
    }

    /// @dev Reachable ONLY through executeAction() after the timelock has matured.
    function _onlySelf() internal view {
        require(msg.sender == address(this), "BRIDGE: timelocked");
    }

    modifier onlySelf() {
        _onlySelf();
        _;
    }

    modifier onlyPauser() {
        require(isPauser[msg.sender] || msg.sender == owner, "BRIDGE: not pauser");
        _;
    }

    function _enter() internal {
        require(_reentrancy == 1, "BRIDGE: reentrant");
        _reentrancy = 2;
    }

    function _exit() internal {
        _reentrancy = 1;
    }

    modifier nonReentrant() {
        _enter();
        _;
        _exit();
    }

    // ----------------------------------------------------------- Constructor
    constructor(
        address _owner,
        address[] memory _validators,
        uint256 _threshold,
        address _feeCollector,
        uint256 _feeBps,
        uint64 _timelockDelay,
        address _pauser
    ) {
        require(_owner != address(0), "BRIDGE: zero owner");
        require(_feeCollector != address(0), "BRIDGE: zero collector");
        require(_feeCollector != address(this), "BRIDGE: collector is bridge");
        require(_feeBps <= MAX_FEE_BPS, "BRIDGE: fee too high");
        require(_timelockDelay >= MIN_TIMELOCK_DELAY && _timelockDelay <= MAX_TIMELOCK_DELAY, "BRIDGE: bad delay");
        require(_validators.length > 0 && _validators.length <= MAX_VALIDATORS, "BRIDGE: bad validator count");
        require(_threshold >= 1 && _threshold <= _validators.length, "BRIDGE: bad threshold");

        for (uint256 i = 0; i < _validators.length; i++) {
            address v = _validators[i];
            require(v != address(0), "BRIDGE: zero validator");
            require(!isValidator[v], "BRIDGE: duplicate validator");
            isValidator[v] = true;
            validators.push(v);
            emit ValidatorAdded(v);
        }

        owner = _owner;
        threshold = _threshold;
        feeCollector = _feeCollector;
        feeBps = _feeBps;
        timelockDelay = _timelockDelay;
        if (_pauser != address(0)) {
            isPauser[_pauser] = true;
            emit PauserSet(_pauser, true);
        }

        _cachedChainId = block.chainid;
        _cachedDomainSeparator = _buildDomainSeparator();

        emit OwnershipTransferred(address(0), _owner);
        emit ThresholdChanged(_threshold);
        emit FeeCollectorChanged(_feeCollector);
        emit FeeBpsChanged(_feeBps);
        emit TimelockDelayChanged(_timelockDelay);
    }

    /// @notice Accepts stray native coin so it can be rescued. Native sent this
    ///         way is NOT bridged and NOT locked — it is surplus.
    receive() external payable {
        emit NativeReceived(msg.sender, msg.value);
    }

    // ------------------------------------------------------------- EIP-712
    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return block.chainid == _cachedChainId ? _cachedDomainSeparator : _buildDomainSeparator();
    }

    function _buildDomainSeparator() private view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("FerminuxBridge")),
                keccak256(bytes("1")),
                block.chainid, // == the DESTINATION chain: execute() runs here
                address(this) // == this exact deployment
            )
        );
    }

    /// @notice Globally unique id of a transfer. Both chain ids and the source
    ///         bridge's nonce are inside, so the same nonce on a different route
    ///         is a different transfer and the id can never collide.
    function transferIdOf(BridgeTransfer memory t) public pure returns (bytes32) {
        return keccak256(
            abi.encode(t.srcChainId, t.dstChainId, t.nonce, t.srcToken, t.dstToken, t.sender, t.recipient, t.amount)
        );
    }

    /// @notice The exact digest validators sign. Bound to the destination chain
    ///         id and to this contract address by the EIP-712 domain, and to the
    ///         transfer by transferId + every field. A signature produced for
    ///         another chain or another bridge deployment is worthless here.
    function hashTransfer(BridgeTransfer memory t) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                TRANSFER_TYPEHASH,
                transferIdOf(t),
                t.srcChainId,
                t.dstChainId,
                t.nonce,
                t.srcToken,
                t.dstToken,
                t.sender,
                t.recipient,
                t.amount
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), structHash));
    }

    // ---------------------------------------------------------------- Views
    function tokenConfig(address localToken) external view returns (TokenConfig memory) {
        return _tokenConfig[localToken];
    }

    function validatorCount() external view returns (uint256) {
        return validators.length;
    }

    function getValidators() external view returns (address[] memory) {
        return validators;
    }

    function registeredTokenCount() external view returns (uint256) {
        return registeredTokens.length;
    }

    /// @notice The one local token mirroring (remoteChainId, remoteToken).
    /// @dev    Returns address(0) both for "the native coin" and for "not routed";
    ///         call isRemoteRouted() to tell those apart.
    function localTokenFor(uint64 remoteChainId, address remoteToken) external view returns (address) {
        address local = _localTokenFor[remoteChainId][remoteToken];
        return local == NATIVE_ROUTE ? address(0) : local;
    }

    /// @notice Whether some local token already claims this remote asset.
    function isRemoteRouted(uint64 remoteChainId, address remoteToken) external view returns (bool) {
        return _localTokenFor[remoteChainId][remoteToken] != address(0);
    }

    function actionCount() external view returns (uint256) {
        return _actions.length;
    }

    function getAction(uint256 actionId)
        external
        view
        returns (bytes memory data, uint64 eta, bool executed, bool canceled)
    {
        Action storage a = _actionAt(actionId);
        return (a.data, a.eta, a.executed, a.canceled);
    }

    /// @notice Outbound volume currently counted against the 24h cap, after decay.
    function outboundUsage(address localToken) external view returns (uint256) {
        return _usage(_outboundWindow[localToken]);
    }

    /// @notice Inbound volume currently counted against the 24h cap, after decay.
    function inboundUsage(address localToken) external view returns (uint256) {
        return _usage(_inboundWindow[localToken]);
    }

    /// @notice Balance the bridge holds beyond what it owes (locked + fees).
    ///         This is the ONLY amount rescue() can ever move.
    function surplusOf(address token) public view returns (uint256) {
        uint256 reserved = lockedBalance[token] + accruedFees[token];
        uint256 bal = _heldBalance(token);
        return bal > reserved ? bal - reserved : 0;
    }

    /// @dev What this contract actually holds of `token`. address(0) is the
    ///      chain's native coin.
    function _heldBalance(address token) internal view returns (uint256) {
        return token == address(0) ? address(this).balance : _balanceOf(token, address(this));
    }

    /// @dev The single ERC20 read in the contract. Every settlement measurement
    ///      goes through here, so a token that cannot answer balanceOf() cannot be
    ///      metered, cannot be released, and is refused at registration.
    function _balanceOf(address token, address who) internal view returns (uint256) {
        return IERC20Minimal(token).balanceOf(who);
    }

    /// @dev Companion to _balanceOf for the burn receipt in send().
    function _totalSupply(address token) internal view returns (uint256) {
        return IERC20Minimal(token).totalSupply();
    }

    /// @dev A raw `.call` into a code-less address returns ok=true with empty
    ///      returndata, which the USDT-shaped empty-return branch would then
    ///      accept as a successful transfer. Every raw call in this contract is
    ///      gated on this first.
    function _requireCode(address token) internal view {
        require(token.code.length > 0, "BRIDGE: token has no code");
    }

    // ------------------------------------------------------------- Outbound
    /**
     * @notice Send `amount` of `localToken` to `recipient` on `dstChainId`.
     *         Canonical tokens are locked here; wrapped tokens are burned.
     *         The fee is taken at origin, so a round trip pays twice — once per
     *         leg — and each leg's fee is collected on the chain it left from.
     * @dev    For the native coin pass localToken = address(0) and msg.value = amount.
     * @dev    Two bad-recipient guards, and neither assumes anything about how the
     *         two deployments were deployed:
     *
     *           * `recipient != remoteBridge[dstChainId]` is the one that matters.
     *             Paying the DESTINATION bridge is what destroys the money — over
     *             there execute() reverts, but only after this side has already
     *             taken the user's funds and emitted a Sent nobody can fill. That
     *             address is not derivable from here, so it is recorded per route
     *             by governance and is mandatory before a route can be registered.
     *           * `recipient != address(this)` is a plain sanity check on the
     *             local address, not a proxy for the remote one. It costs nothing
     *             and catches an operator or UI that pasted the wrong side's
     *             address. It is NOT load-bearing: the previous justification for
     *             it — "deployments are address-identical across chains" — was an
     *             assumption no deployment document ever established, and is gone.
     */
    function send(address localToken, uint256 amount, uint64 dstChainId, address recipient)
        external
        payable
        nonReentrant
        returns (bytes32 transferId)
    {
        require(!paused, "BRIDGE: paused");
        require(recipient != address(0), "BRIDGE: zero recipient");
        require(amount > 0, "BRIDGE: zero amount");

        TokenConfig storage cfg = _registeredConfig(localToken);
        require(!cfg.paused, "BRIDGE: token paused");
        require(dstChainId == cfg.remoteChainId, "BRIDGE: bad dst chain");
        require(recipient != remoteBridge[dstChainId] && recipient != address(this), "BRIDGE: recipient is bridge");

        // ---- pull the value in, measuring what actually arrived
        if (localToken == address(0)) {
            require(msg.value == amount, "BRIDGE: bad msg.value");
        } else {
            require(msg.value == 0, "BRIDGE: unexpected value");
            if (cfg.kind == TokenKind.CANONICAL) {
                uint256 balBefore = _balanceOf(localToken, address(this));
                _safeTransferFrom(localToken, msg.sender, address(this), amount);
                // EXACTLY what was asked for, or nothing. Both halves matter:
                //   * too little — the token skims or reflects. Crediting the
                //     measured figure instead would be a silent short-pay.
                //   * too MUCH — the token settled somebody else's accrual into
                //     the bridge during our transferFrom (a reflection token
                //     paying out its pool). Crediting the measured figure there
                //     hands the depositor a pool that belongs to other users and
                //     the counterpart chain releases real collateral against it.
                // Refusing the deposit is also the other half of refusing the
                // release: a token that has quietly switched a tax on stops
                // accepting NEW collateral at the same instant its releases start
                // reverting, so nothing further is trapped behind a broken route.
                //
                // With the class switch gone there is no `received` to carry
                // forward: the deposit either credited `amount` or it reverted, so
                // every figure below is `amount`, and `Sent.amount` is the net of
                // exactly what the caller asked for.
                require(_balanceOf(localToken, address(this)) - balBefore == amount, "BRIDGE: inexact transfer");
            }
        }

        // ---- rails
        require(amount <= cfg.maxPerTransfer, "BRIDGE: over per-transfer cap");
        _consume(_outboundWindow[localToken], cfg.dailyCap, amount);

        // ---- fee
        uint256 fee = (amount * feeBps) / BPS_DENOMINATOR;
        uint256 net = amount - fee;
        require(net > 0, "BRIDGE: amount too small");

        if (cfg.kind == TokenKind.CANONICAL) {
            // Only `net` becomes collateral; `fee` is the operator's, not a claim.
            lockedBalance[localToken] += net;
        } else {
            // Burn the whole amount, then re-mint the fee to the bridge. Net supply
            // falls by exactly `net`, which is exactly what gets released at home,
            // and the fee stays backed by collateral that is never released.
            //
            // burn()/mint() return nothing, so there is no bool to inspect: the
            // supply delta IS the receipt. A wrapper that silently no-ops would
            // otherwise let this emit a fully-formed Sent(net) that validators
            // sign in good faith, and the counterpart chain would release real
            // collateral against a burn that never happened.
            //
            // The wrapper's burn() now consumes the sender's allowance, exactly
            // as transferFrom would. So a wrapped send requires an approve()
            // first — the same two-step every DEX uses. That is the point: the
            // bridge can no longer move a balance nobody granted it, and a
            // holder can verify that from the token alone rather than by reading
            // this contract and trusting it is never rotated.
            uint256 supplyBefore = _totalSupply(localToken);
            IBridgeToken(localToken).burn(msg.sender, amount);
            if (fee > 0) IBridgeToken(localToken).mint(address(this), fee);
            require(supplyBefore - _totalSupply(localToken) == net, "BRIDGE: burn not settled");
        }
        if (fee > 0) accruedFees[localToken] += fee;

        uint64 n = ++outboundNonce;
        BridgeTransfer memory t = BridgeTransfer({
            srcChainId: uint64(block.chainid),
            dstChainId: dstChainId,
            nonce: n,
            srcToken: localToken,
            dstToken: cfg.remoteToken,
            sender: msg.sender,
            recipient: recipient,
            amount: net
        });
        transferId = transferIdOf(t);

        emit Sent(
            transferId,
            dstChainId,
            localToken,
            uint64(block.chainid),
            n,
            cfg.remoteToken,
            msg.sender,
            recipient,
            net,
            fee
        );
    }

    // -------------------------------------------------------------- Inbound
    /**
     * @notice Execute an inbound transfer attested by >= threshold validators.
     *         Permissionless: anyone may relay a fully-signed transfer.
     *         Signatures may arrive in any order; a repeated signer is rejected.
     */
    function execute(BridgeTransfer calldata t, Signature[] calldata sigs) external nonReentrant {
        require(!paused, "BRIDGE: paused");
        require(t.dstChainId == uint64(block.chainid), "BRIDGE: wrong dst chain");
        require(t.srcChainId != t.dstChainId, "BRIDGE: same chain");
        require(t.recipient != address(0), "BRIDGE: zero recipient");
        // Paying ourselves would leave the balance sheet flat while lockedBalance
        // fell — collateral reclassified as rescue()-able surplus, and the user's
        // funds destroyed behind an Executed event that looks like a delivery.
        // `recipient` is a free field chosen on the source chain, so this needs no
        // privilege to reach.
        require(t.recipient != address(this), "BRIDGE: recipient is bridge");
        require(t.amount > 0, "BRIDGE: zero amount");

        bytes32 transferId = transferIdOf(t);
        require(!processed[transferId], "BRIDGE: already processed");

        TokenConfig storage cfg = _registeredConfig(t.dstToken);
        require(!cfg.paused, "BRIDGE: token paused");
        require(cfg.remoteChainId == t.srcChainId, "BRIDGE: bad src chain");
        require(cfg.remoteToken == t.srcToken, "BRIDGE: token mismatch");

        require(t.amount <= cfg.maxPerTransfer, "BRIDGE: over per-transfer cap");
        _consume(_inboundWindow[t.dstToken], cfg.dailyCap, t.amount);

        _verifySignatures(hashTransfer(t), sigs);

        // Effects before interactions: replay is closed before any token moves.
        processed[transferId] = true;

        if (cfg.kind == TokenKind.CANONICAL) {
            // Underflows (and therefore reverts) if the bridge is asked to release
            // more of this token than it ever locked. Hard collateral ceiling.
            lockedBalance[t.dstToken] -= t.amount;
            if (shortDeliveryArmed == transferId) {
                // The escape hatch, spent. Single-use: cleared before the call, so
                // the authorisation cannot survive into a second attempt and this
                // branch is unreachable again for this transferId.
                shortDeliveryArmed = bytes32(0);
                (uint256 paid, uint256 delivered) = _settle(t.dstToken, t.recipient, t.amount);
                emit ShortDelivery(transferId, t.amount, paid, delivered);
            } else {
                _payOut(t.dstToken, t.recipient, t.amount);
            }
        } else {
            // Same reasoning as the burn in send(): mint() returns nothing, so the
            // recipient's balance delta is the only honest receipt. processed[] is
            // already true at this point, so a silent no-op here would be final.
            uint256 recipientBefore = _balanceOf(t.dstToken, t.recipient);
            IBridgeToken(t.dstToken).mint(t.recipient, t.amount);
            require(_balanceOf(t.dstToken, t.recipient) - recipientBefore == t.amount, "BRIDGE: mint not settled");
        }

        emit Executed(transferId, t.srcChainId, t.dstToken, t.srcToken, t.recipient, t.amount, sigs.length);
    }

    function _verifySignatures(bytes32 digest, Signature[] calldata sigs) internal view {
        uint256 n = sigs.length;
        require(n >= threshold, "BRIDGE: not enough signatures");
        // A constant ceiling, NOT validators.length. The bound exists only to cap
        // the O(n^2) duplicate scan; tying it to the live validator count made a
        // rotation invalidate in-flight bundles whose CONTENT was a perfectly good
        // quorum — a relayer that collects every signature it can get would be
        // rejected on arity before a single ecrecover ran. Signatures from removed
        // validators are still rejected one at a time, below, which is the right
        // place for that decision.
        require(n <= MAX_VALIDATORS, "BRIDGE: too many signatures");

        address[] memory seen = new address[](n);
        uint256 count;
        for (uint256 i = 0; i < n; i++) {
            address signer = _recover(digest, sigs[i]);
            // A signature that does not belong to a CURRENT validator is ignored,
            // not fatal. It cannot count toward the quorum — that is the only
            // property that matters — and rejecting the whole bundle for its
            // presence threw away perfectly good quorums: relayers collect every
            // signature they can get, so the moment removeValidator() lands, every
            // in-flight bundle carrying the departed signer became unexecutable
            // even though `threshold` current validators had signed it. The
            // decision belongs on the COUNT, below, not on the bundle's contents.
            if (!isValidator[signer]) continue;
            // Duplicates stay fatal. A repeated signer is not a stale extra, it is
            // an attempt to make one vote look like several, and there is no honest
            // relayer behaviour that produces it.
            for (uint256 j = 0; j < count; j++) {
                require(seen[j] != signer, "BRIDGE: duplicate signer");
            }
            seen[count] = signer;
            unchecked {
                count++;
            }
        }
        // The one thing that has ever been enforced here: at least `threshold`
        // DISTINCT current validators signed this exact digest.
        require(count >= threshold, "BRIDGE: below threshold");
    }

    function _recover(bytes32 digest, Signature calldata sig) internal pure returns (address) {
        require(uint256(sig.s) <= HALF_CURVE_ORDER, "BRIDGE: malleable signature");
        require(sig.v == 27 || sig.v == 28, "BRIDGE: bad v");
        address signer = ecrecover(digest, sig.v, sig.r, sig.s);
        require(signer != address(0), "BRIDGE: invalid signature");
        return signer;
    }

    // ------------------------------------------------------ Volume windows
    function _usage(Window storage w) internal view returns (uint256) {
        uint256 last = w.updatedAt;
        if (last == 0) return 0;
        uint256 elapsed = block.timestamp - last;
        if (elapsed >= WINDOW) return 0;
        uint256 used = w.used;
        return used - (used * elapsed) / WINDOW;
    }

    function _consume(Window storage w, uint256 cap, uint256 amount) internal {
        uint256 used = _usage(w) + amount;
        require(used <= cap, "BRIDGE: over 24h cap");
        // cap <= type(uint128).max is enforced in the limit setters, so this fits.
        w.used = uint128(used);
        w.updatedAt = uint64(block.timestamp);
    }

    // ------------------------------------------------------------ Fee sink
    /// @notice Move accrued fees to the fee collector. Callable by the collector
    ///         or the owner; the destination is always the collector.
    /// @dev    Fails closed under exactly the conditions rescue() fails closed
    ///         under. accruedFees and lockedBalance are independent counters, so
    ///         once the bridge is short — an issuer clawback, a blacklist-with-burn,
    ///         a rebase down — a fee sweep would otherwise be paid out of principal
    ///         and would GROW the shortfall owed to inbound transfers. This path
    ///         also skips the pause check by design, so it stays live during
    ///         precisely the incident in which a shortfall appears.
    function withdrawFees(address token) external nonReentrant {
        require(msg.sender == owner || msg.sender == feeCollector, "BRIDGE: not fee authority");
        uint256 amount = accruedFees[token];
        require(amount > 0, "BRIDGE: no fees");
        require(_heldBalance(token) >= lockedBalance[token] + amount, "BRIDGE: impairs collateral");
        accruedFees[token] = 0;
        address to = feeCollector;
        _payOut(token, to, amount);
        emit FeesWithdrawn(token, to, amount);
    }

    // -------------------------------------------------------------- Rescue
    /**
     * @notice Move tokens the bridge holds but does not owe — airdrops, dust,
     *         mistaken direct transfers. Cannot touch lockedBalance or accrued
     *         fees: the movable amount is capped at surplusOf(token) on every call.
     *
     * @dev    TWO SPEEDS, and the split is deliberate:
     *
     *           * UNREGISTERED token — instant, owner. Nobody's collateral is
     *             denominated in an asset this bridge does not route, so the
     *             surplus is the entire balance and there is nothing to protect.
     *             Making the junk-drawer wait 48h buys no safety.
     *           * REGISTERED token — TIMELOCKED (onlySelf, so reachable only via
     *             queue + executeAction). For a routed asset, "surplus" is a
     *             DERIVED figure: balance minus lockedBalance minus accruedFees.
     *             Any accounting defect that overstates it — the short-delivery
     *             escape below writes a transfer down by more than the bridge
     *             actually parted with, and does so by design — turns instant
     *             rescue into the exit that makes the defect exploitable. That is
     *             precisely what the round-2 verifier flagged. Behind the timelock
     *             the same withdrawal costs a public ActionQueued and 48h in which
     *             anyone reconciling the books can pause().
     *
     *         Settlement is the ordinary strict rule, like every other payout: a
     *         rescue must move exactly `amount` and deliver exactly `amount`. The
     *         consequence is that an airdropped fee-on-transfer token cannot be
     *         swept at all — it stays in the contract as inert, unclaimable
     *         surplus. That is the correct trade: this contract has exactly one
     *         settlement rule, and a cleanup convenience is not worth a second one.
     */
    function rescue(address token, address to, uint256 amount) external nonReentrant {
        if (msg.sender != address(this)) {
            _onlyOwner();
            require(_tokenConfig[token].kind == TokenKind.UNREGISTERED, "BRIDGE: timelocked");
        }
        require(to != address(0), "BRIDGE: zero to");
        // Rescuing to ourselves is a pure no-op that would emit a Rescued event
        // indistinguishable from a real one.
        require(to != address(this), "BRIDGE: to is bridge");
        require(amount > 0, "BRIDGE: zero amount");
        require(amount <= surplusOf(token), "BRIDGE: exceeds surplus");
        _payOut(token, to, amount);
        emit Rescued(token, to, amount);
    }

    // ------------------------------------------------- Immediate safety ops
    /// @notice Halt every send() and execute(). Pauser key or owner, no delay.
    function pause() external onlyPauser {
        require(!paused, "BRIDGE: already paused");
        paused = true;
        emit Paused(msg.sender);
    }

    /// @notice Halt one token in both directions. Pauser key or owner, no delay.
    function pauseToken(address localToken) external onlyPauser {
        TokenConfig storage cfg = _registeredConfig(localToken);
        require(!cfg.paused, "BRIDGE: already paused");
        cfg.paused = true;
        emit TokenPaused(localToken, msg.sender);
    }

    /// @notice Resume. Owner multisig only — a single pauser key must never be
    ///         able to re-open the bridge it closed.
    function unpause() external onlyOwner {
        require(paused, "BRIDGE: not paused");
        paused = false;
        emit Unpaused(msg.sender);
    }

    function unpauseToken(address localToken) external onlyOwner {
        TokenConfig storage cfg = _tokenConfig[localToken];
        require(cfg.paused, "BRIDGE: not paused");
        cfg.paused = false;
        emit TokenUnpaused(localToken, msg.sender);
    }

    /// @notice Tighten limits with NO timelock. Both values may only go down;
    ///         zero is allowed and means "this token stops moving".
    function decreaseTokenLimits(address localToken, uint256 newMaxPerTransfer, uint256 newDailyCap)
        external
        onlyOwner
    {
        TokenConfig storage cfg = _registeredConfig(localToken);
        require(newMaxPerTransfer <= cfg.maxPerTransfer && newDailyCap <= cfg.dailyCap, "BRIDGE: not a decrease");
        _writeLimits(cfg, localToken, newMaxPerTransfer, newDailyCap, true);
    }

    /// @dev The one place limits are written, shared by the instant decrease and
    ///      the timelocked setter so the event can never be emitted from only one
    ///      of them.
    function _writeLimits(
        TokenConfig storage cfg,
        address localToken,
        uint256 newMaxPerTransfer,
        uint256 newDailyCap,
        bool immediate
    ) internal {
        cfg.maxPerTransfer = newMaxPerTransfer;
        cfg.dailyCap = newDailyCap;
        emit TokenLimitsChanged(localToken, newMaxPerTransfer, newDailyCap, immediate);
    }

    function setPauser(address account, bool allowed) external onlyOwner {
        require(account != address(0), "BRIDGE: zero pauser");
        isPauser[account] = allowed;
        emit PauserSet(account, allowed);
    }

    // ----------------------------------------------------------- Ownership
    /**
     * @notice Propose a new owner. TIMELOCKED — reachable only through
     *         queue() + executeAction(), so the largest blast radius in the
     *         system announces itself with ActionQueued 48h before pendingOwner
     *         is even set, and cancelAction() revokes it for free in the meantime.
     *         Acceptance stays a plain second step by the incoming owner.
     */
    function transferOwnership(address newOwner) external onlySelf {
        require(newOwner != address(0), "BRIDGE: zero owner");
        pendingOwner = newOwner;
        uint64 expiry = uint64(block.timestamp) + OWNERSHIP_ACCEPT_WINDOW;
        pendingOwnerExpiry = expiry;
        emit OwnershipTransferStarted(newOwner, expiry);
    }

    /// @notice Revoke a handover that has already been proposed. Instant and
    ///         owner-only: withdrawing a key is a safety action and must never
    ///         wait behind a timelock.
    function cancelOwnershipTransfer() external onlyOwner {
        address canceled = pendingOwner;
        require(canceled != address(0), "BRIDGE: no pending owner");
        pendingOwner = address(0);
        pendingOwnerExpiry = 0;
        emit OwnershipTransferCanceled(canceled);
    }

    function acceptOwnership() external {
        require(msg.sender == pendingOwner, "BRIDGE: not pending owner");
        // An offer that is never taken up dies instead of standing forever as a
        // silent takeover key on a candidate address nobody is still guarding.
        require(block.timestamp <= pendingOwnerExpiry, "BRIDGE: offer expired");
        emit OwnershipTransferred(owner, pendingOwner);
        owner = pendingOwner;
        pendingOwner = address(0);
        pendingOwnerExpiry = 0;
    }

    // ------------------------------------------------------------ Timelock
    /**
     * @notice Queue a privileged config change. `data` must be an abi-encoded
     *         call to one of the whitelisted onlySelf setters; nothing else can
     *         ever be queued, so the timelock is not an arbitrary-call machine.
     */
    function queue(bytes calldata data) external onlyOwner returns (uint256 actionId) {
        require(data.length >= 4, "BRIDGE: bad action data");
        bytes4 selector = bytes4(data[0:4]);
        require(_isTimelocked(selector), "BRIDGE: not timelockable");

        uint64 eta = uint64(block.timestamp) + timelockDelay;
        actionId = _actions.length;
        _actions.push(Action({data: data, eta: eta, executed: false, canceled: false}));
        emit ActionQueued(actionId, selector, data, eta);
    }

    function executeAction(uint256 actionId) external onlyOwner returns (bytes memory result) {
        Action storage a = _pendingActionAt(actionId);
        require(block.timestamp >= a.eta, "BRIDGE: timelock not elapsed");
        require(block.timestamp <= uint256(a.eta) + GRACE_PERIOD, "BRIDGE: action stale");

        a.executed = true;
        bytes memory data = a.data;
        (bool ok, bytes memory ret) = address(this).call(data);
        if (!ok) {
            // bubble the inner revert reason
            assembly {
                revert(add(ret, 0x20), mload(ret))
            }
        }
        emit ActionExecuted(actionId, bytes4(data));
        return ret;
    }

    function cancelAction(uint256 actionId) external onlyOwner {
        Action storage a = _pendingActionAt(actionId);
        a.canceled = true;
        emit ActionCanceled(actionId, bytes4(a.data));
    }

    function _actionAt(uint256 actionId) internal view returns (Action storage) {
        require(actionId < _actions.length, "BRIDGE: no such action");
        return _actions[actionId];
    }

    /// @dev An action that still exists and has neither fired nor been revoked.
    ///      Shared by executeAction and cancelAction so the two can never drift on
    ///      which states are still actionable.
    function _pendingActionAt(uint256 actionId) internal view returns (Action storage a) {
        a = _actionAt(actionId);
        require(!a.executed, "BRIDGE: action executed");
        require(!a.canceled, "BRIDGE: action canceled");
    }

    function _isTimelocked(bytes4 selector) internal pure returns (bool) {
        return selector == this.registerCanonical.selector || selector == this.registerWrapped.selector
            || selector == this.setTokenLimits.selector || selector == this.addValidator.selector
            || selector == this.removeValidator.selector || selector == this.setThreshold.selector
            || selector == this.setFeeBps.selector || selector == this.setFeeCollector.selector
            || selector == this.setTimelockDelay.selector || selector == this.transferOwnership.selector
            || selector == this.proposeWrapperBridge.selector || selector == this.setBridgeTokenCodehash.selector
            || selector == this.setRemoteBridge.selector || selector == this.allowShortDelivery.selector
            || selector == this.rescue.selector;
    }

    // -------------------------------------------- Timelocked setters (self)
    /// @notice Register a token whose real supply lives on THIS chain.
    ///         localToken == address(0) registers the chain's native coin.
    /// @dev    A non-native canonical token is probed: it must have code AND must
    ///         answer balanceOf(). That is the one thing about a token's behaviour
    ///         the registry CAN enforce on-chain — it rejects a non-ERC20 address
    ///         and a proxy that is already dark at registration time. It does not,
    ///         and cannot, prove the token transfers exactly. That is enforced
    ///         where it is observable: at every deposit and every release, by
    ///         measured effect, with no exception (see _settle).
    function registerCanonical(
        address localToken,
        uint64 remoteChainId,
        address remoteToken,
        uint256 maxPerTransfer,
        uint256 dailyCap
    ) external onlySelf {
        if (localToken != address(0)) {
            require(localToken.code.length > 0, "BRIDGE: token not a contract");
            // Reverts if the callee is not answering ERC20 reads: the settlement
            // metering in send()/execute() is built entirely on this call, so a
            // token that cannot answer it can never be released and must never be
            // registered in the first place.
            _balanceOf(localToken, address(this));
        }
        _register(localToken, TokenKind.CANONICAL, remoteChainId, remoteToken, maxPerTransfer, dailyCap);
    }

    /// @notice Register a BridgeToken this bridge mints for a remote canonical asset.
    /// @dev    Two independent gates, because a wrapper the bridge does not fully
    ///         control puts the COUNTERPART chain's collateral — other users'
    ///         principal — at that wrapper author's discretion:
    ///           1. the runtime bytecode must be exactly `bridgeTokenCodehash`.
    ///              `bridge()` returning the right address proves nothing: any
    ///              contract can return anything, and a proxy can pass on Monday
    ///              and defect on Tuesday. Pinning the code rejects every proxy.
    ///           2. that pinned code must name THIS bridge as its minter.
    function registerWrapped(
        address localToken,
        uint64 remoteChainId,
        address remoteToken,
        uint256 maxPerTransfer,
        uint256 dailyCap
    ) external onlySelf {
        require(localToken != address(0), "BRIDGE: wrapped is not native");
        require(localToken.code.length > 0, "BRIDGE: token not a contract");
        _requirePinned(localToken);
        // The bridge must actually be the minter, or inbound transfers would be
        // unfillable and outbound burns impossible.
        require(IBridgeToken(localToken).bridge() == address(this), "BRIDGE: not the minter");
        _register(localToken, TokenKind.WRAPPED, remoteChainId, remoteToken, maxPerTransfer, dailyCap);
    }

    /// @dev The wrapper bytecode gate, shared by registerWrapped and adoptWrapper.
    ///      Fails closed while the pin is unset — and note EXTCODEHASH answers 0
    ///      for an account that does not exist, so the `pin != 0` test is what
    ///      stops an unset pin from matching every empty address.
    function _requirePinned(address localToken) internal view {
        bytes32 pin = bridgeTokenCodehash;
        require(pin != bytes32(0), "BRIDGE: wrapper pin unset");
        require(localToken.codehash == pin, "BRIDGE: wrapper not pinned");
    }

    /// @notice Pin the exact wrapper bytecode registerWrapped will accept.
    ///         Timelocked: swapping the pin is how you would smuggle a hostile
    ///         wrapper in, so it costs its own 48h ActionQueued announcement.
    function setBridgeTokenCodehash(bytes32 newCodehash) external onlySelf {
        require(newCodehash != bytes32(0), "BRIDGE: zero codehash");
        bridgeTokenCodehash = newCodehash;
        emit BridgeTokenCodehashChanged(newCodehash);
    }

    /// @dev The registry read every live path starts from. Five call sites shared
    ///      the same two lines; one of them is now the only place that decides what
    ///      "registered" means.
    function _registeredConfig(address localToken) internal view returns (TokenConfig storage cfg) {
        cfg = _tokenConfig[localToken];
        require(cfg.kind != TokenKind.UNREGISTERED, "BRIDGE: token not registered");
    }

    function _register(
        address localToken,
        TokenKind kind,
        uint64 remoteChainId,
        address remoteToken,
        uint256 maxPerTransfer,
        uint256 dailyCap
    ) internal {
        TokenConfig storage cfg = _tokenConfig[localToken];
        require(cfg.kind == TokenKind.UNREGISTERED, "BRIDGE: already registered");
        require(remoteChainId != 0, "BRIDGE: zero remote chain");
        require(remoteChainId != block.chainid, "BRIDGE: remote is local");
        // No route may exist for a chain whose bridge address we do not know:
        // send()'s remote-bridge guard has to be able to fire, and an operator who
        // has not yet identified the counterpart deployment has not finished
        // standing the route up. See setRemoteBridge().
        require(remoteBridge[remoteChainId] != address(0), "BRIDGE: remote bridge unset");
        _requireSaneLimits(maxPerTransfer, dailyCap);
        // One remote asset, one local mirror. Registration is once-only and there
        // is no unregister, so the strictest possible validation belongs here: a
        // second registration against the same remote pair would let one remote
        // deposit be credited twice, on two local assets, with both per-token caps
        // still reading as respected.
        require(_localTokenFor[remoteChainId][remoteToken] == address(0), "BRIDGE: remote already routed");
        _localTokenFor[remoteChainId][remoteToken] = localToken == address(0) ? NATIVE_ROUTE : localToken;

        cfg.kind = kind;
        cfg.remoteChainId = remoteChainId;
        cfg.remoteToken = remoteToken;
        cfg.maxPerTransfer = maxPerTransfer;
        cfg.dailyCap = dailyCap;
        registeredTokens.push(localToken);

        emit TokenRegistered(localToken, kind, remoteChainId, remoteToken, maxPerTransfer, dailyCap);
    }

    /**
     * @notice Record the counterpart bridge deployment on `remoteChainId`.
     *         MANDATORY before any token can be registered for that chain, and
     *         timelocked, because it is the address send() refuses to pay: pointing
     *         it at the wrong place would quietly re-open the guard it exists for.
     *         Re-settable, so a counterpart migration can be followed.
     */
    function setRemoteBridge(uint64 remoteChainId, address remoteBridgeAddress) external onlySelf {
        require(remoteChainId != 0, "BRIDGE: zero remote chain");
        require(remoteChainId != block.chainid, "BRIDGE: remote is local");
        require(remoteBridgeAddress != address(0), "BRIDGE: zero bridge");
        // Recording OURSELVES as the counterpart would make send()'s guard a
        // duplicate of the local check and leave the real remote address unnamed.
        require(remoteBridgeAddress != address(this), "BRIDGE: same bridge");
        remoteBridge[remoteChainId] = remoteBridgeAddress;
        emit RemoteBridgeChanged(remoteChainId, remoteBridgeAddress);
    }

    /**
     * @notice THE STRAND ESCAPE. Authorise ONE named inbound transfer — and only
     *         that one — to settle for less than it promised its recipient.
     *
     *         The situation it exists for: a canonical token that settled exactly
     *         when its collateral was locked starts taxing its transfers
     *         afterwards. From that moment every release reverts
     *         (`BRIDGE: inexact transfer`), correctly — the bridge refuses to
     *         short-pay anybody silently — and the locked collateral cannot come
     *         out. Deposits refuse at the same instant, so the hole stops growing,
     *         but the users already inside are stuck. Somebody has to be able to
     *         say, on the record, "this transfer will deliver less than it owes,
     *         and we are doing it anyway."
     *
     * @dev    Why this cannot become a withdrawal, in the order an attacker would
     *         try it:
     *
     *           * It moves NOTHING. It writes one bit. The value only moves when
     *             the named transfer is executed through the ordinary execute(),
     *             which still demands a full validator quorum over the EIP-712
     *             digest of that exact transfer. The owner cannot mint a transfer.
     *           * The transferId commits to every field — token, recipient,
     *             amount, both chain ids, nonce — so the authorisation is welded
     *             to one payout to one address for at most one amount. Changing
     *             any of them is a different transferId that this bit does not
     *             cover.
     *           * The bridge still may not part with MORE than `t.amount`
     *             (_settle's solvency rail), still may not pay a recipient that
     *             receives nothing, and still writes lockedBalance down by
     *             `t.amount` — so the release cannot reach past its own transfer
     *             into anyone else's collateral.
     *           * It is single-use: execute() clears the bit before it calls out.
     *           * It is timelocked (onlySelf), so it announces itself with
     *             ActionQueued 48h ahead, carrying the transferId, the token, the
     *             recipient and the amount owed in plain calldata — and
     *             cancelShortDelivery() revokes it instantly and for free at any
     *             point in that window.
     *
     *         Registration must be CANONICAL: a WRAPPED release is a mint, which
     *         is exact by construction, and "short mint" is not a thing that can
     *         happen — while a relaxed mint WOULD be a licence to under-deliver
     *         against the counterpart chain's collateral. The native coin is
     *         rejected for the mirror reason: a value-bearing call either delivers
     *         msg.value or reverts, so a chain's own coin cannot short-deliver and
     *         an authorisation over it would be a comforting no-op.
     *
     *         NOTE the reflection shape leaves the bridge holding more than the
     *         write-down: that residue becomes surplus. It is not silently
     *         extractable — rescue() of a REGISTERED token is itself timelocked.
     */
    function allowShortDelivery(BridgeTransfer calldata t) external onlySelf {
        // Canonical AND not the native coin. A wrapped release is a mint, which
        // cannot under-deliver; the native coin either transfers msg.value or
        // reverts, so it cannot either. Refusing both HERE is load-bearing, not
        // tidiness: an armed native transfer would take the _settle path in
        // execute(), _settle calls _requireCode, and address(0) has no code — so
        // the authorisation would brick the very transfer it was meant to free
        // until somebody noticed and revoked it.
        require(
            t.dstToken != address(0) && _tokenConfig[t.dstToken].kind == TokenKind.CANONICAL, "BRIDGE: not canonical"
        );
        bytes32 transferId = transferIdOf(t);
        shortDeliveryArmed = transferId;
        emit ShortDeliveryAllowed(transferId, t.dstToken, t.recipient, t.amount);
    }

    /// @notice Withdraw a short-delivery authorisation. Instant and owner-only:
    ///         revoking a permission is a safety action and never waits, exactly
    ///         like cancelAction and cancelOwnershipTransfer.
    function cancelShortDelivery() external onlyOwner {
        bytes32 armed = shortDeliveryArmed;
        require(armed != bytes32(0), "BRIDGE: not allowed");
        shortDeliveryArmed = bytes32(0);
        emit ShortDeliveryRevoked(armed);
    }

    /// @notice Set limits in either direction. Timelocked, because raising a cap
    ///         raises the blast radius of a validator compromise.
    function setTokenLimits(address localToken, uint256 newMaxPerTransfer, uint256 newDailyCap) external onlySelf {
        TokenConfig storage cfg = _registeredConfig(localToken);
        _requireSaneLimits(newMaxPerTransfer, newDailyCap);
        _writeLimits(cfg, localToken, newMaxPerTransfer, newDailyCap, false);
    }

    /// @dev Shared by setTokenLimits and _register: a live route always has a
    ///      non-zero per-transfer ceiling and a daily cap that fits the uint128
    ///      the draining bucket stores.
    function _requireSaneLimits(uint256 maxPerTransfer, uint256 dailyCap) internal pure {
        require(maxPerTransfer > 0, "BRIDGE: zero per-transfer cap");
        require(dailyCap > 0, "BRIDGE: zero daily cap");
        require(dailyCap <= type(uint128).max, "BRIDGE: cap too large");
    }

    function addValidator(address validator) external onlySelf {
        require(validator != address(0), "BRIDGE: zero validator");
        require(!isValidator[validator], "BRIDGE: already a validator");
        require(validators.length < MAX_VALIDATORS, "BRIDGE: too many validators");
        isValidator[validator] = true;
        validators.push(validator);
        emit ValidatorAdded(validator);
    }

    function removeValidator(address validator) external onlySelf {
        require(isValidator[validator], "BRIDGE: not a validator");
        require(validators.length - 1 >= threshold, "BRIDGE: threshold unreachable");
        isValidator[validator] = false;
        uint256 n = validators.length;
        for (uint256 i = 0; i < n; i++) {
            if (validators[i] == validator) {
                validators[i] = validators[n - 1];
                validators.pop();
                break;
            }
        }
        emit ValidatorRemoved(validator);
    }

    function setThreshold(uint256 newThreshold) external onlySelf {
        require(newThreshold >= 1 && newThreshold <= validators.length, "BRIDGE: bad threshold");
        threshold = newThreshold;
        emit ThresholdChanged(newThreshold);
    }

    function setFeeBps(uint256 newFeeBps) external onlySelf {
        require(newFeeBps <= MAX_FEE_BPS, "BRIDGE: fee too high");
        feeBps = newFeeBps;
        emit FeeBpsChanged(newFeeBps);
    }

    /// @dev The bridge itself is rejected: withdrawFees() to this address is a
    ///      self-transfer that zeroes accruedFees without moving anything, which
    ///      silently reclassifies the whole fee balance as rescue()-able surplus.
    ///      That is a third route from a reserved bucket into the unreserved one,
    ///      and the accounting story depends on those buckets being one-way.
    function setFeeCollector(address newCollector) external onlySelf {
        require(newCollector != address(0), "BRIDGE: zero collector");
        require(newCollector != address(this), "BRIDGE: collector is bridge");
        feeCollector = newCollector;
        emit FeeCollectorChanged(newCollector);
    }

    // ------------------------------------------- Wrapper minter rotation
    /**
     * @notice Start handing this bridge's minter rights over a wrapped token to
     *         `newBridge`. TIMELOCKED here, and subject to a second delay inside
     *         BridgeToken before the handover can be accepted.
     *
     *         Without this, a migration strands every wrapped holder: a redeployed
     *         bridge could never be named minter, so it could never register the
     *         wrapper, so it could never burn it — and the only exit for holders
     *         would be to unpause the very contract the migration was fleeing.
     */
    /// @dev    The rotation target must be a CONTRACT that positively identifies
    ///         itself as a Ferminux bridge. Without this the timelock's own
    ///         escape hatch hands the owner something the previous immutable-minter
    ///         design never permitted: point a live wrapper's minter seat at a
    ///         plain key and that key mints unbacked wrapped supply forever,
    ///         against collateral sitting on the counterpart chain. Code length
    ///         alone is not enough (a two-line contract has code), so the
    ///         candidate has to answer BRIDGE_INTERFACE_ID() with the right value.
    ///         A determined owner could still deploy a contract that lies — but
    ///         they must deploy one, in public, 48h before the handover lands,
    ///         which is the difference between a mistake and a conspiracy.
    function proposeWrapperBridge(address localToken, address newBridge) external onlySelf nonReentrant {
        require(newBridge != address(0), "BRIDGE: zero bridge");
        require(newBridge != address(this), "BRIDGE: same bridge");
        // No separate code-length check is needed: a staticcall into an address
        // with no code succeeds with EMPTY returndata, so the length test below
        // rejects every EOA before the value is even compared.
        (bool ok, bytes memory ret) =
            newBridge.staticcall(abi.encodeWithSelector(IFerminuxBridgeIdentity.BRIDGE_INTERFACE_ID.selector));
        require(ok && ret.length == 32 && abi.decode(ret, (bytes32)) == BRIDGE_INTERFACE_ID, "BRIDGE: not a bridge");
        _requirePinned(localToken);
        IBridgeToken(localToken).proposeBridge(newBridge);
        emit WrapperBridgeRotationProposed(localToken, newBridge);
    }

    /// @notice Revoke a proposed handover before it is accepted. Instant and
    ///         owner-only — same rule as every other revocation here.
    /// @dev    nonReentrant: this is an owner-triggered call into an address the
    ///         owner names, so the callee gets control of the thread. It is
    ///         deliberately NOT gated on the codehash pin — a revocation must stay
    ///         available even for a wrapper the pin has since moved away from.
    ///         A code-less target needs no explicit check: cancelBridgeRotation()
    ///         returns nothing, so the compiler's own extcodesize guard reverts.
    function cancelWrapperBridgeRotation(address localToken) external onlyOwner nonReentrant {
        IBridgeToken(localToken).cancelBridgeRotation();
        emit WrapperBridgeRotationCanceled(localToken);
    }

    /// @notice Take up minter rights over `localToken` that the previous bridge
    ///         proposed to this one and whose rotation delay has elapsed.
    /// @dev    Not timelocked, deliberately. Holding un-registered minter rights is
    ///         inert: nothing in this contract calls mint() or burn() on a token
    ///         that is not registered, and registerWrapped is itself timelocked.
    ///         So this grants no power on its own, and making the wrapped supply
    ///         redeemable again after an incident should not wait 48h twice.
    ///
    ///         nonReentrant, and gated on the codehash pin: the only wrapper worth
    ///         adopting is one this bridge could go on to register, and pinning it
    ///         means the callback below lands in audited BridgeToken code rather
    ///         than an arbitrary address the owner chose.
    function adoptWrapper(address localToken) external onlyOwner nonReentrant {
        _requirePinned(localToken);
        IBridgeToken(localToken).acceptBridge();
        emit WrapperAdopted(localToken);
    }

    function setTimelockDelay(uint64 newDelay) external onlySelf {
        require(newDelay >= MIN_TIMELOCK_DELAY && newDelay <= MAX_TIMELOCK_DELAY, "BRIDGE: bad delay");
        timelockDelay = newDelay;
        emit TimelockDelayChanged(newDelay);
    }

    // ------------------------------------------------------ ERC20 plumbing
    /**
     * @dev Guards a raw `.call` does not give you for free.
     *
     *      1. CODE. The empty-return branch below is required for USDT-shaped
     *         tokens, but a `.call` to an address with no code also returns
     *         ok = true with empty returndata, so without this check a token that
     *         has gone dark passes as a successful transfer. That is reachable:
     *         SELFDESTRUCT still clears code on pre-Cancun chains (Ferminux-geth
     *         is a geth 1.10.26 fork), and any token behind a proxy whose
     *         implementation is zeroed keeps its own code while delegatecalling
     *         into nothing — on every chain.
     *      2. SETTLEMENT. A dead proxy DOES have code, so the check above cannot
     *         see it. This matters most in execute(), which is
     *         checks-effects-interactions correct: processed[] and lockedBalance
     *         are already committed by the time we get here, so a fake success
     *         would burn the transferId and write down the collateral while paying
     *         nobody — final and unretryable, unlike every other failure mode in
     *         this contract, all of which revert.
     *
     *      Settlement is measured on BOTH sides:
     *
     *        `paid`      = how much the bridge's own balance fell
     *        `delivered` = how much the recipient's balance rose
     *
     *      _settle() performs the transfer and enforces the three refusals that
     *      hold for EVERY payout this contract can make, with no exception and no
     *      switch to turn them off:
     *
     *        paid > 0       rejects the dead proxy and the silent no-op: a call
     *                       that moved nothing can never pass, whatever it
     *                       returned.
     *        delivered > 0  rejects the shape the bridge-side read alone is blind
     *                       to — a token that debits the bridge and credits nobody
     *                       (burn-on-transfer, a blacklist that swallows instead
     *                       of reverting).
     *        paid <= amount is the solvency rail: a token may charge its fee out
     *                       of `amount`, never on top of it, so one payout can
     *                       never eat into another user's collateral.
     *
     *      _safeTransfer() — the path EVERY ordinary payout takes — then demands
     *      the full strict rule: `paid == amount && delivered == amount`. There is
     *      no token class, no per-token flag and no way for governance to relax
     *      this for an asset. A token that skims, reflects or surcharges is
     *      refused, loudly and retryably, on the release AND on the deposit.
     *
     *      The one exception in the whole contract is the short-delivery escape,
     *      which calls _settle() directly for ONE named, timelocked, publicly
     *      announced transferId at a time — see allowShortDelivery(). It relaxes
     *      only the two equalities; the three refusals above still apply to it.
     *
     *      Why this is not a per-token declaration: a token's class cannot be
     *      discovered on-chain and cannot be trusted once declared. At
     *      registration the bridge holds no balance to probe with, a probe
     *      transfer proves only what the token did once, and a tax that is a
     *      storage flag can be switched on at any time afterwards. A standing
     *      declaration is therefore a permanent hole opened on the strength of a
     *      one-time reading — and, as the round-2 verifier measured, the deposit
     *      half of it credits whatever the token hands back, which for a
     *      reflection token is other people's money. See README §"Settlement".
     */
    function _settle(address token, address to, uint256 amount) internal returns (uint256 paid, uint256 delivered) {
        _requireCode(token);
        uint256 fromBefore = _balanceOf(token, address(this));
        uint256 toBefore = _balanceOf(token, to);

        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(IERC20Minimal.transfer.selector, to, amount));
        require(ok && (ret.length == 0 || abi.decode(ret, (bool))), "BRIDGE: transfer failed");

        uint256 fromAfter = _balanceOf(token, address(this));
        uint256 toAfter = _balanceOf(token, to);
        // Strictly less / strictly more, in one shared refusal:
        //   fromAfter == fromBefore -> the call moved nothing off the bridge; a
        //       dead proxy or a silent no-op, whatever it returned.
        //   fromAfter  > fromBefore -> our balance ROSE while we were paying
        //       someone; refuse rather than let the subtraction wrap.
        //   toAfter   <= toBefore   -> the bridge was debited and the recipient
        //       was credited nothing: burn-on-transfer, or a blacklist that
        //       swallows instead of reverting. The bridge-side read alone is
        //       blind to this, which is why both sides are measured.
        require(fromAfter < fromBefore && toAfter > toBefore, "BRIDGE: transfer not settled");
        unchecked {
            paid = fromBefore - fromAfter;
            delivered = toAfter - toBefore;
        }
        require(paid <= amount, "BRIDGE: inexact transfer");
    }

    /// @dev The strict rule, applied to every ordinary payout: release, fee sweep,
    ///      rescue. Exactly `amount` leaves the bridge and exactly `amount` lands
    ///      on the recipient, or the whole call reverts and nothing is consumed.
    function _safeTransfer(address token, address to, uint256 amount) internal {
        (uint256 paid, uint256 delivered) = _settle(token, to, amount);
        require(paid == amount && delivered == amount, "BRIDGE: inexact transfer");
    }

    /// @dev send() meters the arrival by balance delta and requires that delta to
    ///      be exactly `amount`, so the settlement half is already covered on this
    ///      side; the code check is what a raw `.call` is missing.
    function _safeTransferFrom(address token, address from, address to, uint256 amount) internal {
        _requireCode(token);
        (bool ok, bytes memory ret) =
            token.call(abi.encodeWithSelector(IERC20Minimal.transferFrom.selector, from, to, amount));
        require(ok && (ret.length == 0 || abi.decode(ret, (bool))), "BRIDGE: transferFrom failed");
    }

    function _safeTransferNative(address to, uint256 amount) internal {
        (bool ok,) = to.call{value: amount}("");
        require(ok, "BRIDGE: native transfer failed");
    }

    /// @dev The one place value leaves this contract. Native or ERC20, always
    ///      through the checked helpers above.
    function _payOut(address token, address to, uint256 amount) internal {
        if (token == address(0)) {
            _safeTransferNative(to, amount);
        } else {
            _safeTransfer(token, to, amount);
        }
    }
}
