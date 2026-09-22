// Copyright 2026 The Ferminux Network Authors
// This file is part of ferminux-geth, a fork of go-ethereum v1.10.26.

package core

import (
	"math/big"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/params"
)

// DefaultFerminuxGenesisBlock returns the Ferminux Network genesis block.
//
// It is field-for-field identical to genesis/genesis.json in the
// ferminux-network repository (hash params.FerminuxGenesisHash), so a node
// started with an empty datadir and no genesis file joins the Ferminux
// Network by default — no `init` step required.
//
// The five alloc addresses are the REAL owner wallets fixed at the 2026-08-20
// genesis ceremony (encrypted keystores held offline by the founder).
func DefaultFerminuxGenesisBlock() *Genesis {
	return &Genesis{
		Config:     params.FerminuxChainConfig,
		Nonce:      0,
		Timestamp:  0,
		ExtraData:  []byte("Made with love by Wizrd - FMX"),
		GasLimit:   30_000_000,
		Difficulty: big.NewInt(0x80000),
		Mixhash:    common.Hash{},
		Coinbase:   common.Address{},
		BaseFee:    big.NewInt(params.InitialBaseFee), // 1 gwei
		Alloc: GenesisAlloc{
			common.HexToAddress("0xc0A5Eb613f859f072554F29f1Ab7400265af15aB"): {Balance: fmxWei(12_000_000)}, // Treasury
			common.HexToAddress("0xEeDd7368290a17aB2Aa3F298Ff24BB99D581E787"): {Balance: fmxWei(6_000_000)},  // Ecosystem / listings
			common.HexToAddress("0x86e286684Ae5899A941142D143949C444F9Fe831"): {Balance: fmxWei(5_000_000)},  // Team — sent to FMXVesting
			common.HexToAddress("0x040F1E90EF72b364141D91c3C0314ac3b5eCD0AE"): {Balance: fmxWei(4_000_000)},  // AZNT liquidity + market ops
			common.HexToAddress("0x34f5366014EF292fd5ff9FFDE81d47819EF65cFC"): {Balance: fmxWei(3_000_000)},  // Community / faucet / airdrops
		},
	}
}

// fmxWei converts a whole-FMX amount to wei (18 decimals).
func fmxWei(n int64) *big.Int {
	return new(big.Int).Mul(big.NewInt(n), big.NewInt(params.Ether))
}
