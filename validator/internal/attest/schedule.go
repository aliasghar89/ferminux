package attest

import "fmt"

// The Step 1 checkpoint rules (PLAN section 3.2). The hub enforces the same
// numbers: attest(h, hash, sig) only succeeds when h % 200 == 0, the including
// block is in [h+64, h+250] and blockhash(h) == hash.
const (
	// CheckpointInterval: every block height that is a multiple of 200 is a
	// checkpoint (about every 23 minutes at 7 s blocks).
	CheckpointInterval = 200
	// MinDelay is FerminuxMaxReorgDepth: the node refuses reorgs deeper than 64
	// blocks, so a hash read 64 blocks deep never changes under an honest seat.
	MinDelay = 64
	// MaxDelay keeps h inside the 256-block BLOCKHASH window.
	MaxDelay = 250
	// DefaultSubmitMargin is how many blocks before the window closes the
	// sidecar stops submitting, so a transaction sent late is not wasted gas.
	DefaultSubmitMargin = 10
)

// Schedule computes which checkpoint, if any, is due at a given head.
type Schedule struct {
	Interval     uint64
	MinDelay     uint64
	MaxDelay     uint64
	SubmitMargin uint64
}

// DefaultSchedule is the mainnet schedule.
func DefaultSchedule() Schedule {
	return Schedule{Interval: CheckpointInterval, MinDelay: MinDelay, MaxDelay: MaxDelay, SubmitMargin: DefaultSubmitMargin}
}

// Validate rejects schedules that could make the sidecar sign a hash that is
// not yet final on its node, or submit outside the hub's window.
func (s Schedule) Validate() error {
	switch {
	case s.Interval == 0:
		return fmt.Errorf("schedule: interval must be > 0")
	case s.MinDelay < MinDelay:
		return fmt.Errorf("schedule: min delay %d is below the node's reorg cap %d", s.MinDelay, MinDelay)
	case s.MaxDelay > 255:
		return fmt.Errorf("schedule: max delay %d leaves the 256-block blockhash window", s.MaxDelay)
	case s.MinDelay >= s.MaxDelay:
		return fmt.Errorf("schedule: min delay %d must be below max delay %d", s.MinDelay, s.MaxDelay)
	case s.MinDelay+1+s.SubmitMargin > s.MaxDelay:
		return fmt.Errorf("schedule: submit margin %d leaves no time to submit", s.SubmitMargin)
	}
	return nil
}

// IsCheckpoint reports whether h is a checkpoint height. Genesis is not.
func (s Schedule) IsCheckpoint(h uint64) bool { return h > 0 && h%s.Interval == 0 }

// Due returns the checkpoint that should be signed and submitted when the
// node's head is `head`: the checkpoint h with h+MinDelay <= head and whose
// next block (head+1, the earliest inclusion) is at least SubmitMargin blocks
// before h+MaxDelay. With interval 200 and a 186-block window at most one
// checkpoint is due at a time.
func (s Schedule) Due(head uint64) (uint64, bool) {
	if head < s.MinDelay {
		return 0, false
	}
	h := (head - s.MinDelay) / s.Interval * s.Interval
	if !s.IsCheckpoint(h) {
		return 0, false
	}
	if head+1+s.SubmitMargin > h+s.MaxDelay {
		return 0, false
	}
	return h, true
}

// Next returns the first checkpoint whose signing opens after head, and the
// head at which it opens.
func (s Schedule) Next(head uint64) (checkpoint, opensAt uint64) {
	h := head / s.Interval * s.Interval
	for {
		if s.IsCheckpoint(h) && h+s.MinDelay > head {
			return h, h + s.MinDelay
		}
		h += s.Interval
	}
}

// Includable reports whether a transaction included in block `block` is
// inside the hub's window for checkpoint h.
func (s Schedule) Includable(h, block uint64) bool {
	return block >= h+s.MinDelay && block <= h+s.MaxDelay
}

// Closed reports whether the window for h can no longer be met: the next
// block after head is already past h+MaxDelay.
func (s Schedule) Closed(h, head uint64) bool { return head+1 > h+s.MaxDelay }
