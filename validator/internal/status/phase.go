package status

import (
	"fmt"
	"math/big"
	"strings"
	"time"

	"github.com/aliasghar89/ferminux/validator/internal/hub"
)

// Phase states, in the order they are decided: the first that applies wins.
const (
	PhaseStopped    = "stopped"    // a safety stop: nothing is signed until resume
	PhaseNodeDown   = "node-down"  // the supervised node process is not running
	PhaseSetup      = "setup"      // something must be done on this machine first
	PhaseStarting   = "starting"   // no word from the node yet
	PhaseSyncing    = "syncing"    // the node is catching up with the chain
	PhaseNotReady   = "not-ready"  // in sync, but a signing check fails (peers, head age …)
	PhaseHubPaused  = "hub-paused" // the hub has attestations paused
	PhaseNoSeat     = "no-seat"    // ready, but no seat uses this attester key
	PhaseActivating = "activating" // seat opened, activation block not reached
	PhaseJailed     = "jailed"     // seat paused for low participation
	PhaseUnbonding  = "unbonding"  // exit requested, deposit locked until the unbond ends
	PhaseClosed     = "closed"     // deposit withdrawn
	PhaseWatching   = "watching"   // new or imported key: checking no other machine uses it
	PhaseAttesting  = "attesting"  // signing every checkpoint
)

// Tones for the dashboard.
const (
	ToneOK   = "ok"
	ToneWait = "wait"
	ToneBad  = "bad"
)

// Phase is the one answer to "what is this validator doing right now?",
// shared by the dashboard and `fmx-validator status`.
type Phase struct {
	State  string `json:"state"`
	Tone   string `json:"tone"`
	Title  string `json:"title"`
	Detail string `json:"detail,omitempty"`
}

// blockTime is the chain's block interval, for rough "in about" estimates.
const blockTime = 7 * time.Second

