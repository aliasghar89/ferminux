package scheduler

import (
	"strings"
	"testing"

	"github.com/aliasghar89/ferminux/validator/internal/hub"
)

func TestNoSeatNote(t *testing.T) {
	if got := NoSeatNote(hub.Pool{MaxSeats: 100, OccupiedSeats: 3}); got != "" {
		t.Fatalf("an open hub with room needs no note, got %q", got)
	}
	got := NoSeatNote(hub.Pool{InviteOnly: true, MaxSeats: 20, OccupiedSeats: 4})
	if !strings.Contains(got, "invite-only pilot") || !strings.Contains(got, "NotAllowlisted") || strings.Contains(got, "taken") {
		t.Fatalf("%q", got)
	}
	got = NoSeatNote(hub.Pool{InviteOnly: true, MaxSeats: 20, OccupiedSeats: 20})
	if !strings.Contains(got, "All 20 seats are taken") {
		t.Fatalf("%q", got)
	}
}
