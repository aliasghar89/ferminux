// Package hub is the sidecar's view of the ValidatorHub contract
// (agents/contracts/src/validators/ValidatorHub.sol).
//
// abi.json is the subset of the hub's ABI the sidecar calls, generated from the
// real contract by testdata/hubtest/gen-abi.sh. Seats are decoded from the
// hub's storage through its extsload view, with the slot layout the hub's
// ValidatorHubLens uses (the hub is not upgradeable, so the layout is fixed;
// the hub's own tests pin it). If the hub's interface changes, regenerate
// abi.json and adjust this file only: the scheduler and the dashboard use the
// Go types below and nothing else.
package hub

import (
	"context"
	_ "embed"
	"errors"
	"fmt"
	"math/big"
	"strings"

	ferminux "github.com/aliasghar89/ferminux/chain"
	"github.com/aliasghar89/ferminux/chain/accounts/abi"
	"github.com/aliasghar89/ferminux/chain/common"
	"github.com/aliasghar89/ferminux/chain/core/types"
	"github.com/aliasghar89/ferminux/chain/crypto"
)

//go:embed abi.json
var abiJSON string

// ABI is the parsed hub surface.
var ABI = func() abi.ABI {
	a, err := abi.JSON(strings.NewReader(abiJSON))
	if err != nil {
		panic("hub: bad embedded abi.json: " + err.Error())
	}
	return a
}()

// Storage layout (ValidatorHubLens constants; forge inspect ValidatorHub storageLayout).
const (
	slotSeats  = 33 // mapping(uint256 => Seat), 6 words per seat
	seatWords  = 6
	roleAttest = 1
)

// Raw seat status values (ValidatorHub NONE, BONDED, EXITING, WITHDRAWN).
const (
	rawNone      = 0
	rawBonded    = 1
	rawExiting   = 2
	rawWithdrawn = 3
)

// Slash states.
const (
	SlashNone     = 0
	SlashPending  = 1
	SlashExecuted = 2
)

// Status is a seat's state as the sidecar reports it.
type Status uint8

// Seat states.
const (
	StatusNone    Status = iota // no such seat
	StatusPending               // bonded, activation block not reached
	StatusActive                // bonded and attesting
	StatusJailed                // bonded, paused for low participation
	StatusExiting               // unbonding
	StatusClosed                // withdrawn
)

func (s Status) String() string {
	switch s {
	case StatusNone:
		return "none"
	case StatusPending:
		return "waiting to activate"
	case StatusActive:
		return "active"
	case StatusJailed:
		return "paused (jailed)"
	case StatusExiting:
		return "unbonding"
	case StatusClosed:
		return "closed"
	}
	return fmt.Sprintf("unknown(%d)", uint8(s))
}

// Seat is a decoded ValidatorHub.Seat. Block fields are block numbers.
type Seat struct {
	ID                  uint64         `json:"id"`
	Status              Status         `json:"status"`
	StatusText          string         `json:"statusText"`
	Owner               common.Address `json:"owner"`
	Attester            common.Address `json:"attester"`
	PendingAttester     common.Address `json:"pendingAttester,omitempty"`
	AttesterRotateBlock uint64         `json:"attesterRotateBlock,omitempty"`
	Claimable           *big.Int       `json:"claimableWei"`
	Deposit             *big.Int       `json:"depositWei"`
	LastAttestedHeight  uint64         `json:"lastAttestedHeight"`
	ActivationBlock     uint64         `json:"activationBlock"`
	CountedSince        uint64         `json:"countedSince"` // 0 = not yet counted for certification
	Jailed              bool           `json:"jailed"`
	UnjailBlock         uint64         `json:"unjailBlock,omitempty"`
	UnbondEndBlock      uint64         `json:"unbondEndBlock,omitempty"`
	SlashState          uint8          `json:"slashState"`
}

// Eligible reports whether the seat counts toward certification.
func (s Seat) Eligible() bool { return s.CountedSince != 0 }

// Checkpoint is ValidatorHub.checkpoint(height).
type Checkpoint struct {
	Height        uint64      `json:"height"`
	BlockHash     common.Hash `json:"blockHash"`
	Count         uint32      `json:"count"`
	Eligible      uint32      `json:"eligible"`
	Total         uint32      `json:"total"`
	SnapshotBlock uint64      `json:"snapshotBlock"`
	Certified     bool        `json:"certified"`
}

// Key is ValidatorHub.keyInfo(key).
type Key struct {
	SeatID uint64
	Role   uint8
	Active bool
}

// IsAttester reports whether the key is (or is queued to become) a seat's attester.
func (k Key) IsAttester() bool { return k.SeatID != 0 && k.Role == roleAttest }

