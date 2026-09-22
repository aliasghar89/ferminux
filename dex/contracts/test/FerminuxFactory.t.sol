// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {FerminuxFactory} from "../src/FerminuxFactory.sol";
import {FerminuxPair} from "../src/FerminuxPair.sol";
import {MockERC20} from "./mocks/Mocks.sol";

contract FerminuxFactoryTest is Test {
    FerminuxFactory internal factory;
    MockERC20 internal tokenA;
    MockERC20 internal tokenB;

    address internal setter = makeAddr("feeToSetter");
    address internal treasury = makeAddr("treasury");
    address internal stranger = makeAddr("stranger");

    event PairCreated(address indexed token0, address indexed token1, address pair, uint256 allPairsLength);
    event FeeToChanged(address indexed oldFeeTo, address indexed newFeeTo);
    event FeeToSetterChanged(address indexed oldSetter, address indexed newSetter);

    function setUp() public {
        factory = new FerminuxFactory(setter);
        tokenA = new MockERC20("Token A", "TKA", 18);
        tokenB = new MockERC20("Token B", "TKB", 18);
    }

    function _sorted() internal view returns (address token0, address token1) {
        (token0, token1) =
            address(tokenA) < address(tokenB) ? (address(tokenA), address(tokenB)) : (address(tokenB), address(tokenA));
    }

    // =====================================================================
    //                            Construction
    // =====================================================================

    function test_Constructor_SetsFeeToSetter() public view {
        assertEq(factory.feeToSetter(), setter);
        assertEq(factory.feeTo(), address(0), "protocol fee must default OFF");
        assertEq(factory.allPairsLength(), 0);
    }

    function test_Constructor_RevertsOnZeroSetter() public {
        vm.expectRevert(bytes("FACTORY: zero setter"));
        new FerminuxFactory(address(0));
    }

    // =====================================================================
    //                            Pair creation
    // =====================================================================

    function test_CreatePair_StoresBothDirections() public {
        address pair = factory.createPair(address(tokenA), address(tokenB));
        assertEq(factory.getPair(address(tokenA), address(tokenB)), pair);
        assertEq(factory.getPair(address(tokenB), address(tokenA)), pair, "reverse lookup must work");
        assertEq(factory.allPairs(0), pair);
        assertEq(factory.allPairsLength(), 1);
    }

    function test_CreatePair_SortsTokens() public {
        FerminuxPair pair = FerminuxPair(factory.createPair(address(tokenB), address(tokenA)));
        (address token0, address token1) = _sorted();
        assertEq(pair.token0(), token0);
        assertEq(pair.token1(), token1);
        assertLt(uint160(pair.token0()), uint160(pair.token1()));
        assertEq(pair.factory(), address(factory));
    }

    function test_CreatePair_EmitsEvent() public {
        (address token0, address token1) = _sorted();
        address expected = factory.predictPairAddress(address(tokenA), address(tokenB));
        vm.expectEmit(true, true, true, true, address(factory));
        emit PairCreated(token0, token1, expected, 1);
        factory.createPair(address(tokenA), address(tokenB));
    }

    function test_CreatePair_RevertsOnIdenticalAddresses() public {
        vm.expectRevert(bytes("FACTORY: identical addresses"));
        factory.createPair(address(tokenA), address(tokenA));
    }

    function test_CreatePair_RevertsOnZeroAddress() public {
        vm.expectRevert(bytes("FACTORY: zero address"));
        factory.createPair(address(0), address(tokenA));

        vm.expectRevert(bytes("FACTORY: zero address"));
        factory.createPair(address(tokenA), address(0));
    }

    function test_CreatePair_RevertsWhenPairExists() public {
        factory.createPair(address(tokenA), address(tokenB));
        vm.expectRevert(bytes("FACTORY: pair exists"));
        factory.createPair(address(tokenA), address(tokenB));

        // and in the reverse order, which is the same pool
        vm.expectRevert(bytes("FACTORY: pair exists"));
        factory.createPair(address(tokenB), address(tokenA));
    }

    function test_CreatePair_IsPermissionless() public {
        vm.prank(stranger);
        address pair = factory.createPair(address(tokenA), address(tokenB));
        assertTrue(pair != address(0));
    }

    function test_CreatePair_MultiplePairsIndexed() public {
        MockERC20 tokenC = new MockERC20("Token C", "TKC", 18);
        address p1 = factory.createPair(address(tokenA), address(tokenB));
        address p2 = factory.createPair(address(tokenA), address(tokenC));
        address p3 = factory.createPair(address(tokenB), address(tokenC));

        assertEq(factory.allPairsLength(), 3);
        assertEq(factory.allPairs(0), p1);
        assertEq(factory.allPairs(1), p2);
        assertEq(factory.allPairs(2), p3);
        assertTrue(p1 != p2 && p2 != p3 && p1 != p3, "distinct pools");
    }

    function test_PairsPage() public {
        MockERC20 tokenC = new MockERC20("Token C", "TKC", 18);
        address p1 = factory.createPair(address(tokenA), address(tokenB));
        address p2 = factory.createPair(address(tokenA), address(tokenC));
        address p3 = factory.createPair(address(tokenB), address(tokenC));

        address[] memory page = factory.pairsPage(0, 2);
        assertEq(page.length, 2);
        assertEq(page[0], p1);
        assertEq(page[1], p2);

        page = factory.pairsPage(2, 10); // limit past the end clamps
        assertEq(page.length, 1);
        assertEq(page[0], p3);

        page = factory.pairsPage(3, 10); // offset past the end is empty
        assertEq(page.length, 0);
    }

    // =====================================================================
    //                    CREATE2 determinism / init code hash
    // =====================================================================

    /// @notice The exposed constant must equal the hash of the pair creation
    ///         code this project actually compiles. If the pair source or the
    ///         compiler settings move, this fails and the constant has to be
    ///         regenerated: cast keccak $(forge inspect FerminuxPair bytecode)
    function test_InitCodeHash_MatchesCompiledPairBytecode() public view {
        bytes32 compiled = keccak256(type(FerminuxPair).creationCode);
        assertEq(factory.INIT_CODE_PAIR_HASH(), compiled, "INIT_CODE_PAIR_HASH is stale");
        assertEq(factory.pairInitCodeHash(), compiled, "live hash must match the artifact");
    }

    /// @notice The CREATE2 formula, computed independently in the test, must
    ///         land on the address that was actually deployed. This is what
    ///         lets the UI derive pool addresses with no RPC call.
    function test_CreatePair_AddressIsDeterministic() public {
        (address token0, address token1) = _sorted();
        bytes32 salt = keccak256(abi.encodePacked(token0, token1));
        address expected = address(
            uint160(
                uint256(
                    keccak256(
                        abi.encodePacked(hex"ff", address(factory), salt, keccak256(type(FerminuxPair).creationCode))
                    )
                )
            )
        );

        address predicted = factory.predictPairAddress(address(tokenA), address(tokenB));
        address actual = factory.createPair(address(tokenA), address(tokenB));

        assertEq(predicted, expected, "predictPairAddress must equal the raw CREATE2 formula");
        assertEq(actual, expected, "deployed address must equal the CREATE2 formula");
        assertGt(actual.code.length, 0, "pair must have runtime code");
    }

    function test_PredictPairAddress_OrderIndependent() public view {
        assertEq(
            factory.predictPairAddress(address(tokenA), address(tokenB)),
            factory.predictPairAddress(address(tokenB), address(tokenA))
        );
    }

    function test_PredictPairAddress_Validates() public {
        vm.expectRevert(bytes("FACTORY: identical addresses"));
        factory.predictPairAddress(address(tokenA), address(tokenA));

        vm.expectRevert(bytes("FACTORY: zero address"));
        factory.predictPairAddress(address(0), address(tokenA));
    }

    function testFuzz_PredictPairAddress_MatchesDeployment(address t0, address t1) public {
        vm.assume(t0 != t1 && t0 != address(0) && t1 != address(0));
        address predicted = factory.predictPairAddress(t0, t1);
        address actual = factory.createPair(t0, t1);
        assertEq(actual, predicted);
    }

    // =====================================================================
    //                         Pair initialisation
    // =====================================================================

    function test_Pair_CannotBeReinitialized() public {
        FerminuxPair pair = FerminuxPair(factory.createPair(address(tokenA), address(tokenB)));
        vm.prank(address(factory));
        vm.expectRevert(bytes("PAIR: initialized"));
        pair.initialize(address(tokenA), address(tokenB));
    }

    function test_Pair_InitializeOnlyByFactory() public {
        FerminuxPair pair = FerminuxPair(factory.createPair(address(tokenA), address(tokenB)));
        vm.prank(stranger);
        vm.expectRevert(bytes("PAIR: forbidden"));
        pair.initialize(address(tokenA), address(tokenB));
    }

    function test_Pair_StandaloneDeploymentIsInert() public {
        // A pair deployed outside the factory has this test as its "factory";
        // it can be initialised by us but the router will never find it.
        FerminuxPair pair = new FerminuxPair();
        assertEq(pair.factory(), address(this));
        assertEq(factory.getPair(address(tokenA), address(tokenB)), address(0));
    }

    // =====================================================================
    //                             Protocol fee
    // =====================================================================

    function test_SetFeeTo_OnlySetter() public {
        vm.prank(stranger);
        vm.expectRevert(bytes("FACTORY: forbidden"));
        factory.setFeeTo(treasury);

        vm.prank(setter);
        factory.setFeeTo(treasury);
        assertEq(factory.feeTo(), treasury);
    }

    function test_SetFeeTo_EmitsEventAndCanTurnOff() public {
        vm.prank(setter);
        vm.expectEmit(true, true, false, false, address(factory));
        emit FeeToChanged(address(0), treasury);
        factory.setFeeTo(treasury);

        vm.prank(setter);
        vm.expectEmit(true, true, false, false, address(factory));
        emit FeeToChanged(treasury, address(0));
        factory.setFeeTo(address(0));
        assertEq(factory.feeTo(), address(0));
    }

    function test_SetFeeToSetter_OnlySetter() public {
        vm.prank(stranger);
        vm.expectRevert(bytes("FACTORY: forbidden"));
        factory.setFeeToSetter(stranger);

        vm.prank(setter);
        vm.expectEmit(true, true, false, false, address(factory));
        emit FeeToSetterChanged(setter, stranger);
        factory.setFeeToSetter(stranger);
        assertEq(factory.feeToSetter(), stranger);

        // the old setter is now powerless
        vm.prank(setter);
        vm.expectRevert(bytes("FACTORY: forbidden"));
        factory.setFeeTo(treasury);
    }

    function test_SetFeeToSetter_RejectsZero() public {
        vm.prank(setter);
        vm.expectRevert(bytes("FACTORY: zero setter"));
        factory.setFeeToSetter(address(0));
    }
}
