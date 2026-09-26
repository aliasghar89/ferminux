// Package scheduler is the attestation engine: at every checkpoint it waits
// until the block is final on its own node, then checks, records, signs and
// submits exactly one attestation, and it stops signing for good the moment
// anything suggests the key is being used somewhere else.
package scheduler

import (
	"context"
	"crypto/ecdsa"
	"errors"
	"fmt"
	"math/big"
	"sort"
	"strings"
	"time"

	"github.com/aliasghar89/ferminux/chain/common"
	"github.com/aliasghar89/ferminux/chain/crypto"
	"github.com/aliasghar89/ferminux/validator/internal/attest"
	"github.com/aliasghar89/ferminux/validator/internal/hub"
	"github.com/aliasghar89/ferminux/validator/internal/logx"
	"github.com/aliasghar89/ferminux/validator/internal/node"
	"github.com/aliasghar89/ferminux/validator/internal/protect"
	"github.com/aliasghar89/ferminux/validator/internal/status"
)

// ErrKeyInUse means the chain shows an attestation by this key that this
// machine never signed. Another machine holds the same key; signing here too
// risks a 10% slash.
var ErrKeyInUse = errors.New("this attester key has attestations on-chain that this machine did not sign; another machine is using the same key")

// LowGasBalance is the balance under which the dashboard warns (0.05 FMX,
// roughly two weeks of self-submitted attestations).
var LowGasBalance = big.NewInt(5e16)

// FatalError marks a preflight failure that retrying cannot fix.
type FatalError struct{ Err error }

func (f FatalError) Error() string { return f.Err.Error() }
func (f FatalError) Unwrap() error { return f.Err }

// Fatal wraps err as a FatalError.
func Fatal(err error) error { return FatalError{err} }

// IsFatal reports whether a preflight error should stop the sidecar rather than be retried.
func IsFatal(err error) bool {
	var f FatalError
	return errors.As(err, &f)
}

// Engine runs the checkpoint loop.
type Engine struct {
	Chain  node.Chain
	Hub    hub.Reader
	DB     *protect.DB
	Sub    Submitter
	Key    *ecdsa.PrivateKey
	Addr   common.Address
	Domain attest.Domain
	Sched  attest.Schedule
	Policy node.Policy
	Status *status.Tracker
	Log    *logx.Logger
	Now    func() time.Time
	Poll   time.Duration
	// Imported: the key came from elsewhere (keys import).
	Imported bool
	// Adopt: accept on-chain attestations this machine did not make (the old
	// machine is gone for good). They are recorded and a watermark is raised.
	Adopt bool
	// DoppelgangerCheckpoints is how many checkpoint windows an imported or
	// adopted key watches, without signing, before it signs.
	DoppelgangerCheckpoints int
	// BlockSeconds is used for the FMX/day estimate.
	BlockSeconds uint64
	// OnHalt is called once when signing stops for a safety reason, so the
	// caller can make the stop outlive a restart.
	OnHalt func(error)

	scope       protect.Scope
	seatID      uint64
	seat        *hub.Seat
	pool        *hub.Pool
	seatChecked time.Time
	// activeFrom is the first head at which this key was seen as the seat's
	// active attester. Checkpoints that opened before it may carry a previous
	// key's attestations and are not audited.
	activeFrom uint64
	startHead  uint64
	halted     error
	jobs       map[uint64]*job
	watchLeft  int
}

type job struct {
	status.Attestation
	sent     bool
	done     bool
	attempts int
	audited  bool
	watched  bool
}

func (e *Engine) defaults() {
	if e.Now == nil {
		e.Now = time.Now
	}
	if e.Poll == 0 {
		e.Poll = 2 * time.Second
	}
	if e.BlockSeconds == 0 {
		e.BlockSeconds = 7
	}
	if e.Log == nil {
		e.Log = logx.Discard()
	}
	if e.jobs == nil {
		e.jobs = map[uint64]*job{}
	}
	e.scope = protect.Scope{ChainID: e.Domain.ChainID, Hub: e.Domain.Hub, Attester: e.Addr}
}

