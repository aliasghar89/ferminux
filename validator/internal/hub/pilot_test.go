package hub

import (
	"context"
	"errors"
	"math/big"
	"strings"
	"testing"

	ferminux "github.com/aliasghar89/ferminux/chain"
	"github.com/aliasghar89/ferminux/chain/common"
	"github.com/aliasghar89/ferminux/chain/core/types"
)

// pilotHub answers the seat-access views; oldHub=true reverts allowlistOnly and
// allowlisted the way a hub built before the pilot does.
type pilotHub struct {
	inviteOnly, invited, denied, paused, oldHub bool
	occupied, max                               int64
}

func (pilotHub) FilterLogs(context.Context, ferminux.FilterQuery) ([]types.Log, error) {
	return nil, nil
}

func (h pilotHub) CallContract(_ context.Context, msg ferminux.CallMsg, _ *big.Int) ([]byte, error) {
	m, err := ABI.MethodById(msg.Data[:4])
	if err != nil {
		return nil, err
	}
	switch m.Name {
	case "allowlistOnly":
		if h.oldHub {
			return nil, errors.New("execution reverted")
		}
		return m.Outputs.Pack(h.inviteOnly)
	case "allowlisted":
		if h.oldHub {
			return nil, errors.New("execution reverted")
		}
		return m.Outputs.Pack(h.invited)
	case "denied":
		return m.Outputs.Pack(h.denied)
	case "seatsPaused":
		return m.Outputs.Pack(h.paused)
	case "attestationsPaused":
		return m.Outputs.Pack(false)
	case "occupiedSeats":
		return m.Outputs.Pack(big.NewInt(h.occupied))
	case "maxSeats":
		return m.Outputs.Pack(big.NewInt(h.max))
	case "eligibleCount":
		return m.Outputs.Pack(big.NewInt(0))
	case "currentRewardPerAttest":
		return m.Outputs.Pack(big.NewInt(25e15))
	case "rewardPool":
		return m.Outputs.Pack(big.NewInt(0))
	}
	return nil, errors.New("unexpected call " + m.Name)
}

func TestABISurface_Pilot(t *testing.T) {
	want := map[string]string{
		"allowlistOnly": "allowlistOnly()",
		"allowlisted":   "allowlisted(address)",
		"denied":        "denied(address)",
		"seatsPaused":   "seatsPaused()",
	}
	for name, sig := range want {
		m, ok := ABI.Methods[name]
		if !ok || m.Sig != sig {
			t.Fatalf("abi.json lacks %s", sig)
		}
	}
	for _, e := range []string{"NotAllowlisted", "SeatsFull", "Denied"} {
		if _, ok := ABI.Errors[e]; !ok {
			t.Fatalf("abi.json lacks error %s", e)
		}
	}
}

func TestSeatAccess_OrderMatchesOpenSeat(t *testing.T) {
	owner := common.HexToAddress("0x00000000000000000000000000000000000A11CE")
	cases := []struct {
		name string
		h    pilotHub
		want string
		text string
	}{
		{"invited, room", pilotHub{inviteOnly: true, invited: true, occupied: 3, max: 20}, "", "is invited to the pilot; 3 of 20 seats are taken"},
		{"not invited", pilotHub{inviteOnly: true, occupied: 3, max: 20}, "not-invited", "(NotAllowlisted)"},
		{"not invited and full", pilotHub{inviteOnly: true, occupied: 20, max: 20}, "not-invited", "not invited"},
		{"invited but full", pilotHub{inviteOnly: true, invited: true, occupied: 20, max: 20}, "full", "(SeatsFull)"},
		{"denied beats invited", pilotHub{inviteOnly: true, invited: true, denied: true, max: 20}, "denied", "(Denied)"},
		{"paused first", pilotHub{inviteOnly: true, invited: true, denied: true, paused: true, max: 20}, "paused", "(Paused)"},
		{"open to all", pilotHub{occupied: 5, max: 100}, "", "5 of 100 seats are taken; this wallet can open one"},
		{"hub before the pilot", pilotHub{oldHub: true, occupied: 1, max: 100}, "", "this wallet can open one"},
	}
	for _, c := range cases {
		a, err := New(common.Address{1}, c.h).SeatAccess(context.Background(), owner)
		if err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		if a.Reason != c.want {
			t.Fatalf("%s: reason %q, want %q", c.name, a.Reason, c.want)
		}
		if got := a.Explain(owner); !strings.Contains(got, c.text) {
			t.Fatalf("%s: %q lacks %q", c.name, got, c.text)
		}
	}
}

func TestPool_InviteOnly(t *testing.T) {
	p, err := New(common.Address{1}, pilotHub{inviteOnly: true, occupied: 2, max: 20}).Pool(context.Background())
	if err != nil || !p.InviteOnly || p.MaxSeats != 20 || p.OccupiedSeats != 2 {
		t.Fatalf("%+v %v", p, err)
	}
	// a hub built before the pilot has no allowlistOnly: the pool still reads, as open
	p, err = New(common.Address{1}, pilotHub{oldHub: true, max: 100}).Pool(context.Background())
	if err != nil || p.InviteOnly || p.MaxSeats != 100 {
		t.Fatalf("%+v %v", p, err)
	}
}

func TestDecodeRevert_SeatErrors(t *testing.T) {
	id := ABI.Errors["NotAllowlisted"].ID
	if got := DecodeRevert(id[:4]); !strings.HasPrefix(got, "NotAllowlisted (") || !strings.Contains(got, "invite-only pilot") {
		t.Fatalf("%q", got)
	}
	id = ABI.Errors["SeatsFull"].ID
	if got := DecodeRevert(id[:4]); !strings.Contains(got, "every seat is taken") {
		t.Fatalf("%q", got)
	}
}
