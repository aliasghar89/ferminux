package scheduler

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"math/big"
	"sync"

	ferminux "github.com/aliasghar89/ferminux/chain"
	"github.com/aliasghar89/ferminux/chain/common"
	"github.com/aliasghar89/ferminux/chain/common/hexutil"
	"github.com/aliasghar89/ferminux/chain/core/types"
	"github.com/aliasghar89/ferminux/chain/crypto"
	"github.com/aliasghar89/ferminux/validator/internal/attest"
	"github.com/aliasghar89/ferminux/validator/internal/hub"
	"github.com/aliasghar89/ferminux/validator/internal/node"
)

// fakeChain is a node, a hub and a transaction pool in one. Blocks are made by
// mine(); attest calls are checked with the hub's rules (window, blockhash,
// signature, seat, one per height) and included in the next block.
type fakeChain struct {
	mu        sync.Mutex
	chainID   uint64
	domain    attest.Domain
	head      uint64
	baseTime  uint64
	fork      map[uint64]common.Hash // override hash at a height
	syncing   bool
	peers     int
	seats     map[common.Address]uint64
	status    map[uint64]hub.Status
	atts      map[[2]uint64]common.Hash
	last      map[uint64]uint64
	pending   []pendingAttest
	receipts  map[common.Hash]uint64
	reverted  map[common.Hash]bool
	sentData  [][]byte
	separator *common.Hash // override domainSeparator()
	paused    bool
	rotatedAt map[common.Address]uint64
	nextTx    uint64
}

type pendingAttest struct {
	tx   common.Hash
	data []byte
}

func newFake(chainID uint64, hubAddr common.Address) *fakeChain {
	return &fakeChain{
		chainID: chainID, domain: attest.Domain{ChainID: chainID, Hub: hubAddr},
		head: 1240, baseTime: 1_800_000_000, fork: map[uint64]common.Hash{}, peers: 5,
		seats: map[common.Address]uint64{}, status: map[uint64]hub.Status{},
		atts: map[[2]uint64]common.Hash{}, last: map[uint64]uint64{},
		receipts: map[common.Hash]uint64{}, reverted: map[common.Hash]bool{},
		rotatedAt: map[common.Address]uint64{},
	}
}

func (f *fakeChain) hashAt(n uint64) common.Hash {
	if h, ok := f.fork[n]; ok {
		return h
	}
	var b [8]byte
	binary.BigEndian.PutUint64(b[:], n)
	return crypto.Keccak256Hash([]byte("fake block"), b[:])
}

func (f *fakeChain) timeAt(n uint64) uint64 { return f.baseTime + 7*n }

// mine adds one block, including every pending attestation that passes the hub's checks.
func (f *fakeChain) mine() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.head++
	for _, p := range f.pending {
		f.receipts[p.tx] = f.head
		if err := f.applyAttest(p.data, f.head); err != nil {
			f.reverted[p.tx] = true
		}
	}
	f.pending = nil
}

func (f *fakeChain) mineTo(n uint64) {
	for f.headNum() < n {
		f.mine()
	}
}

func (f *fakeChain) headNum() uint64 {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.head
}

func (f *fakeChain) applyAttest(data []byte, block uint64) error {
	h, hash, sig, err := hub.UnpackAttest(data)
	if err != nil {
		return err
	}
	if h == 0 || h%200 != 0 {
		return errors.New("NotCheckpoint")
	}
	if block < h+64 || block > h+250 {
		return errors.New("OutsideWindow")
	}
	if f.hashAt(h) != hash {
		return errors.New("WrongBlockHash")
	}
	signer, err := f.domain.Recover(h, hash, sig)
	if err != nil {
		return err
	}
	seat := f.seats[signer]
	if seat == 0 {
		return errors.New("UnknownAttester")
	}
	if f.status[seat] != hub.StatusActive {
		return errors.New("SeatNotActive")
	}
	if f.atts[[2]uint64{seat, h}] != (common.Hash{}) {
		return errors.New("AlreadyAttested")
	}
	f.atts[[2]uint64{seat, h}] = hash
	if h > f.last[seat] {
		f.last[seat] = h
	}
	return nil
}

// forceAttest records an attestation as if another machine had submitted it.
func (f *fakeChain) forceAttest(seat, h uint64, hash common.Hash) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.atts[[2]uint64{seat, h}] = hash
	if h > f.last[seat] {
		f.last[seat] = h
	}
}

// --- node.Chain ---

