package scheduler

import (
	"context"
	"crypto/ecdsa"
	"errors"
	"fmt"
	"math/big"
	"strings"
	"sync"

	ferminux "github.com/aliasghar89/ferminux/chain"
	"github.com/aliasghar89/ferminux/chain/common"
	"github.com/aliasghar89/ferminux/chain/core/types"
	"github.com/aliasghar89/ferminux/validator/internal/node"
)

// Submitter sends attest calldata to the hub and reports inclusion.
type Submitter interface {
	Submit(ctx context.Context, height uint64, data []byte) (common.Hash, error)
	// Receipt: found=false while pending.
	Receipt(ctx context.Context, tx common.Hash) (found bool, block uint64, success bool, err error)
}

var (
	// ErrHubRefused: the hub would revert the attestation (gas estimation failed).
	ErrHubRefused = errors.New("the hub refuses this attestation")
	// ErrLowBalance: the attester key cannot pay the fee.
	ErrLowBalance = errors.New("the attester key has too little FMX for the fee")
	// ErrFeeCap: the network's base fee is above the configured limit.
	ErrFeeCap = errors.New("base fee is above the configured gas.maxFeeGwei")
)

// TxSubmitter signs and sends attest transactions from the attester key.
type TxSubmitter struct {
	Chain   node.Chain
	Key     *ecdsa.PrivateKey
	From    common.Address
	ChainID *big.Int
	Hub     common.Address
	Tip     *big.Int // wei
	MaxFee  *big.Int // wei

	mu   sync.Mutex
	last *sent
}

type sent struct {
	nonce  uint64
	tip    *big.Int
	feeCap *big.Int
	hash   common.Hash
}

// Gwei converts a float gwei amount to wei.
func Gwei(g float64) *big.Int {
	f := new(big.Float).Mul(big.NewFloat(g), big.NewFloat(1e9))
	i, _ := f.Int(nil)
	return i
}

func bump(x *big.Int) *big.Int {
	// +12.5% and one wei: above the node's 10% replacement threshold
	y := new(big.Int).Div(x, big.NewInt(8))
	y.Add(y, x)
	return y.Add(y, big.NewInt(1))
}

func maxBig(a, b *big.Int) *big.Int {
	if a.Cmp(b) >= 0 {
		return new(big.Int).Set(a)
	}
	return new(big.Int).Set(b)
}

// Submit builds, signs and sends one attest transaction. A transaction from an
// earlier checkpoint still pending with the same nonce is replaced (it could
// only revert now: its window has closed).
func (s *TxSubmitter) Submit(ctx context.Context, height uint64, data []byte) (common.Hash, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	head, err := s.Chain.Head(ctx)
	if err != nil {
		return common.Hash{}, err
	}
	nonce, err := s.Chain.NonceAt(ctx, s.From)
	if err != nil {
		return common.Hash{}, err
	}
	to := s.Hub
	gas, err := s.Chain.EstimateGas(ctx, ferminux.CallMsg{From: s.From, To: &to, Data: data})
	if err != nil {
		return common.Hash{}, fmt.Errorf("%w: %v", ErrHubRefused, err)
	}
	gasLimit := gas + gas/4 + 10_000

	tip := new(big.Int).Set(s.Tip)
	var feeCap *big.Int
	if head.BaseFee != nil {
		base := head.BaseFee.ToInt()
		if base.Cmp(s.MaxFee) > 0 {
			return common.Hash{}, fmt.Errorf("%w (base fee %s wei)", ErrFeeCap, base)
		}
		feeCap = new(big.Int).Add(new(big.Int).Mul(base, big.NewInt(2)), tip)
	} else {
		feeCap = new(big.Int).Set(tip)
	}
	if s.last != nil && s.last.nonce == nonce {
		tip = maxBig(tip, bump(s.last.tip))
		feeCap = maxBig(feeCap, bump(s.last.feeCap))
	}
	if feeCap.Cmp(s.MaxFee) > 0 {
		feeCap = new(big.Int).Set(s.MaxFee)
	}
	if tip.Cmp(feeCap) > 0 {
		tip = new(big.Int).Set(feeCap)
	}
	need := new(big.Int).Mul(new(big.Int).SetUint64(gasLimit), feeCap)
	bal, err := s.Chain.Balance(ctx, s.From)
	if err != nil {
		return common.Hash{}, err
	}
	if bal.Cmp(need) < 0 {
		return common.Hash{}, fmt.Errorf("%w: has %s wei, needs up to %s wei", ErrLowBalance, bal, need)
	}
	var tx *types.Transaction
	if head.BaseFee != nil {
		tx = types.NewTx(&types.DynamicFeeTx{ChainID: s.ChainID, Nonce: nonce, GasTipCap: tip, GasFeeCap: feeCap, Gas: gasLimit, To: &to, Data: data})
	} else {
		tx = types.NewTx(&types.LegacyTx{Nonce: nonce, GasPrice: feeCap, Gas: gasLimit, To: &to, Data: data})
	}
	signed, err := types.SignTx(tx, types.LatestSignerForChainID(s.ChainID), s.Key)
	if err != nil {
		return common.Hash{}, err
	}
	if err := s.Chain.SendTransaction(ctx, signed); err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "already known") {
			return signed.Hash(), nil
		}
		return common.Hash{}, err
	}
	s.last = &sent{nonce: nonce, tip: tip, feeCap: feeCap, hash: signed.Hash()}
	return signed.Hash(), nil
}

// Receipt reports inclusion.
func (s *TxSubmitter) Receipt(ctx context.Context, tx common.Hash) (bool, uint64, bool, error) {
	r, err := s.Chain.TransactionReceipt(ctx, tx)
	if errors.Is(err, ferminux.NotFound) || (err == nil && r == nil) {
		return false, 0, false, nil
	}
	if err != nil {
		return false, 0, false, err
	}
	return true, r.BlockNumber.Uint64(), r.Status == types.ReceiptStatusSuccessful, nil
}
