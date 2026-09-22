// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title BridgeToken
 * @notice Wrapped representation of a token that is canonical on ANOTHER chain.
 *         Deployed once per (origin chain, origin token) pair on the destination
 *         chain and registered in that chain's FerminuxBridge as a WRAPPED asset.
 *
 *         Supply is fully controlled by the bridge:
 *           - mint()  — only the bridge, when a signed inbound transfer executes
 *           - burn()  — only the bridge, when the holder sends the asset home
 *         There is no owner, no owner mint, no upgrade path, no pause. If the
 *         bridge is honest the wrapped supply is exactly the collateral locked
 *         on the origin chain; nothing else in this contract can change supply.
 *
 *         The minter seat CAN be rotated, and only by the current bridge, through
 *         a two-step handover separated by ROTATION_DELAY. That exists because the
 *         documented incident response is "pause() and migrate": with an immutable
 *         minter, a redeployed bridge could never adopt the outstanding wrapped
 *         supply, so holders would have no exit that did not run through the very
 *         contract the migration was fleeing. The rotation is as slow and as loud
 *         as the rest of governance — the propose call is itself behind the
 *         bridge's 48h timelock, and this contract adds its own delay on top.
 *
 *         NOTE ON BYTECODE: this contract has NO immutables, deliberately. Every
 *         deployment therefore has byte-identical runtime code, which is what lets
 *         FerminuxBridge.registerWrapped pin wrappers by codehash. Do not convert
 *         these fields back to `immutable`: it would make each deployment's code
 *         unique and silently break that pin.
 *
 *         name / symbol / decimals mirror the origin asset so wallets and the
 *         explorer render "5.25 wFMX" identically on both sides. originChainId
 *         and originToken are recorded on-chain as provenance — a wallet can
 *         prove which asset a wrapper claims to represent without a registry.
 *
 * Self-contained: no external imports, compiles standalone with solc >=0.8.24.
 * Includes EIP-2612 permit (gasless approvals).
 */
