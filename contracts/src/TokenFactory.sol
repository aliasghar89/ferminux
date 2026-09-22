// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title Ferminux Token Factory
 * @notice One-click coin launcher: any user deploys their own ERC-20 on Ferminux
 *         by calling launch() and paying a small FMX fee (protocol revenue).
 *
 *         Every launched token is a standard, fixed-or-mintable ERC-20 recorded in
 *         an on-chain registry, so the explorer / wallet / launchpad UI can list
 *         all community coins and verify they came from the official factory
 *         (a basic anti-scam signal: factory tokens have known, unmodified code).
 *
 * Self-contained, no external deps. solc >=0.8.24.
 */

contract FerminuxToken {
    string public name;
    string public symbol;
    uint8 public immutable decimals;
    uint256 public totalSupply;
    uint256 public immutable maxSupply;      // 0 = unlimited (mintable forever)
    address public owner;                     // token creator; can mint if allowed
    bool public immutable mintable;
    address public immutable factory;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event OwnershipTransferred(address indexed from, address indexed to);
    event OwnershipRenounced(address indexed lastOwner);

    modifier onlyOwner() { require(msg.sender == owner, "TOKEN: not owner"); _; }

    constructor(
        string memory _name,
        string memory _symbol,
        uint8 _decimals,
        uint256 _initialSupply,
        uint256 _maxSupply,
        bool _mintable,
        address _creator
    ) {
        require(_maxSupply == 0 || _initialSupply <= _maxSupply, "TOKEN: supply > max");
        name = _name;
        symbol = _symbol;
        decimals = _decimals;
        maxSupply = _maxSupply;
        mintable = _mintable;
        owner = _creator;
        factory = msg.sender;
        totalSupply = _initialSupply;
        balanceOf[_creator] = _initialSupply;
        emit Transfer(address(0), _creator, _initialSupply);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= amount, "TOKEN: allowance");
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
        require(to != address(0), "TOKEN: zero to");
        balanceOf[from] -= amount;
        unchecked { balanceOf[to] += amount; }
        emit Transfer(from, to, amount);
    }

    /// @notice Creator can mint only if the token was launched as mintable.
    function mint(address to, uint256 amount) external onlyOwner {
        require(mintable, "TOKEN: not mintable");
        require(maxSupply == 0 || totalSupply + amount <= maxSupply, "TOKEN: exceeds max");
        totalSupply += amount;
        unchecked { balanceOf[to] += amount; }
        emit Transfer(address(0), to, amount);
    }

    /// @notice Anyone can burn their own tokens.
    function burn(uint256 amount) external {
        balanceOf[msg.sender] -= amount;
        unchecked { totalSupply -= amount; }
        emit Transfer(msg.sender, address(0), amount);
    }

    /// @notice Creator can renounce — makes the token permanently unowned
    ///         (no more minting). Strong trust signal shown in the launchpad UI.
    function renounceOwnership() external onlyOwner {
        emit OwnershipRenounced(owner);
        owner = address(0);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "TOKEN: zero owner");
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }
}

contract TokenFactory {
    address public feeCollector;               // treasury multisig
    uint256 public launchFee = 10 ether;       // 10 FMX per launch; tune via setFee
    uint256 public totalLaunched;

    struct TokenInfo {
        address token;
        address creator;
        string  name;
        string  symbol;
        uint256 createdAt;
        bool    mintable;
    }

    TokenInfo[] public tokens;                          // full registry
    mapping(address => address[]) public tokensByCreator;
    mapping(address => bool) public isFactoryToken;     // anti-scam verification

    event TokenLaunched(
        address indexed token,
        address indexed creator,
        string name,
        string symbol,
        uint256 initialSupply,
        bool mintable
    );
    event FeeChanged(uint256 newFee);
    event FeeCollectorChanged(address newCollector);

    modifier onlyCollector() { require(msg.sender == feeCollector, "FACTORY: not admin"); _; }

    constructor(address _feeCollector) {
        require(_feeCollector != address(0), "FACTORY: zero collector");
        feeCollector = _feeCollector;
    }

    /// @notice Launch your own coin on Ferminux. Pay launchFee in FMX.
    /// @param maxSupply 0 for uncapped (only meaningful if mintable=true)
    function launch(
        string calldata name_,
        string calldata symbol_,
        uint8 decimals_,
        uint256 initialSupply,
        uint256 maxSupply,
        bool mintable_
    ) external payable returns (address token) {
        require(msg.value >= launchFee, "FACTORY: fee");
        require(bytes(name_).length >= 1 && bytes(name_).length <= 64, "FACTORY: name len");
        require(bytes(symbol_).length >= 1 && bytes(symbol_).length <= 12, "FACTORY: symbol len");
        require(decimals_ <= 18, "FACTORY: decimals");
        require(initialSupply > 0 || mintable_, "FACTORY: zero supply, not mintable");

        token = address(new FerminuxToken(
            name_, symbol_, decimals_, initialSupply, maxSupply, mintable_, msg.sender
        ));

        tokens.push(TokenInfo(token, msg.sender, name_, symbol_, block.timestamp, mintable_));
        tokensByCreator[msg.sender].push(token);
        isFactoryToken[token] = true;
        totalLaunched++;

        // forward fee to treasury
        (bool ok, ) = feeCollector.call{value: msg.value}("");
        require(ok, "FACTORY: fee transfer");

        emit TokenLaunched(token, msg.sender, name_, symbol_, initialSupply, mintable_);
    }

    // ------------------------------------------------------------- Views
    function tokenCount() external view returns (uint256) { return tokens.length; }

    function tokensOf(address creator) external view returns (address[] memory) {
        return tokensByCreator[creator];
    }

    /// @notice Paginated registry for the launchpad UI.
    function tokensPage(uint256 offset, uint256 limit)
        external view returns (TokenInfo[] memory page)
    {
        uint256 n = tokens.length;
        if (offset >= n) return new TokenInfo[](0);
        uint256 end = offset + limit > n ? n : offset + limit;
        page = new TokenInfo[](end - offset);
        for (uint256 i = offset; i < end; i++) page[i - offset] = tokens[i];
    }

    // ------------------------------------------------------------- Admin
    function setFee(uint256 newFee) external onlyCollector {
        launchFee = newFee;
        emit FeeChanged(newFee);
    }

    function setFeeCollector(address newCollector) external onlyCollector {
        require(newCollector != address(0), "FACTORY: zero collector");
        feeCollector = newCollector;
        emit FeeCollectorChanged(newCollector);
    }
}
