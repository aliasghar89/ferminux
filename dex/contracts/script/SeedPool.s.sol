// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {FerminuxFactory} from "../src/FerminuxFactory.sol";
import {FerminuxRouter} from "../src/FerminuxRouter.sol";
import {FerminuxPair} from "../src/FerminuxPair.sol";
import {FerminuxLibrary} from "../src/libraries/FerminuxLibrary.sol";
import {IERC20} from "../src/interfaces/IFerminuxDex.sol";

/// @dev Devnet-only ERC-20, deployed by this script when TOKEN is not set so a
///      fresh anvil has something to pool against FMX. Never used on a real chain.
contract SeedDemoToken {
    string public constant name = "Seed Demo Token";
    string public constant symbol = "SEED";
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(address to, uint256 supply) {
        totalSupply = supply;
        balanceOf[to] = supply;
        emit Transfer(address(0), to, supply);
    }

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
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= value, "SEED: allowance");
            allowance[from][msg.sender] = allowed - value;
        }
        _transfer(from, to, value);
        return true;
    }

    function _transfer(address from, address to, uint256 value) private {
        require(balanceOf[from] >= value, "SEED: balance");
        balanceOf[from] -= value;
        balanceOf[to] += value;
        emit Transfer(from, to, value);
    }
}

/**
 * @title SeedPool
 * @notice Creates a TOKEN/FMX pool and adds the first liquidity at a price you
 *         choose, then prints the resulting price and the depth of the book.
 *
 *         The first deposit SETS the price: there is nothing to arbitrage
 *         against, so the pool simply believes the ratio you put in. Deposit
 *         `amountToken` and `amountToken * price / 1e18` FMX and the pool opens
 *         at exactly `price` FMX per token.
 *
 * Env vars:
 *   ROUTER          FerminuxRouter address                       (required)
 *   DEPLOYER_KEY    private key that broadcasts   (default: anvil account #0)
 *   TOKEN           ERC-20 to pool against FMX
 *                   (default: deploy a fresh SEED demo token — devnet only)
 *   AMOUNT_TOKEN    token side of the deposit, in wei      (default: 10_000e18,
 *                   which needs 5_000 FMX at the default price — inside the
 *                   10_000 FMX that anvil funds account #0 with)
 *   PRICE_FMX_PER_TOKEN  price as 18-dec fixed point        (default: 0.5e18)
 *
 * Devnet run:
 *   anvil --port 8600 --chain-id 3961
 *   forge script script/DeployDex.s.sol --rpc-url http://127.0.0.1:8600 --broadcast
 *   ROUTER=<router> forge script script/SeedPool.s.sol \
 *     --rpc-url http://127.0.0.1:8600 --broadcast
 */
contract SeedPool is Script {
    address internal constant DEV_ACCOUNT0 = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266;
    uint256 internal constant DEV_DEPLOYER_KEY = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;

    function run() external returns (address pair) {
        uint256 deployerKey = vm.envOr("DEPLOYER_KEY", DEV_DEPLOYER_KEY);
        address deployer = vm.addr(deployerKey);
        FerminuxRouter router = FerminuxRouter(payable(vm.envAddress("ROUTER")));
        address token = vm.envOr("TOKEN", address(0));
        uint256 amountToken = vm.envOr("AMOUNT_TOKEN", uint256(10_000e18));
        uint256 price = vm.envOr("PRICE_FMX_PER_TOKEN", uint256(0.5e18));

        require(amountToken > 0, "SEED: zero token amount");
        require(price > 0, "SEED: zero price");
        uint256 amountFMX = amountToken * price / 1e18;
        require(amountFMX > 0, "SEED: price too low for this size");
        require(deployer.balance >= amountFMX, "SEED: deployer has too little FMX");

        vm.startBroadcast(deployerKey);

        if (token == address(0)) {
            token = address(new SeedDemoToken(deployer, amountToken * 10));
            console2.log("Deployed demo token (devnet only):", token);
        }
        IERC20(token).approve(address(router), amountToken);

        (uint256 usedToken, uint256 usedFMX, uint256 liquidity) = _seed(router, token, amountToken, amountFMX, deployer);

        vm.stopBroadcast();

        address wfmx = router.WFMX();
        pair = FerminuxFactory(router.factory()).getPair(token, wfmx);
        (uint256 reserveToken, uint256 reserveFMX) = router.getReserves(token, wfmx);

        console2.log("Pair:              ", pair);
        console2.log("LP minted:         ", liquidity);
        console2.log("Token deposited:   ", usedToken);
        console2.log("FMX deposited:     ", usedFMX);
        console2.log("--- price ---");
        console2.log("FMX per token (1e18):", reserveFMX * 1e18 / reserveToken);
        console2.log("Tokens per FMX (1e18):", reserveToken * 1e18 / reserveFMX);
        console2.log("--- depth: what a buy costs at this size ---");
        _quoteDepth(reserveFMX, reserveToken, reserveFMX / 1000, "0.1% of the FMX reserve");
        _quoteDepth(reserveFMX, reserveToken, reserveFMX / 100, "  1% of the FMX reserve");
        _quoteDepth(reserveFMX, reserveToken, reserveFMX / 20, "  5% of the FMX reserve");
    }

    /// @dev The first deposit. Split out of `run` to keep its stack shallow.
    ///      `minLiquidity` is 0: this is the opening deposit into an empty pool,
    ///      where the depositor holds ~100% of the LP and there is no
    ///      counter-party to skim to; the 1% amount floors pin the opening ratio.
    function _seed(FerminuxRouter router, address token, uint256 amountToken, uint256 amountFMX, address deployer)
        internal
        returns (uint256 usedToken, uint256 usedFMX, uint256 liquidity)
    {
        (usedToken, usedFMX, liquidity) = router.addLiquidityFMX{value: amountFMX}(
            token,
            amountToken,
            (amountToken * 99) / 100,
            (amountFMX * 99) / 100,
            0,
            deployer,
            block.timestamp + 15 minutes
        );
    }

    /// @dev Prints the slippage a trade of `amountIn` FMX suffers: the gap
    ///      between the mid price and the price actually filled.
    function _quoteDepth(uint256 reserveIn, uint256 reserveOut, uint256 amountIn, string memory label) internal pure {
        if (amountIn == 0) return;
        uint256 amountOut = FerminuxLibrary.getAmountOut(amountIn, reserveIn, reserveOut);
        uint256 atMid = amountIn * reserveOut / reserveIn;
        uint256 slippageBps = atMid == 0 ? 0 : (atMid - amountOut) * 10_000 / atMid;
        console2.log(label);
        console2.log("  FMX in:            ", amountIn);
        console2.log("  tokens out:        ", amountOut);
        console2.log("  total cost in bps (0.30% fee + impact):", slippageBps);
    }
}