contract BridgeToken {
    // ---------------------------------------------------------------- ERC20
    string public name;
    string public symbol;
    uint8 public decimals;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    // ------------------------------------------------------------ Provenance
    /// @notice The only address allowed to mint or burn. Rotatable ONLY by itself,
    ///         through proposeBridge() + acceptBridge() with ROTATION_DELAY between.
    address public bridge;
    /// @notice Chain id on which the mirrored asset is canonical.
    uint64 public originChainId;
    /// @notice Address of the mirrored asset on `originChainId`.
    ///         address(0) means the origin chain's NATIVE coin (e.g. FMX, ETH).
    address public originToken;

    // ------------------------------------------------------- Minter rotation
    /// @notice Notice period between proposing a new minter and it being able to
    ///         accept. Matches FerminuxBridge's default timelock, and stacks on top
    ///         of it: the propose call is a timelocked action over there, so a
    ///         handover is announced at least twice and cannot land inside 96h.
    uint64 public constant ROTATION_DELAY = 48 hours;

    /// @notice Bridge that has been offered the minter seat but has not taken it.
    address public pendingBridge;
    /// @notice Earliest timestamp at which pendingBridge may call acceptBridge().
    uint64 public bridgeRotationEta;

    event BridgeMinted(address indexed to, uint256 amount);
    event BridgeBurned(address indexed from, uint256 amount);
    event BridgeRotationProposed(address indexed newBridge, uint64 eta);
    event BridgeRotationCanceled(address indexed canceledBridge);
    event BridgeRotated(address indexed previousBridge, address indexed newBridge);

    modifier onlyBridge() {
        require(msg.sender == bridge, "WTOKEN: not bridge");
        _;
    }

    // ------------------------------------------------------- EIP-2612 permit
    mapping(address => uint256) public nonces;
    bytes32 public constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");
    uint256 private _cachedChainId;
    bytes32 private _cachedDomainSeparator;

    // ----------------------------------------------------------- Constructor
    constructor(
        string memory _name,
        string memory _symbol,
        uint8 _decimals,
        address _bridge,
        uint64 _originChainId,
        address _originToken
    ) {
        require(bytes(_name).length >= 1 && bytes(_name).length <= 64, "WTOKEN: name len");
        require(bytes(_symbol).length >= 1 && bytes(_symbol).length <= 16, "WTOKEN: symbol len");
        require(_decimals <= 18, "WTOKEN: decimals");
        require(_bridge != address(0), "WTOKEN: zero bridge");
        require(_originChainId != 0, "WTOKEN: zero origin chain");
        require(_originChainId != block.chainid, "WTOKEN: origin is local");

        name = _name;
        symbol = _symbol;
        decimals = _decimals;
        bridge = _bridge;
        originChainId = _originChainId;
        originToken = _originToken;

        _cachedChainId = block.chainid;
        _cachedDomainSeparator = _buildDomainSeparator();
    }

    // --------------------------------------------------- Minter rotation
    /**
     * @notice Offer the minter seat to `newBridge`. Only the CURRENT bridge may
     *         call this, so the seat can never be taken — only handed over.
     */
    function proposeBridge(address newBridge) external onlyBridge {
        require(newBridge != address(0), "WTOKEN: zero bridge");
        require(newBridge != bridge, "WTOKEN: already the bridge");
        pendingBridge = newBridge;
        uint64 eta = uint64(block.timestamp) + ROTATION_DELAY;
        bridgeRotationEta = eta;
        emit BridgeRotationProposed(newBridge, eta);
    }

    /// @notice Withdraw an offer that has not been accepted yet. Instant, because
    ///         revoking a key is a safety action.
    function cancelBridgeRotation() external onlyBridge {
        address canceled = pendingBridge;
        require(canceled != address(0), "WTOKEN: no rotation");
        pendingBridge = address(0);
        bridgeRotationEta = 0;
        emit BridgeRotationCanceled(canceled);
    }

    /// @notice Take up the minter seat. Only the offered bridge, only once the
    ///         rotation delay has run. Two-step by design: the incoming bridge has
    ///         to exist and has to act, so a typo cannot orphan the wrapper.
    function acceptBridge() external {
        require(msg.sender == pendingBridge, "WTOKEN: not pending bridge");
        require(block.timestamp >= bridgeRotationEta, "WTOKEN: rotation not elapsed");
        address previous = bridge;
        bridge = msg.sender;
        pendingBridge = address(0);
        bridgeRotationEta = 0;
        emit BridgeRotated(previous, msg.sender);
    }

    // ------------------------------------------------------------ Supply
    /// @notice Credit `amount` to `to`. Only the bridge, only against a signed
    ///         inbound transfer (or an accrued bridge fee).
    function mint(address to, uint256 amount) external onlyBridge {
        require(to != address(0), "WTOKEN: mint to zero");
        totalSupply += amount;
        unchecked {
            balanceOf[to] += amount;
        }
        emit Transfer(address(0), to, amount);
        emit BridgeMinted(to, amount);
    }

    /// @notice Destroy `amount` held by `from`. Only the bridge, and ONLY to the
    ///         extent `from` has approved the bridge to spend — the allowance is
    ///         consumed exactly as `transferFrom` would consume it.
    ///
    ///         WHY THE ALLOWANCE CHECK EXISTS. The previous version relied on the
    ///         bridge's own discipline: it only ever called burn(msg.sender), so
    ///         it could not confiscate. That is a true statement about the code
    ///         that happens to be deployed today, and a worthless one to a holder,
    ///         who would have to (a) read the bridge, (b) trust that it is never
    ///         rotated to something else, and (c) take our word for both. Token
    ///         scanners read it the same way and report "owner can change
    ///         balance", which is the correct reading of a burn that accepts an
    ///         arbitrary `from`.
    ///
    ///         Now the constraint lives in the TOKEN, where the holder can verify
    ///         it: no balance moves without an allowance the holder granted. A
    ///         hostile bridge — including one installed through a rotation —
    ///         cannot burn tokens nobody approved it to spend.
    function burn(address from, uint256 amount) external onlyBridge {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= amount, "WTOKEN: burn exceeds allowance");
            unchecked {
                allowance[from][msg.sender] = allowed - amount;
            }
        }
        balanceOf[from] -= amount;
        unchecked {
            totalSupply -= amount;
        }
        emit Transfer(from, address(0), amount);
        emit BridgeBurned(from, amount);
    }

    // ------------------------------------------------------------ Transfers
    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= amount, "WTOKEN: insufficient allowance");
            unchecked {
                allowance[from][msg.sender] = allowed - amount;
            }
        }
        _transfer(from, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) internal {
        require(to != address(0), "WTOKEN: transfer to zero");
        balanceOf[from] -= amount;
        unchecked {
            balanceOf[to] += amount;
        }
        emit Transfer(from, to, amount);
    }

    // -------------------------------------------------------------- Permit
    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return block.chainid == _cachedChainId ? _cachedDomainSeparator : _buildDomainSeparator();
    }

    function _buildDomainSeparator() private view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes(name)),
                keccak256(bytes("1")),
                block.chainid,
                address(this)
            )
        );
    }

    function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external
    {
        require(block.timestamp <= deadline, "WTOKEN: permit expired");
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                DOMAIN_SEPARATOR(),
                keccak256(abi.encode(PERMIT_TYPEHASH, owner, spender, value, nonces[owner]++, deadline))
            )
        );
        address recovered = ecrecover(digest, v, r, s);
        require(recovered != address(0) && recovered == owner, "WTOKEN: invalid signature");
        allowance[owner][spender] = value;
        emit Approval(owner, spender, value);
    }
}