// Pool is the reward side of the hub.
type Pool struct {
	RewardPerAttest *big.Int `json:"rewardPerAttestWei"`
	RewardPool      *big.Int `json:"rewardPoolWei"`
	OccupiedSeats   uint64   `json:"occupiedSeats"`
	EligibleSeats   uint64   `json:"eligibleSeats"`
	MaxSeats        uint64   `json:"maxSeats"`
	Paused          bool     `json:"attestationsPaused"`
}

// Reader is everything the sidecar reads from the hub.
type Reader interface {
	Address() common.Address
	DomainSeparator(ctx context.Context) (common.Hash, error)
	AttestationDigest(ctx context.Context, height uint64, blockHash common.Hash) (common.Hash, error)
	KeyInfo(ctx context.Context, key common.Address) (Key, error)
	Seat(ctx context.Context, id uint64, head uint64) (Seat, error)
	Attested(ctx context.Context, id, height uint64) (bool, error)
	Checkpoint(ctx context.Context, height uint64) (Checkpoint, error)
	Participation(ctx context.Context, id, n uint64) (uint64, error)
	Pool(ctx context.Context) (Pool, error)
	// AttesterSince returns the block at which key became the seat's attester
	// through a rotation (AttesterRotated). rotated=false means key has been
	// the attester since the seat was opened.
	AttesterSince(ctx context.Context, seatID uint64, key common.Address) (block uint64, rotated bool, err error)
}

// Backend performs eth_call and eth_getLogs against the latest block.
type Backend interface {
	CallContract(ctx context.Context, msg ferminux.CallMsg, blockNumber *big.Int) ([]byte, error)
	FilterLogs(ctx context.Context, q ferminux.FilterQuery) ([]types.Log, error)
}

// Binding reads a hub through a Backend.
type Binding struct {
	addr common.Address
	c    Backend
}

// New binds the hub at addr.
func New(addr common.Address, c Backend) *Binding { return &Binding{addr: addr, c: c} }

// Address is the hub's address.
func (b *Binding) Address() common.Address { return b.addr }

func (b *Binding) call(ctx context.Context, method string, args ...interface{}) ([]interface{}, error) {
	data, err := ABI.Pack(method, args...)
	if err != nil {
		return nil, err
	}
	to := b.addr
	out, err := b.c.CallContract(ctx, ferminux.CallMsg{To: &to, Data: data}, nil)
	if err != nil {
		return nil, fmt.Errorf("hub.%s: %w", method, err)
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("hub.%s: empty result (is %s the ValidatorHub?)", method, b.addr.Hex())
	}
	res, err := ABI.Unpack(method, out)
	if err != nil {
		return nil, fmt.Errorf("hub.%s: %w", method, err)
	}
	return res, nil
}

func bigU64(v interface{}) (uint64, error) {
	x, ok := v.(*big.Int)
	if !ok {
		return 0, fmt.Errorf("hub: unexpected type %T", v)
	}
	if !x.IsUint64() {
		return 0, errors.New("hub: value exceeds uint64")
	}
	return x.Uint64(), nil
}

func (b *Binding) hash(ctx context.Context, method string, args ...interface{}) (common.Hash, error) {
	r, err := b.call(ctx, method, args...)
	if err != nil {
		return common.Hash{}, err
	}
	return common.Hash(r[0].([32]byte)), nil
}

func (b *Binding) u64(ctx context.Context, method string, args ...interface{}) (uint64, error) {
	r, err := b.call(ctx, method, args...)
	if err != nil {
		return 0, err
	}
	return bigU64(r[0])
}

// DomainSeparator is domainSeparator().
func (b *Binding) DomainSeparator(ctx context.Context) (common.Hash, error) {
	return b.hash(ctx, "domainSeparator")
}

// AttestationDigest is attestationDigest(height, blockHash).
func (b *Binding) AttestationDigest(ctx context.Context, height uint64, blockHash common.Hash) (common.Hash, error) {
	return b.hash(ctx, "attestationDigest", height, [32]byte(blockHash))
}

// KeyInfo is keyInfo(key).
func (b *Binding) KeyInfo(ctx context.Context, key common.Address) (Key, error) {
	r, err := b.call(ctx, "keyInfo", key)
	if err != nil {
		return Key{}, err
	}
	type keyInfo struct {
		SeatId uint64
		Role   uint8
		Active bool
	}
	k := *abi.ConvertType(r[0], new(keyInfo)).(*keyInfo)
	return Key{SeatID: k.SeatId, Role: k.Role, Active: k.Active}, nil
}

// seatSlot is keccak256(abi.encode(id, slotSeats)).
func seatSlot(id uint64) *big.Int {
	buf := make([]byte, 64)
	new(big.Int).SetUint64(id).FillBytes(buf[:32])
	big.NewInt(slotSeats).FillBytes(buf[32:])
	return new(big.Int).SetBytes(crypto.Keccak256(buf))
}

