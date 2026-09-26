// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";

// Functional smoke test of the standard shared contracts after deploy.sh has
// put them at their canonical addresses. Rehearsal only: it moves a little FMX
// between throwaway accounts, so run it against an anvil fork (rehearse.sh
// does), not against mainnet. run() refuses any endpoint that is not anvil.
//
//   SMOKE_OWNER_PK=<key> SMOKE_SPENDER_PK=<key> \
//     forge script script/canonical/CanonicalSmoke.s.sol --rpc-url <anvil> --broadcast
//
// Every step reverts the script on a wrong result, so a clean run means:
// CREATE2 deployer, Multicall3, Permit2 (allowance and signature transfers of
// a real FRC-20 on the chain), a Safe 1.3.0 created through the proxy factory
// with the fallback handler, executing a signed MultiSendCallOnly batch, and
// EntryPoint v0.6 and v0.7 each running a signed user operation that deploys
// its account through initCode and pays FMX out.

interface IMulticall3 {
    struct Call3 {
        address target;
        bool allowFailure;
        bytes callData;
    }

    struct Result {
        bool success;
        bytes returnData;
    }

    function aggregate3(Call3[] calldata calls) external payable returns (Result[] memory);
    function getChainId() external view returns (uint256);
    function getBasefee() external view returns (uint256);
    function getBlockNumber() external view returns (uint256);
}

interface IWFMX {
    function deposit() external payable;
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
}

interface IPermit2 {
    struct TokenPermissions {
        address token;
        uint256 amount;
    }

    struct PermitTransferFrom {
        TokenPermissions permitted;
        uint256 nonce;
        uint256 deadline;
    }

    struct SignatureTransferDetails {
        address to;
        uint256 requestedAmount;
    }

    function DOMAIN_SEPARATOR() external view returns (bytes32);
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
    function allowance(address user, address token, address spender)
        external
        view
        returns (uint160 amount, uint48 expiration, uint48 nonce);
    function transferFrom(address from, address to, uint160 amount, address token) external;
    function permitTransferFrom(
        PermitTransferFrom memory permit,
        SignatureTransferDetails calldata transferDetails,
        address owner,
        bytes calldata signature
    ) external;
}

interface ISafeProxyFactory {
    function createProxyWithNonce(address singleton, bytes memory initializer, uint256 saltNonce)
        external
        returns (address proxy);
}

interface ISafe {
    function setup(
        address[] calldata owners,
        uint256 threshold,
        address to,
        bytes calldata data,
        address fallbackHandler,
        address paymentToken,
        uint256 payment,
        address payable paymentReceiver
    ) external;
    function execTransaction(
        address to,
        uint256 value,
        bytes calldata data,
        uint8 operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address payable refundReceiver,
        bytes memory signatures
    ) external payable returns (bool);
    function getTransactionHash(
        address to,
        uint256 value,
        bytes calldata data,
        uint8 operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address refundReceiver,
        uint256 _nonce
    ) external view returns (bytes32);
    function getOwners() external view returns (address[] memory);
    function getThreshold() external view returns (uint256);
    function nonce() external view returns (uint256);
    function VERSION() external view returns (string memory);
    // served by the CompatibilityFallbackHandler through the Safe's fallback
    function supportsInterface(bytes4 interfaceId) external view returns (bool);
}

interface IMultiSend {
    function multiSend(bytes memory transactions) external payable;
}

// ERC-4337 v0.6 user operation
struct UserOperation06 {
    address sender;
    uint256 nonce;
    bytes initCode;
    bytes callData;
    uint256 callGasLimit;
    uint256 verificationGasLimit;
    uint256 preVerificationGas;
    uint256 maxFeePerGas;
    uint256 maxPriorityFeePerGas;
    bytes paymasterAndData;
    bytes signature;
}

// ERC-4337 v0.7 packed user operation
struct PackedUserOperation07 {
    address sender;
    uint256 nonce;
    bytes initCode;
    bytes callData;
    bytes32 accountGasLimits;
    uint256 preVerificationGas;
    bytes32 gasFees;
    bytes paymasterAndData;
    bytes signature;
}

interface IEntryPoint06 {
    function handleOps(UserOperation06[] calldata ops, address payable beneficiary) external;
    function getUserOpHash(UserOperation06 calldata userOp) external view returns (bytes32);
    function getNonce(address sender, uint192 key) external view returns (uint256);
    function depositTo(address account) external payable;
    function balanceOf(address account) external view returns (uint256);
}