// Preflight runs the startup checks. An error means: do not start signing;
// IsFatal(err) means retrying will not help.
func (e *Engine) Preflight(ctx context.Context) error {
	e.defaults()
	if err := e.Sched.Validate(); err != nil {
		return Fatal(err)
	}
	if e.Key == nil || crypto.PubkeyToAddress(e.Key.PublicKey) != e.Addr {
		return Fatal(errors.New("attester key and address disagree"))
	}
	id, err := e.Chain.ChainID(ctx)
	if err != nil {
		return fmt.Errorf("node unreachable: %w", err)
	}
	if id != e.Domain.ChainID {
		return Fatal(fmt.Errorf("the node is on chain %d but this validator is configured for chain %d", id, e.Domain.ChainID))
	}
	code, err := e.Chain.CodeAt(ctx, e.Domain.Hub)
	if err != nil {
		return err
	}
	if len(code) == 0 {
		return fmt.Errorf("no contract at hub address %s on chain %d yet (is the node still syncing?)", e.Domain.Hub.Hex(), id)
	}
	sep, err := e.Hub.DomainSeparator(ctx)
	if err != nil {
		return fmt.Errorf("reading the hub's signing domain: %w", err)
	}
	if want := e.Domain.Separator(); sep != want {
		return Fatal(fmt.Errorf("the hub's signing domain %s differs from this build's %s: its attestations would be rejected; update fmx-validator", sep.Hex(), want.Hex()))
	}
	probe := crypto.Keccak256Hash([]byte("fmx-validator preflight"))
	if d, err := e.Hub.AttestationDigest(ctx, e.Sched.Interval, probe); err != nil {
		return fmt.Errorf("reading the hub's attestation digest: %w", err)
	} else if d != e.Domain.Digest(e.Sched.Interval, probe) {
		return Fatal(errors.New("the hub computes attestation digests differently from this build: update fmx-validator"))
	}
	head, err := e.Chain.Head(ctx)
	if err != nil {
		return err
	}
	e.startHead = head.Number
	if n := e.DB.Repaired(); n > 0 {
		e.Log.Warn("the slashing protection database had a torn last record (a crash while saving); nothing at or below the current head will be signed", "bytes", n, "head", head.Number)
		if err := e.DB.SetWatermark(e.scope, head.Number); err != nil {
			return err
		}
		if err := e.DB.RepairHandled(); err != nil {
			return err
		}
	}
	if err := e.checkHistory(ctx, head.Number); err != nil {
		return err
	}
	e.Status.Update(func(s *status.Snapshot) { s.WatchLeft = e.watchLeft })
	e.Log.Info("preflight passed", "chain", id, "hub", e.Domain.Hub, "attester", e.Addr, "seat", e.seatID, "watch", e.watchLeft)
	return nil
}

// checkHistory compares the seat's on-chain attestations with this machine's
// protection database before anything is signed.
func (e *Engine) checkHistory(ctx context.Context, head uint64) error {
	k, err := e.Hub.KeyInfo(ctx, e.Addr)
	if err != nil {
		return err
	}
	_, maxLocal, haveLocal := e.localRange()
	if k.IsAttester() {
		e.seatID = k.SeatID
		seat, err := e.Hub.Seat(ctx, k.SeatID, head)
		if err != nil {
			return err
		}
		if last := seat.LastAttestedHeight; last > 0 && seat.Attester == e.Addr {
			local, ok := e.DB.Lookup(e.scope, last)
			cp, err := e.Hub.Checkpoint(ctx, last)
			if err != nil {
				return err
			}
			if ok && local != cp.BlockHash {
				return Fatal(fmt.Errorf("%w: at height %d the chain holds %s, this machine signed %s", ErrKeyInUse, last, cp.BlockHash.Hex(), local.Hex()))
			}
			if !ok {
				// Could this key have made it? Not if it became the attester
				// through a rotation after that checkpoint's window closed.
				since, rotated, err := e.Hub.AttesterSince(ctx, e.seatID, e.Addr)
				if err != nil {
					return err
				}
				if !rotated || last+e.Sched.MaxDelay >= since {
					if !e.Adopt {
						return Fatal(fmt.Errorf("%w (seat %d attested height %d; %s has no record of it, its latest is %d). Stop the other machine. If it is gone for good, bring its database here with `fmx-validator protection import`, or set adoptOnChainHistory in config.json", ErrKeyInUse, e.seatID, last, e.DB.Path(), maxLocal))
					}
					e.Log.Warn("adopting on-chain attestation history made elsewhere", "height", last, "seat", e.seatID)
					if _, err := e.DB.Import([]protect.ExportRecord{{ChainID: e.scope.ChainID, Hub: e.scope.Hub, Attester: e.Addr, Height: last, BlockHash: cp.BlockHash}}); err != nil {
						return err
					}
					if err := e.DB.SetWatermark(e.scope, head); err != nil {
						return err
					}
					e.watchLeft = e.DoppelgangerCheckpoints
				}
			}
		}
	}
	if e.Imported && !haveLocal {
		// A key brought from elsewhere: whatever it signed there at or below
		// the head is unknown here, so none of it is re-signed, and signing
		// starts only after watching for another user of the key.
		if err := e.DB.SetWatermark(e.scope, head); err != nil {
			return err
		}
		if e.watchLeft < e.DoppelgangerCheckpoints {
			e.watchLeft = e.DoppelgangerCheckpoints
		}
	}
	return nil
}

