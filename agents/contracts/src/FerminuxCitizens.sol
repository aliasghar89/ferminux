// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Ferminux Citizens — one-of-one FRC-721 artwork on Ferminux Network, priced by rarity tier.
/// @notice Dependency-free (Paris EVM target, no PUSH0), same conventions as FerminuxAgents. Token ids run
///         1..totalIds and every id exists at most once. The collection grows as artwork arrives: a CURATOR
///         (ops key) appends the next ids with their tiers, and may re-tier an id nobody has minted yet. Supply
///         only ever grows; the owner can lock it for good with lockSupply().
///         Anyone mints an unminted id by paying exactly price(id) = priceOfTier[tierOf(id)]. A tier priced 0 is
///         not for sale (the owner can still reserve() ids). Proceeds go to the treasury via withdraw().
///         Owner = two-step (transferOwnership + acceptOwnership), meant to be the governance multisig.
contract FerminuxCitizens {
    uint8 public constant TIERS = 4; // 0 Common, 1 Rare, 2 Epic, 3 Legendary
    uint96 public constant MAX_ROYALTY_BPS = 1000; // 10 %

    string public name;
    string public symbol;

    address public owner;
    address public pendingOwner;
    mapping(address => bool) public isCurator;

    uint256 public totalIds; // ids 1..totalIds exist (minted or not)
    uint256 public totalSupply; // minted
    uint256[4] public priceOfTier; // wei; 0 = not for sale
    bool public paused;
    bool public supplyLocked;
    bool public metadataFrozen;

    string public baseURI; // tokenURI = baseURI + id + ".json"
    string private _contractURI;
    address public treasury;
    address public royaltyReceiver;
    uint96 public royaltyBps;

    mapping(uint256 => uint8) private _tier;
    mapping(uint256 => address) private _ownerOf;
    mapping(address => uint256) private _balanceOf;
    mapping(uint256 => address) public getApproved;
    mapping(address => mapping(address => bool)) public isApprovedForAll;
    uint256 private _lock = 1;

    // ---- FRC-721 (+ metadata update, contract metadata) ----
    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);
    event MetadataUpdate(uint256 tokenId);
    event BatchMetadataUpdate(uint256 fromTokenId, uint256 toTokenId);
    event ContractURIUpdated();
    // ---- sale + admin ----
    event TokenMinted(uint256 indexed tokenId, address indexed to, uint8 tier, uint256 paid);
    event TokensAppended(uint256 fromId, uint256 toId);
    event TierChanged(uint256 indexed tokenId, uint8 tier);
    event TierPriceChanged(uint8 indexed tier, uint256 price);
    event PauseChanged(bool paused);
    event SupplyLocked(uint256 totalIds);
    event MetadataFrozen();
    event BaseURIChanged(string baseURI);
    event TreasuryChanged(address indexed treasury);
    event RoyaltyChanged(address indexed receiver, uint96 bps);
    event CuratorChanged(address indexed account, bool isCurator);
    event Withdrawn(address indexed to, uint256 amount);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error BadId();
    error Minted();
    error Paused();
    error WrongPrice();
    error NotForSale();
    error BadTier();
    error EmptyBatch();
    error SupplyIsLocked();
    error MetadataIsFrozen();
    error NotOwner();
    error NotPendingOwner();
    error NotCurator();
    error NotAuthorized();
    error ZeroAddress();
    error RoyaltyTooHigh();
    error TransferFailed();
    error UnsafeRecipient();
    error Reentrancy();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }
    /// The owner counts as a curator, so the multisig never needs to grant itself the role.
    modifier onlyCurator() {
        if (!isCurator[msg.sender] && msg.sender != owner) revert NotCurator();
        _;
    }
    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    /// @param prices wei per tier (Common, Rare, Epic, Legendary); set here so there is never a free-mint window.
    constructor(
        string memory name_,
        string memory symbol_,
        address owner_,
        uint256[4] memory prices,
        string memory baseURI_,
        string memory contractURI_,
        address treasury_,
        address royaltyReceiver_,
        uint96 royaltyBps_
    ) {
        if (owner_ == address(0) || treasury_ == address(0) || royaltyReceiver_ == address(0)) revert ZeroAddress();
        if (royaltyBps_ > MAX_ROYALTY_BPS) revert RoyaltyTooHigh();
        name = name_;
        symbol = symbol_;
        owner = owner_;
        emit OwnershipTransferred(address(0), owner_);
        for (uint8 t = 0; t < TIERS; t++) {
            priceOfTier[t] = prices[t];
            emit TierPriceChanged(t, prices[t]);
        }
        baseURI = baseURI_;
        emit BaseURIChanged(baseURI_);
        _contractURI = contractURI_;
        emit ContractURIUpdated();
        treasury = treasury_;
        emit TreasuryChanged(treasury_);
        royaltyReceiver = royaltyReceiver_;
        royaltyBps = royaltyBps_;
        emit RoyaltyChanged(royaltyReceiver_, royaltyBps_);
    }

    // ---- views ----
    function supportsInterface(bytes4 id) external pure returns (bool) {
        // 165, 721, 721 Metadata, 2981 royalties, 4906 metadata update
        return id == 0x01ffc9a7 || id == 0x80ac58cd || id == 0x5b5e139f || id == 0x2a55205a || id == 0x49064906;
    }

    function tokenURI(uint256 tokenId) external view returns (string memory) {
        if (_ownerOf[tokenId] == address(0)) revert BadId();
        return string.concat(baseURI, _toString(tokenId), ".json");
    }

    /// @notice Collection-level metadata (name, description, image, royalty) for marketplaces.
    function contractURI() external view returns (string memory) {
        return _contractURI;
    }

    function ownerOf(uint256 tokenId) public view returns (address o) {
        o = _ownerOf[tokenId];
        if (o == address(0)) revert BadId();
    }

    function balanceOf(address a) external view returns (uint256) {
        if (a == address(0)) revert ZeroAddress();
        return _balanceOf[a];
    }

    function minted(uint256 tokenId) external view returns (bool) {
        return _ownerOf[tokenId] != address(0);
    }

    function tierOf(uint256 tokenId) public view returns (uint8) {
        if (tokenId == 0 || tokenId > totalIds) revert BadId();
        return _tier[tokenId];
    }

    function price(uint256 tokenId) external view returns (uint256) {
        return priceOfTier[tierOf(tokenId)];
    }

    /// @notice Tier and owner (zero = unminted) of ids fromId..toId inclusive, clamped to totalIds: one call
    ///         for a gallery page instead of one per id (the chain has no multicall contract).
    function tokensInfo(uint256 fromId, uint256 toId) external view returns (uint8[] memory tiers, address[] memory owners) {
        if (fromId == 0) fromId = 1;
        if (toId > totalIds) toId = totalIds;
        uint256 n = toId >= fromId ? toId - fromId + 1 : 0;
        tiers = new uint8[](n);
        owners = new address[](n);
        for (uint256 i = 0; i < n; i++) {
            tiers[i] = _tier[fromId + i];
            owners[i] = _ownerOf[fromId + i];
        }
    }

    /// @notice FRC-2981: one default royalty for every token.
    function royaltyInfo(uint256, uint256 salePrice) external view returns (address, uint256) {
        return (royaltyReceiver, (salePrice * royaltyBps) / 10000);
    }

    // ---- sale ----
    function mint(uint256 tokenId) external payable nonReentrant {
        if (paused) revert Paused();
        if (tokenId == 0 || tokenId > totalIds) revert BadId();
        if (_ownerOf[tokenId] != address(0)) revert Minted();
        uint8 t = _tier[tokenId];
        uint256 p = priceOfTier[t];
        if (p == 0) revert NotForSale();
        if (msg.value != p) revert WrongPrice();
        _mint(msg.sender, tokenId);
        emit TokenMinted(tokenId, msg.sender, t, msg.value);
        _checkReceiver(address(0), msg.sender, tokenId, "");
    }

    /// @notice Owner mints ids for free (treasury reserve, gifts). No receiver hook, so a plain multisig can hold them.
    function reserve(uint256[] calldata ids, address to) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        for (uint256 i = 0; i < ids.length; i++) {
            uint256 id = ids[i];
            if (id == 0 || id > totalIds) revert BadId();
            if (_ownerOf[id] != address(0)) revert Minted();
            _mint(to, id);
            emit TokenMinted(id, to, _tier[id], 0);
        }
    }

    /// @notice Sends the whole balance to the treasury. Owner or curator; the destination is fixed by the owner.
    function withdraw() external onlyCurator nonReentrant {
        uint256 amount = address(this).balance;
        address to = treasury;
        (bool ok,) = payable(to).call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Withdrawn(to, amount);
    }

    // ---- curator: grow the collection ----
    /// @notice Adds ids totalIds+1 .. totalIds+tiers.length with the given tiers.
    function appendTokens(uint8[] calldata tiers) external onlyCurator {
        if (supplyLocked) revert SupplyIsLocked();
        uint256 n = tiers.length;
        if (n == 0) revert EmptyBatch();
        uint256 first = totalIds + 1;
        for (uint256 i = 0; i < n; i++) {
            if (tiers[i] >= TIERS) revert BadTier();
            _tier[first + i] = tiers[i];
        }
        totalIds = first + n - 1;
        emit TokensAppended(first, totalIds);
    }

    /// @notice Re-tiers an id that has not been minted (its price follows the new tier).
    function setTier(uint256 tokenId, uint8 tier) external onlyCurator {
        if (tokenId == 0 || tokenId > totalIds) revert BadId();
        if (_ownerOf[tokenId] != address(0)) revert Minted();
        if (tier >= TIERS) revert BadTier();
        _tier[tokenId] = tier;
        emit TierChanged(tokenId, tier);
        emit MetadataUpdate(tokenId);
    }

    // ---- owner ----
    function setTierPrice(uint8 tier, uint256 p) external onlyOwner {
        if (tier >= TIERS) revert BadTier();
        priceOfTier[tier] = p;
        emit TierPriceChanged(tier, p);
    }

    function pause() external onlyOwner {
        paused = true;
        emit PauseChanged(true);
    }

    function unpause() external onlyOwner {
        paused = false;
        emit PauseChanged(false);
    }

    /// @notice One-way: no id can ever be appended again.
    function lockSupply() external onlyOwner {
        supplyLocked = true;
        emit SupplyLocked(totalIds);
    }

    function setBaseURI(string calldata u) external onlyOwner {
        if (metadataFrozen) revert MetadataIsFrozen();
        baseURI = u;
        emit BaseURIChanged(u);
        emit BatchMetadataUpdate(1, type(uint256).max);
    }

    function setContractURI(string calldata u) external onlyOwner {
        if (metadataFrozen) revert MetadataIsFrozen();
        _contractURI = u;
        emit ContractURIUpdated();
    }

    /// @notice One-way: baseURI and contractURI can no longer change.
    function freezeMetadata() external onlyOwner {
        metadataFrozen = true;
        emit MetadataFrozen();
    }

    function setTreasury(address t) external onlyOwner {
        if (t == address(0)) revert ZeroAddress();
        treasury = t;
        emit TreasuryChanged(t);
    }

    function setRoyalty(address receiver, uint96 bps) external onlyOwner {
        if (receiver == address(0)) revert ZeroAddress();
        if (bps > MAX_ROYALTY_BPS) revert RoyaltyTooHigh();
        royaltyReceiver = receiver;
        royaltyBps = bps;
        emit RoyaltyChanged(receiver, bps);
    }

    function grantCurator(address a) external onlyOwner {
        if (a == address(0)) revert ZeroAddress();
        isCurator[a] = true;
        emit CuratorChanged(a, true);
    }

    function revokeCurator(address a) external onlyOwner {
        isCurator[a] = false;
        emit CuratorChanged(a, false);
    }

    /// @notice Step 1 of 2: names the next owner; nothing changes until they call acceptOwnership().
    ///         Passing address(0) cancels a pending transfer.
    function transferOwnership(address n) external onlyOwner {
        pendingOwner = n;
        emit OwnershipTransferStarted(owner, n);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotPendingOwner();
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }

    // ---- FRC-721 transfers ----
    // Function and event NAMES below keep their standard spelling: the 4-byte selector and the 32-byte topic hash
    // are keccak of the literal signature.
    function approve(address spender, uint256 tokenId) external {
        address o = ownerOf(tokenId);
        if (msg.sender != o && !isApprovedForAll[o][msg.sender]) revert NotAuthorized();
        getApproved[tokenId] = spender;
        emit Approval(o, spender, tokenId);
    }

    function setApprovalForAll(address operator, bool approved) external {
        isApprovedForAll[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    function transferFrom(address from, address to, uint256 tokenId) public {
        if (from != ownerOf(tokenId)) revert NotAuthorized();
        if (to == address(0)) revert ZeroAddress();
        if (msg.sender != from && !isApprovedForAll[from][msg.sender] && msg.sender != getApproved[tokenId]) {
            revert NotAuthorized();
        }
        _balanceOf[from]--;
        _balanceOf[to]++;
        _ownerOf[tokenId] = to;
        delete getApproved[tokenId];
        emit Transfer(from, to, tokenId);
    }

    function safeTransferFrom(address from, address to, uint256 tokenId) external {
        safeTransferFrom(from, to, tokenId, "");
    }

    function safeTransferFrom(address from, address to, uint256 tokenId, bytes memory data) public {
        transferFrom(from, to, tokenId);
        _checkReceiver(from, to, tokenId, data);
    }

    function _mint(address to, uint256 tokenId) internal {
        _ownerOf[tokenId] = to;
        _balanceOf[to]++;
        totalSupply++;
        emit Transfer(address(0), to, tokenId);
    }

    /// Runs after every state change of the transfer (checks-effects-interactions); mint() also holds the lock.
    function _checkReceiver(address from, address to, uint256 tokenId, bytes memory data) internal {
        if (to.code.length == 0) return;
        if (IFRC721Receiver(to).onERC721Received(msg.sender, from, tokenId, data) != IFRC721Receiver.onERC721Received.selector) {
            revert UnsafeRecipient();
        }
    }

    function _toString(uint256 v) internal pure returns (string memory) {
        if (v == 0) return "0";
        uint256 t = v;
        uint256 d;
        while (t != 0) {
            d++;
            t /= 10;
        }
        bytes memory b = new bytes(d);
        while (v != 0) {
            d--;
            b[d] = bytes1(uint8(48 + (v % 10)));
            v /= 10;
        }
        return string(b);
    }
}

interface IFRC721Receiver {
    function onERC721Received(address operator, address from, uint256 tokenId, bytes calldata data)
        external
        returns (bytes4);
}