interface IEntryPoint07 {
    function handleOps(PackedUserOperation07[] calldata ops, address payable beneficiary) external;
    function getUserOpHash(PackedUserOperation07 calldata userOp) external view returns (bytes32);
    function getNonce(address sender, uint192 key) external view returns (uint256);
    function depositTo(address account) external payable;
    function balanceOf(address account) external view returns (uint256);
}

/// Minimal smart account: owner signs the EntryPoint's userOpHash (eth_sign style).
abstract contract CanonicalSmokeAccountBase {
    address public immutable owner;
    address public immutable entryPoint;

    constructor(address owner_, address entryPoint_) {
        owner = owner_;
        entryPoint = entryPoint_;
    }

    receive() external payable {}

    function execute(address to, uint256 value, bytes calldata data) external {
        require(msg.sender == entryPoint, "not entrypoint");
        (bool ok,) = to.call{value: value}(data);
        require(ok, "call failed");
    }

    function _validate(bytes32 userOpHash, bytes calldata sig, uint256 missing) internal returns (uint256) {
        require(msg.sender == entryPoint, "not entrypoint");
        bytes32 digest = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", userOpHash));
        address signer = ecrecover(digest, uint8(sig[64]), bytes32(sig[0:32]), bytes32(sig[32:64]));
        if (missing > 0) {
            (bool ok,) = payable(msg.sender).call{value: missing}("");
            ok;
        }
        return signer == owner ? 0 : 1;
    }
}

contract CanonicalSmokeAccount06 is CanonicalSmokeAccountBase {
    constructor(address owner_, address entryPoint_) CanonicalSmokeAccountBase(owner_, entryPoint_) {}

    function validateUserOp(UserOperation06 calldata op, bytes32 userOpHash, uint256 missing)
        external
        returns (uint256)
    {
        return _validate(userOpHash, op.signature, missing);
    }
}

contract CanonicalSmokeAccount07 is CanonicalSmokeAccountBase {
    constructor(address owner_, address entryPoint_) CanonicalSmokeAccountBase(owner_, entryPoint_) {}

    function validateUserOp(PackedUserOperation07 calldata op, bytes32 userOpHash, uint256 missing)
        external
        returns (uint256)
    {
        return _validate(userOpHash, op.signature, missing);
    }
}

/// Account factory reached through the EntryPoint's SenderCreator (initCode path).
contract CanonicalSmokeAccountFactory {
    function create06(address owner, address entryPoint, bytes32 salt) external returns (address) {
        return address(new CanonicalSmokeAccount06{salt: salt}(owner, entryPoint));
    }

    function create07(address owner, address entryPoint, bytes32 salt) external returns (address) {
        return address(new CanonicalSmokeAccount07{salt: salt}(owner, entryPoint));
    }

    function predict06(address owner, address entryPoint, bytes32 salt) external view returns (address) {
        return _predict(abi.encodePacked(type(CanonicalSmokeAccount06).creationCode, abi.encode(owner, entryPoint)), salt);
    }

    function predict07(address owner, address entryPoint, bytes32 salt) external view returns (address) {
        return _predict(abi.encodePacked(type(CanonicalSmokeAccount07).creationCode, abi.encode(owner, entryPoint)), salt);
    }

    function _predict(bytes memory initCode, bytes32 salt) internal view returns (address) {
        return address(
            uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, keccak256(initCode)))))
        );
    }
}