func (e *Engine) localRange() (min, max uint64, ok bool) {
	recs := e.DB.Records(e.scope)
	if len(recs) == 0 {
		return 0, 0, false
	}
	return recs[len(recs)-1].Height, recs[0].Height, true
}

// Run ticks until ctx ends.
func (e *Engine) Run(ctx context.Context) error {
	t := time.NewTicker(e.Poll)
	defer t.Stop()
	for {
		e.Tick(ctx)
		select {
		case <-ctx.Done():
			return nil
		case <-t.C:
		}
	}
}

// Halted returns the reason signing stopped, if it did.
func (e *Engine) Halted() error { return e.halted }

func (e *Engine) halt(err error) {
	if e.halted != nil {
		return
	}
	e.halted = err
	e.Log.Error("SIGNING STOPPED", "reason", err)
	e.Status.Update(func(s *status.Snapshot) { s.Halted = err.Error() })
	if e.OnHalt != nil {
		e.OnHalt(err)
	}
}

// Tick runs one iteration. Node and hub errors are recorded, never fatal.
func (e *Engine) Tick(ctx context.Context) {
	e.defaults()
	now := e.Now()
	r := node.Check(ctx, e.Chain, e.Policy, now)
	e.Status.Update(func(s *status.Snapshot) { s.Sync = r })
	if r.Head == 0 {
		return
	}
	head := r.Head
	e.refresh(ctx, now, head)
	e.track(ctx, head)
	if h, ok := e.Sched.Due(head); ok {
		e.handle(ctx, h, r)
	}
	next, opens := e.Sched.Next(head)
	e.Status.Update(func(s *status.Snapshot) { s.NextCheckpoint, s.NextOpensAt, s.WatchLeft = next, opens, e.watchLeft })
}