// CurrentPhase works out the phase from the snapshot.
func (s Snapshot) CurrentPhase() Phase {
	y := s.Sync
	nodeLine := ""
	switch {
	case y.Checked.IsZero():
	case y.Head > 0 && y.Syncing:
		nodeLine = "The node is syncing: " + syncText(y.Head, y.SyncTarget) + "."
	case y.Head > 0:
		nodeLine = fmt.Sprintf("The node is at block %s with %d peer(s).", group(y.Head), y.Peers)
	default:
		nodeLine = "The node is not answering yet."
	}
	switch {
	case s.Halted != "":
		return Phase{PhaseStopped, ToneBad, "Signing stopped for safety",
			sentence(s.Halted) + " Nothing is signed until the cause is dealt with and `fmx-validator resume --yes` is run, then the service restarted."}
	case s.Node.Supervised && !s.Node.Running:
		d := "The sidecar starts it again by itself."
		if s.Node.LastExit != "" {
			d = fmt.Sprintf("It stopped (%s) and has been restarted %d time(s); the sidecar keeps trying. The node's own log is logs/node.log.", s.Node.LastExit, s.Node.Restarts)
		}
		return Phase{PhaseNodeDown, ToneBad, "The node is not running", d}
	case len(s.Setup) > 0:
		return Phase{PhaseSetup, ToneWait, "Setup needed", join(sentence(strings.Join(s.Setup, "; ")), nodeLine)}
	case y.Checked.IsZero():
		return Phase{PhaseStarting, ToneWait, "Starting", "Connecting to the node."}
	case y.Syncing:
		return Phase{PhaseSyncing, ToneWait, "Syncing the chain", "Block " + syncText(y.Head, y.SyncTarget) + fmt.Sprintf(", %d peer(s). Signing starts once the node has caught up.", y.Peers)}
	case !y.Ready:
		return Phase{PhaseNotReady, ToneWait, "Not signing: the node is not ready", sentence(strings.Join(y.Reasons, "; "))}
	case s.Paused:
		return Phase{PhaseHubPaused, ToneWait, "Attestations are paused at the hub", "The hub is not accepting attestations right now. Nothing needs doing on this machine; it signs again once they resume."}
	case s.Seat == nil:
		d := s.SeatError
		if d == "" {
			d = "Open a seat from the owner wallet; `fmx-validator seat-proof --owner <wallet>` prints what the wallet needs."
		}
		return Phase{PhaseNoSeat, ToneWait, "Node ready, no seat yet", d}
	}
	seat := *s.Seat
	switch seat.Status {
	case hub.StatusPending:
		return Phase{PhaseActivating, ToneWait, "Waiting to activate", "The seat activates at block " + group(seat.ActivationBlock) + eta(y.Head, seat.ActivationBlock) + "."}
	case hub.StatusJailed:
		d := "The seat attested too few recent checkpoints and earns nothing while paused. No deposit is lost for downtime."
		if seat.UnjailBlock > 0 {
			d = "The owner wallet can resume it (unjail) from block " + group(seat.UnjailBlock) + eta(y.Head, seat.UnjailBlock) + ". " + d
		}
		return Phase{PhaseJailed, ToneBad, "Paused for low participation", d}
	case hub.StatusExiting:
		return Phase{PhaseUnbonding, ToneWait, "Unbonding", "The deposit can be withdrawn by the owner wallet from block " + group(seat.UnbondEndBlock) + eta(y.Head, seat.UnbondEndBlock) + ". Nothing is signed meanwhile."}
	case hub.StatusClosed:
		return Phase{PhaseClosed, ToneWait, "Seat closed", "The deposit was withdrawn. This machine signs nothing for it any more."}
	case hub.StatusNone:
		return Phase{PhaseNoSeat, ToneWait, "Node ready, no seat yet", s.SeatError}
	}
	if s.WatchLeft > 0 {
		return Phase{PhaseWatching, ToneWait, "Checking that no other machine uses this key", fmt.Sprintf("%d checkpoint(s) left before signing starts.", s.WatchLeft)}
	}
	p := Phase{State: PhaseAttesting, Tone: ToneOK, Title: "Attesting"}
	var parts []string
	for _, a := range s.Attestations {
		if a.State == StateIncluded {
			parts = append(parts, "Last included checkpoint: "+group(a.Height)+".")
			break
		}
	}
	if len(parts) == 0 {
		parts = append(parts, "Waiting for the next checkpoint.")
	}
	if !seat.Eligible() {
		parts = append(parts, "Counts toward certification after 7 days active.")
	}
	if s.Rewards.PoolEmpty {
		parts = append(parts, "The reward pool is empty: attestations still count but earn nothing until it is refilled.")
	}
	if s.Gas.Low {
		p.Tone = ToneWait
		parts = append(parts, "The attester key is low on FMX for transaction fees.")
	}
	p.Detail = strings.Join(parts, " ")
	return p
}

// sentence capitalises the first letter and ends with a full stop.
func sentence(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return s
	}
	s = strings.ToUpper(s[:1]) + s[1:]
	if !strings.HasSuffix(s, ".") {
		s += "."
	}
	return s
}

func join(a, b string) string {
	if b == "" {
		return a
	}
	return a + " " + b
}

func syncText(head, target uint64) string {
	if target > head {
		return fmt.Sprintf("%s of %s (%d%%)", group(head), group(target), head*100/target)
	}
	return group(head)
}

// eta is " (in about …)" for a block ahead of head, or "" once reached.
func eta(head, block uint64) string {
	if head == 0 || block <= head {
		return ""
	}
	d := time.Duration(block-head) * blockTime
	switch {
	case d < 90*time.Minute:
		return fmt.Sprintf(" (in about %d min)", int(d.Minutes()+0.5))
	case d < 48*time.Hour:
		return fmt.Sprintf(" (in about %.0f h)", d.Hours())
	}
	return fmt.Sprintf(" (in about %.0f days)", d.Hours()/24)
}

// group writes 1234567 as 1,234,567.
func group(n uint64) string {
	s := new(big.Int).SetUint64(n).String()
	for i := len(s) - 3; i > 0; i -= 3 {
		s = s[:i] + "," + s[i:]
	}
	return s
}