contract CanonicalSmoke is Script {
    address constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    address constant MULTICALL3 = 0xcA11bde05977b3631167028862bE2a173976CA11;
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address constant SAFE_L2 = 0x3E5c63644E683549055b9Be8653de26E0B4CD36E;
    address constant SAFE = 0xd9Db270c1B5E3Bd161E8c8503c55cEABeE709552;
    address constant SAFE_FACTORY = 0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2;
    address constant SAFE_FALLBACK = 0xf48f2B2d2a534e402487b3ee7C18c33Aec0Fe5e4;
    address constant SAFE_MULTISEND_CALL_ONLY = 0x40A2aCCbd92BCA938b02010E17A5b8929b49130D;
    address constant ENTRYPOINT_06 = 0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789;
    address constant ENTRYPOINT_07 = 0x0000000071727De22E5E9d8BAf0edAc6f37da032;
    // WFMX on chain 3961 (the Ferminux DEX's wrapped FMX), used as the FRC-20 for Permit2.
    address constant WFMX = 0x8a9Ae4D652cEba09Db8Ebf48D28C943b41B377Ae;

    uint256 ownerPk;
    uint256 spenderPk;
    address owner;
    address spender;
    bytes32 runSalt;

    function run() external {
        require(block.chainid == 3961, "expected chain 3961 (an anvil fork of it)");
        // Mainnet is chain 3961 too, and this script sends FMX to addresses nobody
        // holds keys for. Only anvil answers anvil_* methods; a real node refuses,
        // so the script stops here, in simulation, before anything is broadcast.
        try vm.rpc("anvil_getAutomine", "[]") returns (bytes memory) {}
        catch {
            revert("CanonicalSmoke runs only against an anvil fork (rehearse.sh), never a real node");
        }
        ownerPk = vm.envUint("SMOKE_OWNER_PK");
        spenderPk = vm.envUint("SMOKE_SPENDER_PK");
        owner = vm.addr(ownerPk);
        spender = vm.addr(spenderPk);
        runSalt = keccak256(abi.encode(block.number, block.timestamp, owner));

        _create2Deployer();
        _multicall3();
        _permit2();
        _safe();
        _entryPoint06();
        _entryPoint07();
        console2.log("SMOKE OK: all canonical contracts behave on this chain");
    }

    function _create2Deployer() internal {
        // initcode that deploys runtime 0x602a60005260206000f3 (returns 42)
        bytes memory initCode = hex"69602a60005260206000f3600052600a6016f3";
        address expected = vm.computeCreate2Address(runSalt, keccak256(initCode), CREATE2_DEPLOYER);
        vm.startBroadcast(ownerPk);
        (bool ok, bytes memory ret) = CREATE2_DEPLOYER.call(abi.encodePacked(runSalt, initCode));
        vm.stopBroadcast();
        // The deployer returns exactly the 20-byte address it created.
        // forge-lint: disable-next-line(unsafe-typecast)
        require(ok && address(bytes20(ret)) == expected, "create2 deployer: wrong address");
        (bool ok2, bytes memory v) = expected.staticcall("");
        require(ok2 && abi.decode(v, (uint256)) == 42, "create2 deployer: deployed code wrong");
        console2.log("create2 deployer ok, deployed", expected);
    }

    function _multicall3() internal {
        IMulticall3.Call3[] memory calls = new IMulticall3.Call3[](3);
        calls[0] = IMulticall3.Call3(MULTICALL3, false, abi.encodeCall(IMulticall3.getChainId, ()));
        calls[1] = IMulticall3.Call3(MULTICALL3, false, abi.encodeCall(IMulticall3.getBasefee, ()));
        calls[2] = IMulticall3.Call3(WFMX, false, abi.encodeCall(IWFMX.balanceOf, (owner)));
        IMulticall3.Result[] memory r = IMulticall3(MULTICALL3).aggregate3(calls);
        require(r[0].success && abi.decode(r[0].returnData, (uint256)) == 3961, "multicall3: chain id");
        require(r[1].success && r[2].success, "multicall3: aggregate3");
        console2.log("multicall3 ok, basefee", abi.decode(r[1].returnData, (uint256)));
    }

    function _permit2() internal {
        IPermit2 p2 = IPermit2(PERMIT2);
        bytes32 expectedDomain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,uint256 chainId,address verifyingContract)"),
                keccak256("Permit2"),
                block.chainid,
                PERMIT2
            )
        );
        require(p2.DOMAIN_SEPARATOR() == expectedDomain, "permit2: domain separator");

        address to = address(uint160(uint256(keccak256(abi.encode(runSalt, "permit2-to")))));
        vm.startBroadcast(ownerPk);
        IWFMX(WFMX).deposit{value: 0.03 ether}();
        IWFMX(WFMX).approve(PERMIT2, type(uint256).max);
        p2.approve(WFMX, spender, 0.01 ether, uint48(block.timestamp + 3600));
        payable(spender).transfer(0.05 ether);
        vm.stopBroadcast();

        (uint160 amount,,) = p2.allowance(owner, WFMX, spender);
        require(amount == 0.01 ether, "permit2: allowance");

        // signature transfer: owner signs, spender submits
        uint256 nonce = uint256(runSalt) >> 8 << 8; // word-aligned unordered nonce
        uint256 deadline = block.timestamp + 3600;
        bytes32 tokenPerms =
            keccak256(abi.encode(keccak256("TokenPermissions(address token,uint256 amount)"), WFMX, 0.01 ether));
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    "PermitTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline)TokenPermissions(address token,uint256 amount)"
                ),
                tokenPerms,
                spender,
                nonce,
                deadline
            )
        );
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(ownerPk, keccak256(abi.encodePacked("\x19\x01", expectedDomain, structHash)));

        vm.startBroadcast(spenderPk);
        p2.transferFrom(owner, to, 0.01 ether, WFMX);
        p2.permitTransferFrom(
            IPermit2.PermitTransferFrom(IPermit2.TokenPermissions(WFMX, 0.01 ether), nonce, deadline),
            IPermit2.SignatureTransferDetails(to, 0.01 ether),
            owner,
            abi.encodePacked(r, s, v)
        );
        vm.stopBroadcast();
        require(IWFMX(WFMX).balanceOf(to) == 0.02 ether, "permit2: transfers");
        console2.log("permit2 ok: allowance and signature transfers of WFMX");
    }

    function _safe() internal {
        address[] memory owners = new address[](1);
        owners[0] = owner;
        bytes memory init = abi.encodeCall(
            ISafe.setup, (owners, 1, address(0), "", SAFE_FALLBACK, address(0), 0, payable(address(0)))
        );
        address r1 = address(uint160(uint256(keccak256(abi.encode(runSalt, "safe-r1")))));
        address r2 = address(uint160(uint256(keccak256(abi.encode(runSalt, "safe-r2")))));

        vm.startBroadcast(ownerPk);
        ISafe safe =
            ISafe(ISafeProxyFactory(SAFE_FACTORY).createProxyWithNonce(SAFE_L2, init, uint256(runSalt)));
        payable(address(safe)).transfer(0.05 ether);
        vm.stopBroadcast();

        require(keccak256(bytes(safe.VERSION())) == keccak256("1.3.0"), "safe: version");
        require(safe.getThreshold() == 1 && safe.getOwners()[0] == owner, "safe: owners");
        require(safe.supportsInterface(0x01ffc9a7), "safe: fallback handler");

        bytes memory batch = abi.encodePacked(
            abi.encodePacked(uint8(0), r1, uint256(0.01 ether), uint256(0)),
            abi.encodePacked(uint8(0), r2, uint256(0.02 ether), uint256(0))
        );
        require(_safeDelegateCall(safe, abi.encodeCall(IMultiSend.multiSend, (batch))), "safe: execTransaction");
        require(safe.nonce() == 1, "safe: nonce");
        require(r1.balance == 0.01 ether && r2.balance == 0.02 ether, "safe: multisend payouts");
        console2.log("safe 1.3.0 ok: proxy", address(safe));

        // the plain (non-L2) singleton must also initialise through the factory
        vm.startBroadcast(ownerPk);
        ISafe plain =
            ISafe(ISafeProxyFactory(SAFE_FACTORY).createProxyWithNonce(SAFE, init, uint256(runSalt) + 1));
        vm.stopBroadcast();
        require(plain.getThreshold() == 1, "safe: plain singleton setup");
    }

    function _entryPoint06() internal {
        IEntryPoint06 ep = IEntryPoint06(ENTRYPOINT_06);
        address payable beneficiary = payable(address(uint160(uint256(keccak256(abi.encode(runSalt, "ep06-b"))))));
        address payee = address(uint160(uint256(keccak256(abi.encode(runSalt, "ep06-to")))));

        vm.startBroadcast(ownerPk);
        CanonicalSmokeAccountFactory factory = new CanonicalSmokeAccountFactory();
        address sender = factory.predict06(owner, ENTRYPOINT_06, runSalt);
        payable(sender).transfer(0.05 ether);
        ep.depositTo{value: 0.001 ether}(beneficiary);
        vm.stopBroadcast();
        require(ep.balanceOf(beneficiary) == 0.001 ether, "ep06: depositTo");
        require(ep.getNonce(sender, 0) == 0, "ep06: nonce");

        UserOperation06 memory op = UserOperation06({
            sender: sender,
            nonce: 0,
            initCode: abi.encodePacked(
                address(factory), abi.encodeCall(CanonicalSmokeAccountFactory.create06, (owner, ENTRYPOINT_06, runSalt))
            ),
            callData: abi.encodeCall(CanonicalSmokeAccountBase.execute, (payee, 0.01 ether, "")),
            callGasLimit: 100_000,
            verificationGasLimit: 1_000_000,
            preVerificationGas: 60_000,
            maxFeePerGas: 2 gwei,
            maxPriorityFeePerGas: 1 gwei,
            paymasterAndData: "",
            signature: ""
        });
        op.signature = _ethSign(ep.getUserOpHash(op));
        UserOperation06[] memory ops = new UserOperation06[](1);
        ops[0] = op;

        vm.startBroadcast(ownerPk);
        // The EntryPoint insists the transaction carries the op's full gas limits
        // (AA95 otherwise), so give handleOps an explicit gas limit.
        ep.handleOps{gas: 2_000_000}(ops, beneficiary);
        vm.stopBroadcast();
        require(sender.code.length > 0, "ep06: account not created");
        require(payee.balance == 0.01 ether, "ep06: call not executed");
        require(ep.getNonce(sender, 0) == 1, "ep06: nonce not bumped");
        require(beneficiary.balance > 0, "ep06: beneficiary unpaid");
        console2.log("entrypoint v0.6 ok: account", sender);
    }

    function _entryPoint07() internal {
        IEntryPoint07 ep = IEntryPoint07(ENTRYPOINT_07);
        address payable beneficiary = payable(address(uint160(uint256(keccak256(abi.encode(runSalt, "ep07-b"))))));
        address payee = address(uint160(uint256(keccak256(abi.encode(runSalt, "ep07-to")))));

        vm.startBroadcast(ownerPk);
        CanonicalSmokeAccountFactory factory = new CanonicalSmokeAccountFactory();
        address sender = factory.predict07(owner, ENTRYPOINT_07, runSalt);
        payable(sender).transfer(0.05 ether);
        ep.depositTo{value: 0.001 ether}(beneficiary);
        vm.stopBroadcast();
        require(ep.balanceOf(beneficiary) == 0.001 ether, "ep07: depositTo");

        PackedUserOperation07 memory op = PackedUserOperation07({
            sender: sender,
            nonce: 0,
            initCode: abi.encodePacked(
                address(factory), abi.encodeCall(CanonicalSmokeAccountFactory.create07, (owner, ENTRYPOINT_07, runSalt))
            ),
            callData: abi.encodeCall(CanonicalSmokeAccountBase.execute, (payee, 0.01 ether, "")),
            accountGasLimits: bytes32((uint256(1_000_000) << 128) | uint256(100_000)),
            preVerificationGas: 60_000,
            gasFees: bytes32((uint256(1 gwei) << 128) | uint256(2 gwei)),
            paymasterAndData: "",
            signature: ""
        });
        op.signature = _ethSign(ep.getUserOpHash(op));
        PackedUserOperation07[] memory ops = new PackedUserOperation07[](1);
        ops[0] = op;

        vm.startBroadcast(ownerPk);
        // The EntryPoint insists the transaction carries the op's full gas limits
        // (AA95 otherwise), so give handleOps an explicit gas limit.
        ep.handleOps{gas: 2_000_000}(ops, beneficiary);
        vm.stopBroadcast();
        require(sender.code.length > 0, "ep07: account not created");
        require(payee.balance == 0.01 ether, "ep07: call not executed");
        require(ep.getNonce(sender, 0) == 1, "ep07: nonce not bumped");
        require(beneficiary.balance > 0, "ep07: beneficiary unpaid");
        console2.log("entrypoint v0.7 ok: account", sender);
    }

    /// Owner-signed Safe transaction that DELEGATECALLs MultiSendCallOnly with `data`.
    function _safeDelegateCall(ISafe safe, bytes memory data) internal returns (bool ok) {
        bytes32 txHash = safe.getTransactionHash(
            SAFE_MULTISEND_CALL_ONLY, 0, data, 1, 0, 0, 0, address(0), address(0), safe.nonce()
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerPk, txHash);
        vm.startBroadcast(ownerPk);
        ok = safe.execTransaction(
            SAFE_MULTISEND_CALL_ONLY, 0, data, 1, 0, 0, 0, address(0), payable(address(0)), abi.encodePacked(r, s, v)
        );
        vm.stopBroadcast();
    }

    function _ethSign(bytes32 h) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(ownerPk, keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", h)));
        return abi.encodePacked(r, s, v);
    }
}
