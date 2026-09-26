package status

import (
	"strings"
	"testing"
	"time"

	"github.com/aliasghar89/ferminux/validator/internal/hub"
	"github.com/aliasghar89/ferminux/validator/internal/node"
)

func TestPhase(t *testing.T) {
	now := time.Now()
	ready := node.Readiness{Ready: true, Checked: now, Head: 250_000, Peers: 7}
	seat := func(st hub.Status) *hub.Seat {
		return &hub.Seat{ID: 4, Status: st, ActivationBlock: 250_600, UnjailBlock: 262_343, UnbondEndBlock: 422_800, CountedSince: 1}
	}
	cases := []struct {
		name  string
		s     Snapshot
		state string
		tone  string
		has   string
	}{
		{"fresh", Snapshot{}, PhaseStarting, ToneWait, "Connecting"},
		{"hub not published, node syncing", Snapshot{Setup: []string{"the ValidatorHub address is not configured yet"},
			Sync: node.Readiness{Checked: now, Syncing: true, Head: 1_000, SyncTarget: 400_000, Peers: 3}},
			PhaseSetup, ToneWait, "syncing: 1,000 of 400,000 (0%)"},
		{"syncing", Snapshot{Sync: node.Readiness{Checked: now, Syncing: true, Head: 200_000, SyncTarget: 400_000, Peers: 4}},
			PhaseSyncing, ToneWait, "200,000 of 400,000 (50%)"},
		{"halt beats everything", Snapshot{Halted: "key in use elsewhere", Setup: []string{"x"}, Sync: ready, Seat: seat(hub.StatusActive)},
			PhaseStopped, ToneBad, "resume --yes"},
		{"node process down", Snapshot{Node: NodeProc{Supervised: true, LastExit: "exit status 1", Restarts: 3}, Setup: []string{"no key"}},
			PhaseNodeDown, ToneBad, "exit status 1"},
		{"not ready", Snapshot{Sync: node.Readiness{Checked: now, Head: 9, Reasons: []string{"1 peers (need 3)"}}},
			PhaseNotReady, ToneWait, "1 peers (need 3)"},
		{"hub paused", Snapshot{Sync: ready, Paused: true}, PhaseHubPaused, ToneWait, "paused"},
		{"no seat", Snapshot{Sync: ready, SeatError: "no seat uses this attester key yet"}, PhaseNoSeat, ToneWait, "no seat uses"},
		{"activating", Snapshot{Sync: ready, Seat: seat(hub.StatusPending)}, PhaseActivating, ToneWait, "block 250,600 (in about 70 min)"},
		{"jailed", Snapshot{Sync: ready, Seat: seat(hub.StatusJailed)}, PhaseJailed, ToneBad, "from block 262,343 (in about 24 h)"},
		{"unbonding", Snapshot{Sync: ready, Seat: seat(hub.StatusExiting)}, PhaseUnbonding, ToneWait, "block 422,800 (in about 14 days)"},
		{"closed", Snapshot{Sync: ready, Seat: seat(hub.StatusClosed)}, PhaseClosed, ToneWait, "withdrawn"},
		{"watching", Snapshot{Sync: ready, Seat: seat(hub.StatusActive), WatchLeft: 2}, PhaseWatching, ToneWait, "2 checkpoint(s)"},
		{"attesting", Snapshot{Sync: ready, Seat: seat(hub.StatusActive), Attestations: []Attestation{{Height: 249_800, State: StateIncluded}}},
			PhaseAttesting, ToneOK, "249,800"},
		{"attesting, low gas", Snapshot{Sync: ready, Seat: seat(hub.StatusActive), Gas: Gas{Low: true}, Rewards: Rewards{PoolEmpty: true}},
			PhaseAttesting, ToneWait, "reward pool is empty"},
	}
	for _, c := range cases {
		p := c.s.CurrentPhase()
		if p.State != c.state || p.Tone != c.tone || !strings.Contains(p.Title+" "+p.Detail, c.has) {
			t.Errorf("%s: got %+v, want state %s tone %s containing %q", c.name, p, c.state, c.tone, c.has)
		}
	}
	// the tracker fills it in
	tr := NewTracker(Snapshot{Halted: "x"})
	if tr.Snapshot().Phase.State != PhaseStopped {
		t.Fatal("tracker snapshot has no phase")
	}
}