// refresh re-reads the seat, the pool and the gas balance every 30 s.
func (e *Engine) refresh(ctx context.Context, now time.Time, head uint64) {
	if e.seat != nil && now.Sub(e.seatChecked) < 30*time.Second {
		return
	}
	e.seatChecked = now
	fail := func(err error) { e.Status.Update(func(s *status.Snapshot) { s.SeatError = err.Error() }) }
	k, err := e.Hub.KeyInfo(ctx, e.Addr)
	if err != nil {
		fail(err)
		return
	}
	if !k.IsAttester() {
		e.seatID, e.seat = 0, nil
		e.Status.Update(func(s *status.Snapshot) {
			s.Seat = nil
			s.SeatError = "no seat uses this attester key yet: open a seat from the owner wallet with " + e.Addr.Hex() + " as its attester (`fmx-validator seat-proof` prints what the wallet needs)"
		})
		return
	}
	if e.seatID != k.SeatID {
		e.Log.Info("seat found for attester", "seat", k.SeatID)
	}
	e.seatID = k.SeatID
	seat, err := e.Hub.Seat(ctx, e.seatID, head)
	if err != nil {
		fail(err)
		return
	}
	pool, err := e.Hub.Pool(ctx)
	if err != nil {
		fail(err)
		return
	}
	e.seat, e.pool = &seat, &pool
	note := ""
	switch {
	case seat.Attester != e.Addr && seat.PendingAttester == e.Addr:
		note = fmt.Sprintf("this key replaces the seat's attester from block %d (after applyAttesterRotation)", seat.AttesterRotateBlock)
	case seat.Attester != e.Addr:
		note = "the seat names another attester key; this key no longer attests for it"
	case k.Active && e.activeFrom == 0:
		e.activeFrom = head
	}
	if seat.Owner == e.Addr {
		e.Log.Warn("the seat owner and the attester are the same key; keep the owner key off this machine")
	}
	var day, week status.Participation
	if n, err := e.Hub.Participation(ctx, e.seatID, 62); err == nil {
		day = status.Participation{Window: 62, Included: int(n)}
	}
	if n, err := e.Hub.Participation(ctx, e.seatID, 432); err == nil {
		week = status.Participation{Window: 432, Included: int(n)}
	}
	bal, _ := e.Chain.Balance(ctx, e.Addr)
	e.Status.Update(func(s *status.Snapshot) {
		s.Seat, s.SeatError = &seat, note
		s.Rewards = status.Rewards{
			RewardPerAttest: pool.RewardPerAttest,
			ExpectedPerDay:  hub.ExpectedPerDay(pool.RewardPerAttest, e.BlockSeconds, e.Sched.Interval),
			RewardPool:      pool.RewardPool,
			PoolEmpty:       pool.RewardPool == nil || pool.RewardPerAttest == nil || pool.RewardPool.Cmp(pool.RewardPerAttest) < 0,
			OccupiedSeats:   pool.OccupiedSeats,
			EligibleSeats:   pool.EligibleSeats,
			MaxSeats:        pool.MaxSeats,
			Claimable:       seat.Claimable,
		}
		s.Paused = pool.Paused
		s.Day, s.Week = day, week
		if bal != nil {
			s.Gas = status.Gas{Balance: bal, Low: bal.Cmp(LowGasBalance) < 0}
		}
	})
}

// canSign reports whether this key is the seat's active attester right now.
func (e *Engine) canSign() (bool, string) {
	switch {
	case e.seatID == 0 || e.seat == nil:
		return false, "no seat for this attester key"
	case e.seat.Attester != e.Addr:
		return false, "the seat's attester is " + e.seat.Attester.Hex()
	case e.seat.Status != hub.StatusActive:
		if e.seat.Status == hub.StatusPending {
			return false, fmt.Sprintf("seat activates at block %d", e.seat.ActivationBlock)
		}
		if e.seat.Status == hub.StatusJailed {
			return false, fmt.Sprintf("seat is paused for low participation; the owner can unjail it from block %d", e.seat.UnjailBlock)
		}
		return false, "seat is " + e.seat.Status.String()
	case e.pool != nil && e.pool.Paused:
		return false, "attestations are paused at the hub"
	}
	return true, ""
}

// auditable reports whether an attestation at h can only have come from this key.
func (e *Engine) auditable(h uint64) bool {
	return e.seatID != 0 && e.seat != nil && e.seat.Attester == e.Addr && e.activeFrom != 0 && h+e.Sched.MinDelay >= e.activeFrom
}

func (e *Engine) put(j *job, state, reason string) {
	if state != j.State || reason != j.Reason {
		switch state {
		case status.StateWaiting, status.StateWatching, status.StateSkipped:
			e.Log.Info("checkpoint "+state, "height", j.Height, "reason", reason)
		case status.StateMissed, status.StateRefused:
			e.Log.Warn("checkpoint "+state, "height", j.Height, "reason", reason)
		}
	}
	j.State, j.Reason, j.Updated = state, reason, e.Now()
	e.Status.Put(j.Attestation)
}

