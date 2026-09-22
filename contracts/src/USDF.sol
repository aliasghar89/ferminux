// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title USDF — Ferminux Dollar
 * @notice USD reserve-backed stablecoin on Ferminux Network.
 *         1 USDF = 1 USD, backed 1:1 by off-chain bank reserves.
 *         6 decimals (USDT/USDC convention).
 *
 * Roles (USDC-style operational model):
 *   ADMIN      — grants/revokes roles (should be a multisig)
 *   MINTER     — mints on verified AZN deposit
 *   BURNER     — burns on AZN redemption
 *   PAUSER     — freezes all transfers in emergency
 *   BLACKLISTER— blocks sanctioned/fraudulent addresses
 *
 * Self-contained: no external imports, compiles standalone with solc >=0.8.24.
 * Includes EIP-2612 permit (gasless approvals).
 */
contract USDF {
    // ---------------------------------------------------------------- ERC20
    string public constant name = "Ferminux Dollar";
    string public constant symbol = "USDF";
    uint8 public constant decimals = 6;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    // ---------------------------------------------------------------- Roles
    bytes32 public constant MINTER = keccak256("MINTER");
    bytes32 public constant BURNER = keccak256("BURNER");
    bytes32 public constant PAUSER = keccak256("PAUSER");
    bytes32 public constant BLACKLISTER = keccak256("BLACKLISTER");

    address public admin;
    address public pendingAdmin;
    mapping(bytes32 => mapping(address => bool)) public hasRole;

    event RoleGranted(bytes32 indexed role, address indexed account);
    event RoleRevoked(bytes32 indexed role, address indexed account);
    event AdminTransferStarted(address indexed newAdmin);
    event AdminTransferred(address indexed oldAdmin, address indexed newAdmin);

    modifier onlyAdmin() {
        require(msg.sender == admin, "USDF: not admin");
        _;
    }

    modifier onlyRole(bytes32 role) {
        require(hasRole[role][msg.sender], "USDF: missing role");
        _;
    }

    // ---------------------------------------------------------------- Pause
    bool public paused;
    event Paused(address account);
    event Unpaused(address account);

    modifier whenNotPaused() {
        require(!paused, "USDF: paused");
        _;
    }

    // ------------------------------------------------------------ Blacklist
    mapping(address => bool) public blacklisted;
    event Blacklisted(address indexed account);
    event UnBlacklisted(address indexed account);

    modifier notBlacklisted(address account) {
        require(!blacklisted[account], "USDF: blacklisted");
        _;
    }

    // ------------------------------------------------------- EIP-2612 permit
    mapping(address => uint256) public nonces;
    bytes32 public constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");
    uint256 private immutable _cachedChainId;
    bytes32 private immutable _cachedDomainSeparator;

    // ---------------------------------------------------------- Constructor
    constructor(address _admin) {
        require(_admin != address(0), "USDF: zero admin");
        admin = _admin;
        _cachedChainId = block.chainid;
        _cachedDomainSeparator = _buildDomainSeparator();
        emit AdminTransferred(address(0), _admin);
    }

    // ---------------------------------------------------------------- Admin
    function grantRole(bytes32 role, address account) external onlyAdmin {
        hasRole[role][account] = true;
        emit RoleGranted(role, account);
    }

    function revokeRole(bytes32 role, address account) external onlyAdmin {
        hasRole[role][account] = false;
        emit RoleRevoked(role, account);
    }

    /// @notice Two-step admin transfer — prevents fat-finger loss of control.
    function transferAdmin(address newAdmin) external onlyAdmin {
        pendingAdmin = newAdmin;
        emit AdminTransferStarted(newAdmin);
    }

    function acceptAdmin() external {
        require(msg.sender == pendingAdmin, "USDF: not pending admin");
        emit AdminTransferred(admin, pendingAdmin);
        admin = pendingAdmin;
        pendingAdmin = address(0);
    }

    // ----------------------------------------------------------- Mint/Burn
    /// @notice Mint USDF after a verified USD bank deposit. Ops-side only.
    function mint(address to, uint256 amount)
        external
        onlyRole(MINTER)
        whenNotPaused
        notBlacklisted(to)
    {
        totalSupply += amount;
        unchecked { balanceOf[to] += amount; }
        emit Transfer(address(0), to, amount);
    }

    /// @notice Burn from the ops wallet when USD is redeemed to the user's bank.
    function burn(uint256 amount) external onlyRole(BURNER) {
        balanceOf[msg.sender] -= amount;
        unchecked { totalSupply -= amount; }
        emit Transfer(msg.sender, address(0), amount);
    }

    /// @notice Destroy funds of a blacklisted address (court order / confirmed fraud).
    function destroyBlackFunds(address account) external onlyRole(BLACKLISTER) {
        require(blacklisted[account], "USDF: not blacklisted");
        uint256 bal = balanceOf[account];
        balanceOf[account] = 0;
        totalSupply -= bal;
        emit Transfer(account, address(0), bal);
    }

    // -------------------------------------------------------------- Pause
    function pause() external onlyRole(PAUSER) {
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyRole(PAUSER) {
        paused = false;
        emit Unpaused(msg.sender);
    }

    // ---------------------------------------------------------- Blacklist
    function blacklist(address account) external onlyRole(BLACKLISTER) {
        blacklisted[account] = true;
        emit Blacklisted(account);
    }

    function unBlacklist(address account) external onlyRole(BLACKLISTER) {
        blacklisted[account] = false;
        emit UnBlacklisted(account);
    }

    // ------------------------------------------------------------ Transfers
    function transfer(address to, uint256 amount)
        external
        whenNotPaused
        notBlacklisted(msg.sender)
        notBlacklisted(to)
        returns (bool)
    {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount)
        external
        whenNotPaused
        notBlacklisted(msg.sender)
        notBlacklisted(from)
        notBlacklisted(to)
        returns (bool)
    {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= amount, "USDF: insufficient allowance");
            unchecked { allowance[from][msg.sender] = allowed - amount; }
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
        require(to != address(0), "USDF: transfer to zero");
        balanceOf[from] -= amount;
        unchecked { balanceOf[to] += amount; }
        emit Transfer(from, to, amount);
    }

    // -------------------------------------------------------------- Permit
    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return block.chainid == _cachedChainId
            ? _cachedDomainSeparator
            : _buildDomainSeparator();
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

    function permit(
        address owner,
        address spender,
        uint256 value,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        require(block.timestamp <= deadline, "USDF: permit expired");
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                DOMAIN_SEPARATOR(),
                keccak256(abi.encode(PERMIT_TYPEHASH, owner, spender, value, nonces[owner]++, deadline))
            )
        );
        address recovered = ecrecover(digest, v, r, s);
        require(recovered != address(0) && recovered == owner, "USDF: invalid signature");
        allowance[owner][spender] = value;
        emit Approval(owner, spender, value);
    }
}
