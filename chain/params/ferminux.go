// Copyright 2026 The Ferminux Network Authors
// This file is part of ferminux-geth, a fork of go-ethereum v1.10.26.

package params

import (
	"math/big"

	"github.com/ethereum/go-ethereum/common"
)

// Ferminux Network (ChainID 3961) — sovereign EVM Layer-1, Ethash PoW.
var (
	// FerminuxGenesisHash is the hash of the Ferminux genesis block, identical
	// to genesis/genesis.json in the ferminux-network repository.
	FerminuxGenesisHash = common.HexToHash("0x1b62e052ee210c433440b9cd21b93b3e6cdc813fe63674c842bca3967d92fadf")

	// FerminuxChainConfig is the chain configuration of the Ferminux Network:
	// every Ethereum protocol upgrade through London (EIP-1559) is active from
	// genesis, consensus is Ethash PoW. The retuned difficulty (~7s target)
	// and 6 FMX halving reward live in consensus/ethash/ferminux.go and apply
	// unconditionally to every chain this binary runs.
	FerminuxChainConfig = &ChainConfig{
		ChainID:             big.NewInt(3961),
		HomesteadBlock:      big.NewInt(0),
		EIP150Block:         big.NewInt(0),
		EIP155Block:         big.NewInt(0),
		EIP158Block:         big.NewInt(0),
		ByzantiumBlock:      big.NewInt(0),
		ConstantinopleBlock: big.NewInt(0),
		PetersburgBlock:     big.NewInt(0),
		IstanbulBlock:       big.NewInt(0),
		MuirGlacierBlock:    big.NewInt(0),
		BerlinBlock:         big.NewInt(0),
		LondonBlock:         big.NewInt(0),
		PosaBlock:           big.NewInt(160000),
		Ethash:              new(EthashConfig),
	}

	// FerminuxBootnodes are the enode URLs of the P2P bootstrap nodes running
	// on the Ferminux network. Every zero-config node dials these on startup,
	// so the network self-assembles with no manual peering.
	//
	// boot1 key was generated on the bootnode host at the 2026-08-20 launch;
	// boot2/boot3 are added here as their hosts come online.
	FerminuxBootnodes = []string{
		// boot1.ferminux.net
		"enode://b31c40acfe75bfaa74c9a0306c4bdf940e6a5b1220f9ba9eaafcd94f34b8424613834631cd20606a2cd18f5f26e8b6c761145f62dcbd2bf8556e7bcc894584e0@152.53.112.210:30303",
	}
)

// Ferminux proof-of-authority (PoSA) parameters.
//
// After the 2026-08-21 stall (rented hashrate left and the Ethash chain stood
// still for 4.6 hours) the network moves, at ChainConfig.PosaBlock, from
// Ethash PoW to a 5-signer Clique authority engine. This IS proof-of-authority:
// staking is not part of consensus. The wrapper engine lives in consensus/posa;
// the Clique parameters deliberately live here rather than in
// ChainConfig.Clique (genesis.go refuses a Clique config on a chain whose
// genesis extraData, 29 bytes on Ferminux, carries no signer list).
const (
	// FerminuxPosaPeriod is the minimum number of seconds between PoSA blocks.
	FerminuxPosaPeriod = 7

	// FerminuxPosaEpoch is the checkpoint interval: every FerminuxPosaEpoch
	// blocks the header carries the full signer list and pending votes reset.
	FerminuxPosaEpoch = 30000

	// FerminuxMaxReorgDepth is the deepest chain reorganisation a node whose
	// head is an authority block (>= PosaBlock) accepts without being started
	// with --ferminux.allowdeepreorg. It is the only thing standing between a
	// signer-majority history rewrite and unbacked wFMX on BSC: the bridge
	// relayer's node will refuse to follow a rewrite deeper than this. While
	// the head is a proof-of-work block (PosaBlock unset, or still syncing the
	// pre-fork segment) the cap is inert and stock heaviest-chain rules apply;
	// an authority head is never abandoned for a proof-of-work head at all
	// (core/forkchoice.go).
	FerminuxMaxReorgDepth = 64

	// FerminuxBreakGlassThreshold is the number of distinct Ferminux multisig
	// owner signatures a signer-set override needs.
	FerminuxBreakGlassThreshold = 2
)