// Seat decodes seat id from storage. head is used to tell "waiting to activate" from "active".
func (b *Binding) Seat(ctx context.Context, id, head uint64) (Seat, error) {
	base := seatSlot(id)
	slots := make([][32]byte, seatWords)
	for i := range slots {
		new(big.Int).Add(base, big.NewInt(int64(i))).FillBytes(slots[i][:])
	}
	r, err := b.call(ctx, "extsload", slots)
	if err != nil {
		return Seat{}, err
	}
	w := r[0].([][32]byte)
	if len(w) != seatWords {
		return Seat{}, fmt.Errorf("hub: extsload returned %d words", len(w))
	}
	return DecodeSeat(id, w, head), nil
}

func bits(word [32]byte, shift, width uint) *big.Int {
	x := new(big.Int).SetBytes(word[:])
	x.Rsh(x, shift)
	return x.And(x, new(big.Int).Sub(new(big.Int).Lsh(big.NewInt(1), width), big.NewInt(1)))
}

// DecodeSeat unpacks the six storage words of a ValidatorHub.Seat.
func DecodeSeat(id uint64, w [][32]byte, head uint64) Seat {
	s := Seat{ID: id}
	// word a: claimable u96 | lastAttestedCp u32 | dutyStartCp u32 | activationBlock u40 | countedSince u40 | status u8 | jailed bool
	s.Claimable = bits(w[0], 0, 96)
	s.LastAttestedHeight = bits(w[0], 96, 32).Uint64() * 200
	s.ActivationBlock = bits(w[0], 160, 40).Uint64()
	s.CountedSince = bits(w[0], 200, 40).Uint64()
	raw := bits(w[0], 240, 8).Uint64()
	s.Jailed = bits(w[0], 248, 8).Sign() != 0
	// word b: owner | unjailBlock u40 | unbondEndBlock u40 | slashState u8 | qualified bool
	s.Owner = common.BytesToAddress(w[1][12:])
	s.UnjailBlock = bits(w[1], 160, 40).Uint64()
	s.UnbondEndBlock = bits(w[1], 200, 40).Uint64()
	s.SlashState = uint8(bits(w[1], 240, 8).Uint64())
	// word c: attester | deposit u96
	s.Attester = common.BytesToAddress(w[2][12:])
	s.Deposit = bits(w[2], 160, 96)
	// word d: pendingAttester | attesterRotateBlock u40
	s.PendingAttester = common.BytesToAddress(w[3][12:])
	s.AttesterRotateBlock = bits(w[3], 160, 40).Uint64()
	switch {
	case raw == rawBonded && s.Jailed:
		s.Status = StatusJailed
	case raw == rawBonded && head < s.ActivationBlock:
		s.Status = StatusPending
	case raw == rawBonded:
		s.Status = StatusActive
	case raw == rawExiting:
		s.Status = StatusExiting
	case raw == rawWithdrawn:
		s.Status = StatusClosed
	default:
		s.Status = StatusNone
	}
	s.StatusText = s.Status.String()
	return s
}

// Attested is attested(seatId, height): whether the seat has an accepted
// attestation for that checkpoint (reliable for the 511 checkpoints before its latest).
func (b *Binding) Attested(ctx context.Context, id, height uint64) (bool, error) {
	r, err := b.call(ctx, "attested", new(big.Int).SetUint64(id), new(big.Int).SetUint64(height))
	if err != nil {
		return false, err
	}
	return r[0].(bool), nil
}

// Checkpoint is checkpoint(height).
func (b *Binding) Checkpoint(ctx context.Context, height uint64) (Checkpoint, error) {
	r, err := b.call(ctx, "checkpoint", new(big.Int).SetUint64(height))
	if err != nil {
		return Checkpoint{}, err
	}
	type checkpoint struct {
		BlockHash     [32]byte
		Count         uint32
		Eligible      uint32
		Total         uint32
		SnapshotBlock *big.Int
		Certified     bool
	}
	c := *abi.ConvertType(r[0], new(checkpoint)).(*checkpoint)
	return Checkpoint{Height: height, BlockHash: c.BlockHash, Count: c.Count, Eligible: c.Eligible, Total: c.Total,
		SnapshotBlock: c.SnapshotBlock.Uint64(), Certified: c.Certified}, nil
}

// Participation is participation(seatId, n): attested checkpoints among the last n closed ones.
func (b *Binding) Participation(ctx context.Context, id, n uint64) (uint64, error) {
	return b.u64(ctx, "participation", new(big.Int).SetUint64(id), new(big.Int).SetUint64(n))
}