// handle works on the checkpoint that is due at this head.
func (e *Engine) handle(ctx context.Context, h uint64, r node.Readiness) {
	j := e.jobs[h]
	if j == nil {
		j = &job{Attestation: status.Attestation{Height: h}}
		e.jobs[h] = j
	}
	if j.done || j.sent {
		return
	}
	if e.halted != nil {
		j.done = true
		e.put(j, status.StateRefused, e.halted.Error())
		return
	}
	if e.watchLeft > 0 {
		// only windows watched from their opening count
		if !j.watched && h+e.Sched.MinDelay >= e.startHead {
			j.watched = true
			e.put(j, status.StateWatching, fmt.Sprintf("checking that no other machine uses this key (%d checkpoint(s) left)", e.watchLeft))
		} else if !j.watched && j.State == "" {
			e.put(j, status.StateWatching, "window opened before this sidecar started; not counted")
		}
		return
	}
	if !r.Ready {
		e.put(j, status.StateWaiting, "node not ready: "+strings.Join(r.Reasons, "; "))
		return
	}
	if ok, why := e.canSign(); !ok {
		e.put(j, status.StateWaiting, why)
		return
	}
	hdr, err := e.Chain.HeaderAt(ctx, h)
	if err != nil {
		e.put(j, status.StateWaiting, "reading block: "+err.Error())
		return
	}
	if hdr.Hash == (common.Hash{}) {
		e.put(j, status.StateWaiting, "node returned an empty block hash")
		return
	}
	// on-chain self check: an attestation already recorded for this seat and
	// height must be this machine's
	done, err := e.Hub.Attested(ctx, e.seatID, h)
	if err != nil {
		e.put(j, status.StateWaiting, "reading hub: "+err.Error())
		return
	}
	if done {
		local, ok := e.DB.Lookup(e.scope, h)
		if ok && local == hdr.Hash {
			j.done, j.BlockHash = true, hdr.Hash
			e.put(j, status.StateIncluded, "already on-chain")
			return
		}
		if !ok {
			// The seat's previous attester key keeps attesting until the
			// rotation is applied, so it may already have attested this
			// checkpoint when this key took over.
			since, rotated, err := e.Hub.AttesterSince(ctx, e.seatID, e.Addr)
			if err != nil {
				e.put(j, status.StateWaiting, "reading hub: "+err.Error())
				return
			}
			if rotated && since > h+e.Sched.MinDelay {
				j.done = true
				e.put(j, status.StateSkipped, fmt.Sprintf("attested by the seat's previous attester key (this key took over at block %d)", since))
				return
			}
		}
		j.done = true
		e.halt(fmt.Errorf("%w (height %d)", ErrKeyInUse, h))
		e.put(j, status.StateRefused, e.halted.Error())
		return
	}
	// durable record BEFORE the signature exists
	if _, err := e.DB.Approve(e.scope, h, hdr.Hash); err != nil {
		switch {
		case errors.Is(err, protect.ErrConflict):
			j.done = true
			e.halt(fmt.Errorf("the node now reports a different block at a height this key already signed; its history was rewritten deeper than 64 blocks or its data is damaged: %w", err))
			e.put(j, status.StateRefused, e.halted.Error())
		case errors.Is(err, protect.ErrBelowWatermark):
			j.done = true
			e.put(j, status.StateSkipped, "at or below the slashing-protection watermark")
		default:
			e.put(j, status.StateWaiting, err.Error())
		}
		return
	}
	j.BlockHash = hdr.Hash
	sig, err := e.Domain.Sign(e.Key, h, hdr.Hash)
	if err != nil {
		e.put(j, status.StateWaiting, "signing: "+err.Error())
		return
	}
	if got, err := e.Domain.Recover(h, hdr.Hash, sig); err != nil || got != e.Addr {
		j.done = true
		e.halt(errors.New("a fresh signature does not verify against the attester address; refusing to continue"))
		e.put(j, status.StateRefused, e.halted.Error())
		return
	}
	data, err := hub.PackAttest(h, hdr.Hash, sig)
	if err != nil {
		e.put(j, status.StateWaiting, err.Error())
		return
	}
	tx, err := e.Sub.Submit(ctx, h, data)
	if err != nil {
		j.attempts++
		e.Log.Warn("attestation not submitted", "height", h, "attempt", j.attempts, "err", err)
		if j.attempts >= 5 {
			j.done = true
			e.put(j, status.StateMissed, err.Error())
			return
		}
		e.put(j, status.StateWaiting, err.Error())
		return
	}
	j.sent, j.Tx = true, tx
	e.Log.Info("attestation submitted", "height", h, "hash", hdr.Hash, "tx", tx)
	e.put(j, status.StateSubmitted, "")
}