func (f *fakeChain) ChainID(context.Context) (uint64, error) { return f.chainID, nil }
func (f *fakeChain) Head(ctx context.Context) (node.Header, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return node.Header{Number: f.head, Hash: f.hashAt(f.head), Time: f.timeAt(f.head), BaseFee: (*hexutil.Big)(big.NewInt(1e9))}, nil
}
func (f *fakeChain) HeaderAt(ctx context.Context, n uint64) (node.Header, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if n > f.head {
		return node.Header{}, ferminux.NotFound
	}
	return node.Header{Number: n, Hash: f.hashAt(n), Time: f.timeAt(n)}, nil
}
func (f *fakeChain) Syncing(context.Context) (bool, error)  { return f.syncing, nil }
func (f *fakeChain) PeerCount(context.Context) (int, error) { return f.peers, nil }
func (f *fakeChain) Balance(context.Context, common.Address) (*big.Int, error) {
	return big.NewInt(1e18), nil
}
func (f *fakeChain) CodeAt(context.Context, common.Address) ([]byte, error) { return []byte{1}, nil }
func (f *fakeChain) CallContract(context.Context, ferminux.CallMsg, *big.Int) ([]byte, error) {
	return nil, errors.New("unused")
}
func (f *fakeChain) NonceAt(context.Context, common.Address) (uint64, error) { return 0, nil }
func (f *fakeChain) EstimateGas(context.Context, ferminux.CallMsg) (uint64, error) {
	return 60000, nil
}
func (f *fakeChain) SendTransaction(context.Context, *types.Transaction) error { return nil }
func (f *fakeChain) TransactionReceipt(context.Context, common.Hash) (*types.Receipt, error) {
	return nil, ferminux.NotFound
}

// --- hub.Reader ---

func (f *fakeChain) Address() common.Address { return f.domain.Hub }
func (f *fakeChain) DomainSeparator(context.Context) (common.Hash, error) {
	if f.separator != nil {
		return *f.separator, nil
	}
	return f.domain.Separator(), nil
}
func (f *fakeChain) AttestationDigest(_ context.Context, h uint64, bh common.Hash) (common.Hash, error) {
	d := f.domain
	if f.separator != nil {
		d.Hub = common.Address{0xde, 0xad}
	}
	return d.Digest(h, bh), nil
}
func (f *fakeChain) KeyInfo(_ context.Context, a common.Address) (hub.Key, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	id := f.seats[a]
	if id == 0 {
		return hub.Key{}, nil
	}
	return hub.Key{SeatID: id, Role: 1, Active: true}, nil
}
func (f *fakeChain) Seat(_ context.Context, id, head uint64) (hub.Seat, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for a, s := range f.seats {
		if s == id {
			st := f.status[id]
			return hub.Seat{ID: id, Owner: common.HexToAddress("0x0f00"), Attester: a, Status: st, StatusText: st.String(),
				Claimable: new(big.Int), Deposit: big.NewInt(2e18), LastAttestedHeight: f.last[id]}, nil
		}
	}
	return hub.Seat{}, fmt.Errorf("no seat %d", id)
}
func (f *fakeChain) Attested(_ context.Context, id, h uint64) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.atts[[2]uint64{id, h}] != (common.Hash{}), nil
}
func (f *fakeChain) Checkpoint(_ context.Context, h uint64) (hub.Checkpoint, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for k, v := range f.atts {
		if k[1] == h {
			return hub.Checkpoint{Height: h, BlockHash: v, Count: 1, Total: 1}, nil
		}
	}
	return hub.Checkpoint{Height: h}, nil
}
func (f *fakeChain) Participation(_ context.Context, id, n uint64) (uint64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.head <= 250 {
		return 0, nil
	}
	last := (f.head - 251) / 200
	var c uint64
	for i := uint64(0); i < n && last >= i+1; i++ {
		if f.atts[[2]uint64{id, (last - i) * 200}] != (common.Hash{}) {
			c++
		}
	}
	return c, nil
}
func (f *fakeChain) AttesterSince(_ context.Context, seat uint64, key common.Address) (uint64, bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	b, ok := f.rotatedAt[key]
	return b, ok, nil
}
func (f *fakeChain) Pool(context.Context) (hub.Pool, error) {
	return hub.Pool{RewardPerAttest: big.NewInt(25e15), RewardPool: new(big.Int).Mul(big.NewInt(1e18), big.NewInt(1000)), OccupiedSeats: uint64(len(f.seats)), MaxSeats: 100, Paused: f.paused}, nil
}

// --- Submitter ---

func (f *fakeChain) Submit(_ context.Context, h uint64, data []byte) (common.Hash, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.nextTx++
	tx := crypto.Keccak256Hash([]byte(fmt.Sprintf("tx-%d", f.nextTx)))
	f.pending = append(f.pending, pendingAttest{tx: tx, data: append([]byte(nil), data...)})
	f.sentData = append(f.sentData, append([]byte(nil), data...))
	return tx, nil
}

func (f *fakeChain) Receipt(_ context.Context, tx common.Hash) (bool, uint64, bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	b, ok := f.receipts[tx]
	if !ok {
		return false, 0, false, nil
	}
	return true, b, !f.reverted[tx], nil
}

func (f *fakeChain) sentCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.sentData)
}