// Pool reads the reward and seat-count figures.
func (b *Binding) Pool(ctx context.Context) (Pool, error) {
	var p Pool
	r, err := b.call(ctx, "currentRewardPerAttest")
	if err != nil {
		return p, err
	}
	p.RewardPerAttest = r[0].(*big.Int)
	if r, err = b.call(ctx, "rewardPool"); err != nil {
		return p, err
	}
	p.RewardPool = r[0].(*big.Int)
	if p.OccupiedSeats, err = b.u64(ctx, "occupiedSeats"); err != nil {
		return p, err
	}
	if p.EligibleSeats, err = b.u64(ctx, "eligibleCount"); err != nil {
		return p, err
	}
	if p.MaxSeats, err = b.u64(ctx, "maxSeats"); err != nil {
		return p, err
	}
	if r, err = b.call(ctx, "attestationsPaused"); err != nil {
		return p, err
	}
	p.Paused = r[0].(bool)
	return p, nil
}

// AttesterSince looks for the AttesterRotated event that made key the seat's attester.
func (b *Binding) AttesterSince(ctx context.Context, seatID uint64, key common.Address) (uint64, bool, error) {
	from, err := b.u64(ctx, "deployBlock")
	if err != nil {
		return 0, false, err
	}
	ev, ok := ABI.Events["AttesterRotated"]
	if !ok {
		return 0, false, errors.New("hub: abi.json lacks AttesterRotated")
	}
	logs, err := b.c.FilterLogs(ctx, ferminux.FilterQuery{
		FromBlock: new(big.Int).SetUint64(from),
		Addresses: []common.Address{b.addr},
		Topics: [][]common.Hash{{ev.ID}, {common.BigToHash(new(big.Int).SetUint64(seatID))}, nil,
			{common.BytesToHash(key.Bytes())}},
	})
	if err != nil {
		return 0, false, fmt.Errorf("hub: AttesterRotated logs: %w", err)
	}
	if len(logs) == 0 {
		return 0, false, nil
	}
	return logs[len(logs)-1].BlockNumber, true, nil
}

// PackAttest encodes attest(height, blockHash, sig) calldata.
func PackAttest(height uint64, blockHash common.Hash, sig []byte) ([]byte, error) {
	return ABI.Pack("attest", height, [32]byte(blockHash), sig)
}

// UnpackAttest decodes attest calldata (used by tests and the fake chain).
func UnpackAttest(data []byte) (height uint64, blockHash common.Hash, sig []byte, err error) {
	m, ok := ABI.Methods["attest"]
	if !ok || len(data) < 4 || string(data[:4]) != string(m.ID) {
		return 0, common.Hash{}, nil, errors.New("hub: not attest calldata")
	}
	vals, err := m.Inputs.Unpack(data[4:])
	if err != nil {
		return 0, common.Hash{}, nil, err
	}
	return vals[0].(uint64), common.Hash(vals[1].([32]byte)), vals[2].([]byte), nil
}

// PackOpenSeat encodes openSeat(attester, attesterSig, enodePubkey, enodeSig)
// calldata, for the owner's wallet to send with exactly 2,000 FMX.
func PackOpenSeat(attester common.Address, attesterSig, enodePubkey, enodeSig []byte) ([]byte, error) {
	return ABI.Pack("openSeat", attester, attesterSig, enodePubkey, enodeSig)
}

// DecodeRevert names a hub custom error from revert data, if it is one.
func DecodeRevert(data []byte) string {
	if len(data) < 4 {
		return ""
	}
	for name, e := range ABI.Errors {
		if string(e.ID[:4]) == string(data[:4]) {
			vals, err := e.Inputs.Unpack(data[4:])
			if err != nil || len(vals) == 0 {
				return name
			}
			if name == "AttestationRejected" && len(vals) == 1 {
				if code, ok := vals[0].(*big.Int); ok {
					return fmt.Sprintf("AttestationRejected(%s)", rejectReason(code.Uint64()))
				}
			}
			return fmt.Sprintf("%s%v", name, vals)
		}
	}
	return ""
}

func rejectReason(code uint64) string {
	switch code {
	case 1:
		return "bad signature"
	case 2:
		return "key is not an active attester"
	case 3:
		return "seat not active"
	case 4:
		return "already attested"
	}
	return fmt.Sprintf("code %d", code)
}

// CheckpointsPerDay at 7-second blocks and 200-block checkpoints.
const CheckpointsPerDay = 86400.0 / 7 / 200

// ExpectedPerDay estimates FMX (wei) per day for a seat attesting every
// checkpoint: rewardPerAttest × checkpoints per day (86,400 s / 7 s / 200).
func ExpectedPerDay(rewardPerAttest *big.Int, blockSeconds, interval uint64) *big.Int {
	if rewardPerAttest == nil || blockSeconds == 0 || interval == 0 {
		return new(big.Int)
	}
	x := new(big.Int).Mul(rewardPerAttest, big.NewInt(86400))
	return x.Div(x, new(big.Int).SetUint64(blockSeconds*interval))
}