var (
	// FerminuxInitialSigners is the authority set seeded at PosaBlock. The
	// snapshot at PosaBlock-1 is created from this list; signer state is never
	// derived from the (signer-less) genesis extraData.
	FerminuxInitialSigners = []common.Address{
		common.HexToAddress("0x3322f60aCEA9f88658665E83BeB30a516036187D"),
		common.HexToAddress("0xA46A721F25771BB2Be312a63A5D891539fF1de23"),
		common.HexToAddress("0x1538249E04c767dFfC50845068C19F633341bB0f"),
		common.HexToAddress("0x71377E0F553a5B0CB847443ab6648235977919b0"),
		common.HexToAddress("0x8e97f419F388c20E745dFF826587f359C31EF693"),
	}

	// FerminuxTreasury receives 10% of every PoSA block reward. CONSENSUS
	// CONSTANT once PosaBlock is set: it is an AddBalance target of every
	// PoSA block and not covered by the fork ID, so changing it later needs a
	// *Block-gated hard fork.
	FerminuxTreasury = common.HexToAddress("0xc0A5Eb613f859f072554F29f1Ab7400265af15aB")

	// FerminuxRewardSink is the FMXRewardSink contract (contracts/src/
	// FMXRewardSink.sol) that receives 50% of every PoSA block reward.
	//
	// RELEASE RULE: deploy FMXRewardSink under proof-of-work (any time before
	// the fork) and pin its address here in the SAME release that sets
	// PosaBlock. The engine refuses to start with PosaBlock set and this
	// zero (consensus/posa.New): the sink is part of the state transition of
	// every PoSA block and not covered by the fork ID, so a fleet with mixed
	// values would split silently. There is no "route to treasury while
	// unset" fallback. Never point this at the FMXStaking contract.
	//
	// RELEASE A (v1.1.0-posa): pinned to the deployed FMXRewardSink contract
	// (owner = the Ferminux multisig) in the same release that sets PosaBlock.
	// FerminuxPosaCheckpointHash stays zero here; release B pins hash(F-1)
	// after the fork is final.
	FerminuxRewardSink = common.HexToAddress("0x691E5275BF346FfFa0B30174dDBeDfCC078dd8D6")

	// FerminuxPosaCheckpointHash is the required hash of block PosaBlock-1 (the
	// last Ethash block). Zero disables the check; once the operator pins it
	// at release time, a header at PosaBlock-1 with any other hash (and a
	// PosaBlock header with any other parent) is rejected.
	FerminuxPosaCheckpointHash = common.Hash{}

	// FerminuxBreakGlassAddress is the Ferminux multisig. A contract cannot
	// produce an ECDSA signature, so the break-glass override is authorised by
	// FerminuxBreakGlassThreshold of its owners (FerminuxBreakGlassOwners)
	// instead. Kept for documentation and tooling.
	FerminuxBreakGlassAddress = common.HexToAddress("0x910BD467D8576277f8f96DF47428377FFD94fEfe")

	// FerminuxBreakGlassOwners are the owner keys of the Ferminux multisig.
	// Any authority block may carry a signer-set override in its extraData
	// when it is accompanied by EIP-191 signatures over (chainId, number,
	// parentHash, signerList) from at least FerminuxBreakGlassThreshold
	// distinct owners. Such a block may be sealed by any member of the
	// override list regardless of the recently-signed window, so a halted
	// chain (too few live signers) recovers in one block; see
	// consensus/clique/ferminux.go for the exact byte layout.
	FerminuxBreakGlassOwners = []common.Address{
		common.HexToAddress("0x1a143bf911E1E097730f3aA8C809C6B9109019EA"),
		common.HexToAddress("0x0fBBa0CC0e4f748Dc2Af25dDD3992700e7FCce15"),
		common.HexToAddress("0x11B53110eb83c548b392a56410bF5f959E6F41db"),
	}
)
