// Package status is the sidecar's live state, shared by the attestation
// engine (writer), the dashboard and `fmx-validator status` (readers).
package status

import (
	"math/big"
	"sort"
	"sync"
	"time"

	"github.com/aliasghar89/ferminux/chain/common"
	"github.com/aliasghar89/ferminux/validator/internal/hub"
	"github.com/aliasghar89/ferminux/validator/internal/node"
)

// Attestation states.
const (
	StateWaiting   = "waiting"   // due, not signed yet (node not ready, seat not active …)
	StateWatching  = "watching"  // not signed: checking nobody else uses this key
	StateSubmitted = "submitted" // signed and sent, not yet included
	StateIncluded  = "included"  // on-chain
	StateReverted  = "reverted"  // included but the hub refused it
	StateMissed    = "missed"    // the window closed without an inclusion
	StateSkipped   = "skipped"   // deliberately not signed
	StateRefused   = "refused"   // signing stopped by a safety check
)

// Attestation is one checkpoint as this sidecar saw it.
type Attestation struct {
	Height     uint64      `json:"height"`
	BlockHash  common.Hash `json:"blockHash,omitempty"`
	State      string      `json:"state"`
	Reason     string      `json:"reason,omitempty"`
	Tx         common.Hash `json:"tx,omitempty"`
	IncludedIn uint64      `json:"includedIn,omitempty"`
	Updated    time.Time   `json:"updated"`
}

// Rewards summarises what the seat earns. Amounts are in wei (1 FMX = 1e18).
type Rewards struct {
	RewardPerAttest *big.Int `json:"rewardPerAttestWei"`
	// ExpectedPerDay is rewardPerAttest × checkpoints per day, for a seat that
	// attests every checkpoint while the pool is funded.
	ExpectedPerDay *big.Int `json:"expectedPerDayWei"`
	RewardPool     *big.Int `json:"rewardPoolWei"`
	// PoolEmpty: attestations still count toward certification but earn 0.
	PoolEmpty     bool     `json:"poolEmpty"`
	OccupiedSeats uint64   `json:"occupiedSeats"`
	EligibleSeats uint64   `json:"eligibleSeats"`
	MaxSeats      uint64   `json:"maxSeats"`
	Claimable     *big.Int `json:"claimableWei"`
}

// Gas is the attester key's balance for transaction fees.
type Gas struct {
	Balance *big.Int `json:"balanceWei"`
	Low     bool     `json:"low"`
}

// NodeProc is the supervised node process, when there is one.
type NodeProc struct {
	Supervised bool      `json:"supervised"`
	Running    bool      `json:"running"`
	PID        int       `json:"pid,omitempty"`
	Restarts   int       `json:"restarts"`
	LastExit   string    `json:"lastExit,omitempty"`
	Since      time.Time `json:"since,omitempty"`
}

// Participation is the hub's count of attested checkpoints among the last
// Window closed ones (about 24 h for 62, 7 days for 432).
type Participation struct {
	Window   int `json:"window"`
	Included int `json:"included"`
}

// Snapshot is the whole state at one moment.
type Snapshot struct {
	Version        string         `json:"version"`
	Network        string         `json:"network"`
	ChainID        uint64         `json:"chainId"`
	Hub            common.Address `json:"hub"`
	Attester       common.Address `json:"attester"`
	Started        time.Time      `json:"started"`
	Sync           node.Readiness `json:"sync"`
	Seat           *hub.Seat      `json:"seat,omitempty"`
	SeatError      string         `json:"seatError,omitempty"`
	Halted         string         `json:"halted,omitempty"`
	Paused         bool           `json:"attestationsPaused"`
	Setup          []string       `json:"setup,omitempty"` // what is missing before the sidecar can attest
	WatchLeft      int            `json:"watchCheckpointsLeft"`
	NextCheckpoint uint64         `json:"nextCheckpoint"`
	NextOpensAt    uint64         `json:"nextOpensAt"`
	Attestations   []Attestation  `json:"attestations"`
	Rewards        Rewards        `json:"rewards"`
	Gas            Gas            `json:"gas"`
	Node           NodeProc       `json:"node"`
	Day            Participation  `json:"participation24h"`
	Week           Participation  `json:"participation7d"`
	// Phase is filled in by Tracker.Snapshot from everything above.
	Phase Phase `json:"phase"`
}

// MaxHistory is how many checkpoints the snapshot keeps.
const MaxHistory = 96

// Tracker guards a Snapshot.
type Tracker struct {
	mu sync.RWMutex
	s  Snapshot
}

// NewTracker starts a tracker.
func NewTracker(base Snapshot) *Tracker { return &Tracker{s: base} }

// Update mutates the snapshot under the lock.
func (t *Tracker) Update(f func(s *Snapshot)) {
	t.mu.Lock()
	defer t.mu.Unlock()
	f(&t.s)
}

// Put records or replaces the entry for a checkpoint.
func (t *Tracker) Put(a Attestation) {
	t.mu.Lock()
	defer t.mu.Unlock()
	for i := range t.s.Attestations {
		if t.s.Attestations[i].Height == a.Height {
			t.s.Attestations[i] = a
			return
		}
	}
	t.s.Attestations = append(t.s.Attestations, a)
	sort.Slice(t.s.Attestations, func(i, j int) bool { return t.s.Attestations[i].Height > t.s.Attestations[j].Height })
	if len(t.s.Attestations) > MaxHistory {
		t.s.Attestations = t.s.Attestations[:MaxHistory]
	}
}

// Snapshot returns a copy safe to read without the lock.
func (t *Tracker) Snapshot() Snapshot {
	t.mu.RLock()
	defer t.mu.RUnlock()
	s := t.s
	s.Attestations = append([]Attestation(nil), t.s.Attestations...)
	s.Sync.Reasons = append([]string(nil), t.s.Sync.Reasons...)
	s.Setup = append([]string(nil), t.s.Setup...)
	if t.s.Seat != nil {
		seat := *t.s.Seat
		s.Seat = &seat
	}
	s.Phase = s.CurrentPhase()
	return s
}