// track follows submitted transactions, closes jobs whose window ended, and
// audits every closed checkpoint for attestations this machine did not make.
func (e *Engine) track(ctx context.Context, head uint64) {
	heights := make([]uint64, 0, len(e.jobs))
	for h := range e.jobs {
		heights = append(heights, h)
	}
	sort.Slice(heights, func(i, k int) bool { return heights[i] < heights[k] })
	for _, h := range heights {
		j := e.jobs[h]
		closed := e.Sched.Closed(h, head)
		if j.sent && !j.done {
			found, block, ok, err := e.Sub.Receipt(ctx, j.Tx)
			switch {
			case err != nil:
			case found && ok:
				j.done, j.IncludedIn = true, block
				e.Log.Info("attestation included", "height", h, "block", block)
				e.put(j, status.StateIncluded, "")
			case found && !ok:
				j.done, j.IncludedIn = true, block
				e.Log.Warn("attestation transaction reverted", "height", h, "tx", j.Tx)
				e.put(j, status.StateReverted, "the hub reverted the transaction")
			case closed:
				j.done = true
				e.put(j, status.StateMissed, "not included before the window closed")
			}
		} else if !j.done && closed {
			j.done = true
			if j.watched {
				e.put(j, status.StateWatching, "not signed: watching for another user of this key")
			} else {
				reason := j.Reason
				if reason == "" {
					reason = "window closed"
				}
				e.put(j, status.StateMissed, reason)
			}
		}
		if j.done && !j.audited && closed {
			e.audit(ctx, j)
		}
		if head > h+10*e.Sched.Interval && j.done && j.audited {
			delete(e.jobs, h)
		}
	}
	// checkpoints that closed while no job existed (no seat yet, or the
	// sidecar started inside the window) are audited too
	if e.seatID == 0 || head <= e.Sched.MaxDelay {
		return
	}
	last := (head - e.Sched.MaxDelay - 1) / e.Sched.Interval * e.Sched.Interval
	for i := uint64(0); i < 2 && last >= i*e.Sched.Interval; i++ {
		h := last - i*e.Sched.Interval
		if h == 0 || e.jobs[h] != nil || !e.Sched.Closed(h, head) || h+e.Sched.MaxDelay < e.startHead {
			continue
		}
		j := &job{Attestation: status.Attestation{Height: h}, done: true}
		e.jobs[h] = j
		e.audit(ctx, j)
	}
}

// audit checks a closed checkpoint on-chain: an attestation by this seat that
// this machine did not sign means the key is in use elsewhere.
func (e *Engine) audit(ctx context.Context, j *job) {
	if !e.auditable(j.Height) {
		j.audited = true
		if j.watched && e.watchLeft > 0 && (e.seat == nil || e.seat.Status != hub.StatusActive || e.seat.Attester != e.Addr) {
			// nobody can attest with this key for a missing or inactive seat
			e.watchLeft--
		}
		return
	}
	on, err := e.Hub.Attested(ctx, e.seatID, j.Height)
	if err != nil {
		return // retried next tick
	}
	j.audited = true
	if !on {
		if j.watched && e.watchLeft > 0 {
			e.watchLeft--
			e.Log.Info("clean checkpoint while watching for another user of this key", "height", j.Height, "left", e.watchLeft)
		}
		return
	}
	if local, ok := e.DB.Lookup(e.scope, j.Height); ok {
		// the hub only accepts blockhash(h), so the seat's attestation is for
		// the checkpoint's hash; if this machine signed another one, the
		// attestation on-chain was signed elsewhere with this key
		cp, err := e.Hub.Checkpoint(ctx, j.Height)
		if err != nil {
			j.audited = false // retried next tick
			return
		}
		if cp.BlockHash != (common.Hash{}) && cp.BlockHash != local {
			e.halt(fmt.Errorf("%w (height %d: the chain holds %s, this machine signed %s)", ErrKeyInUse, j.Height, cp.BlockHash.Hex(), local.Hex()))
			return
		}
		if j.State != status.StateIncluded {
			j.BlockHash = local
			e.put(j, status.StateIncluded, "")
		}
		return
	}
	e.halt(fmt.Errorf("%w (height %d)", ErrKeyInUse, j.Height))
}
