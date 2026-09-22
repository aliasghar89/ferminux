// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Ferminux Agents — 41 one-of-one agent archetypes (ERC-721) on Ferminux Network.
/// @notice Minimal, dependency-free ERC-721 (Paris EVM, no PUSH0). Fixed set of token ids
///         1..MAX_ID; anyone mints an unminted id for `price` FMX; proceeds go to the owner
///         (the governance multisig) via withdraw(). Owner may reserve ids for free.
contract FerminuxAgents {
    string public constant name = "Ferminux Agents";
    string public constant symbol = "FMXA";
    uint256 public constant MAX_ID = 41;

    address public owner;
    uint256 public price;
    string public baseURI;
    uint256 public totalSupply;
    bool public paused;

    mapping(uint256 => address) private _ownerOf;
    mapping(address => uint256) private _balanceOf;
    mapping(uint256 => address) public getApproved;
    mapping(address => mapping(address => bool)) public isApprovedForAll;

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);
    event Minted(uint256 indexed tokenId, address indexed to, uint256 paid);
    event PriceChanged(uint256 price);
    event BaseURIChanged(string baseURI);
    event OwnershipTransferred(address indexed from, address indexed to);
    event Paused(bool paused);

    error NotOwner();
    error BadId();
    error AlreadyMinted();
    error WrongPayment();
    error NotAuthorized();
    error ZeroAddress();
    error SalePaused();
    error TransferFailed();
    error UnsafeRecipient();

    modifier onlyOwner() { if (msg.sender != owner) revert NotOwner(); _; }

    constructor(address owner_, uint256 price_, string memory baseURI_) {
        if (owner_ == address(0)) revert ZeroAddress();
        owner = owner_; price = price_; baseURI = baseURI_;
    }

    // ---- ERC-165 / metadata ----
    function supportsInterface(bytes4 id) external pure returns (bool) {
        return id == 0x01ffc9a7 || id == 0x80ac58cd || id == 0x5b5e139f; // 165, 721, 721Metadata
    }
    function tokenURI(uint256 tokenId) external view returns (string memory) {
        if (_ownerOf[tokenId] == address(0)) revert BadId();
        return string.concat(baseURI, _toString(tokenId), ".json");
    }
    function ownerOf(uint256 tokenId) public view returns (address o) {
        o = _ownerOf[tokenId]; if (o == address(0)) revert BadId();
    }
    function balanceOf(address a) external view returns (uint256) { if (a == address(0)) revert ZeroAddress(); return _balanceOf[a]; }
    function minted(uint256 tokenId) external view returns (bool) { return _ownerOf[tokenId] != address(0); }

    // ---- sale ----
    function mint(uint256 tokenId) external payable {
        if (paused) revert SalePaused();
        if (tokenId == 0 || tokenId > MAX_ID) revert BadId();
        if (_ownerOf[tokenId] != address(0)) revert AlreadyMinted();
        if (msg.value != price) revert WrongPayment();
        _mint(msg.sender, tokenId);
        emit Minted(tokenId, msg.sender, msg.value);
    }
    /// @notice Owner mints ids for free (treasury reserve, gifts).
    function reserve(uint256[] calldata ids, address to) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        for (uint256 i = 0; i < ids.length; i++) {
            uint256 id = ids[i];
            if (id == 0 || id > MAX_ID) revert BadId();
            if (_ownerOf[id] != address(0)) revert AlreadyMinted();
            _mint(to, id);
            emit Minted(id, to, 0);
        }
    }
    function setPrice(uint256 p) external onlyOwner { price = p; emit PriceChanged(p); }
    function setBaseURI(string calldata u) external onlyOwner { baseURI = u; emit BaseURIChanged(u); }
    function setPaused(bool p) external onlyOwner { paused = p; emit Paused(p); }
    function transferOwnership(address n) external onlyOwner { if (n == address(0)) revert ZeroAddress(); emit OwnershipTransferred(owner, n); owner = n; }
    function withdraw() external onlyOwner {
        (bool ok,) = payable(owner).call{value: address(this).balance}("");
        if (!ok) revert TransferFailed();
    }

    // ---- ERC-721 transfers ----
    function approve(address spender, uint256 tokenId) external {
        address o = ownerOf(tokenId);
        if (msg.sender != o && !isApprovedForAll[o][msg.sender]) revert NotAuthorized();
        getApproved[tokenId] = spender; emit Approval(o, spender, tokenId);
    }
    function setApprovalForAll(address operator, bool approved) external {
        isApprovedForAll[msg.sender][operator] = approved; emit ApprovalForAll(msg.sender, operator, approved);
    }
    function transferFrom(address from, address to, uint256 tokenId) public {
        if (from != ownerOf(tokenId)) revert NotAuthorized();
        if (to == address(0)) revert ZeroAddress();
        if (msg.sender != from && !isApprovedForAll[from][msg.sender] && msg.sender != getApproved[tokenId]) revert NotAuthorized();
        _balanceOf[from]--; _balanceOf[to]++; _ownerOf[tokenId] = to; delete getApproved[tokenId];
        emit Transfer(from, to, tokenId);
    }
    function safeTransferFrom(address from, address to, uint256 tokenId) external { safeTransferFrom(from, to, tokenId, ""); }
    function safeTransferFrom(address from, address to, uint256 tokenId, bytes memory data) public {
        transferFrom(from, to, tokenId);
        if (to.code.length != 0 && IERC721Receiver(to).onERC721Received(msg.sender, from, tokenId, data) != IERC721Receiver.onERC721Received.selector) revert UnsafeRecipient();
    }

    function _mint(address to, uint256 tokenId) internal {
        _ownerOf[tokenId] = to; _balanceOf[to]++; totalSupply++;
        emit Transfer(address(0), to, tokenId);
    }
    function _toString(uint256 v) internal pure returns (string memory) {
        if (v == 0) return "0";
        uint256 t = v; uint256 d; while (t != 0) { d++; t /= 10; }
        bytes memory b = new bytes(d); while (v != 0) { d--; b[d] = bytes1(uint8(48 + v % 10)); v /= 10; }
        return string(b);
    }
}

interface IERC721Receiver {
    function onERC721Received(address operator, address from, uint256 tokenId, bytes calldata data) external returns (bytes4);
}
