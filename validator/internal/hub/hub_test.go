package hub

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"math/big"
	"os"
	"testing"

	ferminux "github.com/aliasghar89/ferminux/chain"
	"github.com/aliasghar89/ferminux/chain/accounts/abi"
	"github.com/aliasghar89/ferminux/chain/common"
	"github.com/aliasghar89/ferminux/chain/core/types"
)

// The signatures the sidecar relies on, exactly as ValidatorHub declares them.
func TestABISurface(t *testing.T) {
	want := map[string]string{
		"domainSeparator":        "domainSeparator()",
		"attestationDigest":      "attestationDigest(uint64,bytes32)",
		"attesterKeyDigest":      "attesterKeyDigest(address,address)",
		"enodeDigest":            "enodeDigest(address,address)",
		"keyInfo":                "keyInfo(address)",
		"attested":               "attested(uint256,uint256)",
		"checkpoint":             "checkpoint(uint256)",
		"currentRewardPerAttest": "currentRewardPerAttest()",
		"participation":          "participation(uint256,uint256)",
		"extsload":               "extsload(bytes32[])",
		"attest":                 "attest(uint64,bytes32,bytes)",
		"openSeat":               "openSeat(address,bytes,bytes,bytes)",
	}
	for name, sig := range want {
		m, ok := ABI.Methods[name]
		if !ok {
			t.Fatalf("abi.json lacks %s", name)
		}
		if m.Sig != sig {
			t.Fatalf("%s is %s, want %s", name, m.Sig, sig)
		}
	}
	for _, e := range []string{"AttestationRejected", "OutsideWindow", "WrongBlockHash", "NotCheckpoint", "Paused"} {
		if _, ok := ABI.Errors[e]; !ok {
			t.Fatalf("abi.json lacks error %s", e)
		}
	}
}

func TestPackUnpackAttest(t *testing.T) {
	h := common.HexToHash("0x5b593f4a2adbf48effd4d8fa5a4761fbf4c77506140038de47904d5321f9bd10")
	sig := bytes.Repeat([]byte{7}, 65)
	data, err := PackAttest(400000, h, sig)
	if err != nil {
		t.Fatal(err)
	}
	gh, gb, gs, err := UnpackAttest(data)
	if err != nil || gh != 400000 || gb != h || !bytes.Equal(gs, sig) {
		t.Fatalf("round trip: %v", err)
	}
	if _, _, _, err := UnpackAttest([]byte{1, 2, 3, 4, 5}); err == nil {
		t.Fatal("garbage accepted")
	}
}

func word(fields ...[3]*big.Int) [32]byte { // {value, shift, _}
	x := new(big.Int)
	for _, f := range fields {
		x.Or(x, new(big.Int).Lsh(f[0], uint(f[1].Uint64())))
	}
	var w [32]byte
	x.FillBytes(w[:])
	return w
}

func f(v, shift int64) [3]*big.Int { return [3]*big.Int{big.NewInt(v), big.NewInt(shift), nil} }

func TestDecodeSeat(t *testing.T) {
	owner := common.HexToAddress("0x0000000000000000000000000000000000000F00")
	att := common.HexToAddress("0x67d4f97ff01895332b912a30535f139617140f3d")
	ownerW := new(big.Int).SetBytes(owner.Bytes())
	attW := new(big.Int).SetBytes(att.Bytes())
	dep := new(big.Int).Mul(big.NewInt(2000), big.NewInt(1e18))
	w := [][32]byte{
		word(f(25e15, 0), f(2001, 96), f(1990, 128), f(400000, 160), f(486400, 200), f(rawBonded, 240)),
		word([3]*big.Int{ownerW, big.NewInt(0), nil}),
		word([3]*big.Int{attW, big.NewInt(0), nil}, [3]*big.Int{dep, big.NewInt(160), nil}),
		{}, {}, {},
	}
	s := DecodeSeat(7, w, 400100)
	if s.Status != StatusActive || s.Owner != owner || s.Attester != att || s.Deposit.Cmp(dep) != 0 ||
		s.Claimable.Int64() != 25e15 || s.LastAttestedHeight != 400200 || s.ActivationBlock != 400000 || s.CountedSince != 486400 {
		t.Fatalf("%+v", s)
	}
	if DecodeSeat(7, w, 399999).Status != StatusPending {
		t.Fatal("before activation should be pending")
	}
	w[0] = word(f(0, 0), f(1, 248), f(rawBonded, 240), f(400000, 160))
	if DecodeSeat(7, w, 500000).Status != StatusJailed {
		t.Fatal("jailed")
	}
	w[0] = word(f(rawExiting, 240))
	if DecodeSeat(7, w, 500000).Status != StatusExiting {
		t.Fatal("exiting")
	}
}

func TestDecodeRevert(t *testing.T) {
	e := ABI.Errors["AttestationRejected"]
	data, _ := e.Inputs.Pack(big.NewInt(4))
	if got := DecodeRevert(append(e.ID[:4], data...)); got != "AttestationRejected(already attested)" {
		t.Fatalf("%q", got)
	}
	ow := ABI.Errors["OutsideWindow"].ID
	if got := DecodeRevert(ow[:4]); got != "OutsideWindow[]" && got != "OutsideWindow" {
		t.Fatalf("%q", got)
	}
}

func TestExpectedPerDay(t *testing.T) {
	r := new(big.Int).Div(big.NewInt(1e18), big.NewInt(40))
	got := ExpectedPerDay(r, 7, 200)
	want, _ := new(big.Int).SetString("1542857142857142857", 10)
	if got.Cmp(want) != 0 {
		t.Fatalf("got %s want %s", got, want)
	}
}

// fakeCaller answers keyInfo, checkpoint and deployBlock with ABI-encoded
// results, and returns the logs it holds.
type fakeCaller struct{ logs []types.Log }

func (f fakeCaller) FilterLogs(_ context.Context, q ferminux.FilterQuery) ([]types.Log, error) {
	var out []types.Log
	for _, l := range f.logs {
		if q.FromBlock != nil && l.BlockNumber < q.FromBlock.Uint64() {
			continue
		}
		match := true
		for i, want := range q.Topics {
			if len(want) == 0 {
				continue
			}
			if i >= len(l.Topics) || l.Topics[i] != want[0] {
				match = false
			}
		}
		if match {
			out = append(out, l)
		}
	}
	return out, nil
}

func (fakeCaller) CallContract(_ context.Context, msg ferminux.CallMsg, _ *big.Int) ([]byte, error) {
	m, _ := ABI.MethodById(msg.Data[:4])
	switch m.Name {
	case "deployBlock":
		return m.Outputs.Pack(big.NewInt(100))
	case "keyInfo":
		return m.Outputs.Pack(struct {
			SeatId uint64
			Role   uint8
			Active bool
		}{3, 1, true})
	case "checkpoint":
		return m.Outputs.Pack(struct {
			BlockHash     [32]byte
			Count         uint32
			Eligible      uint32
			Total         uint32
			SnapshotBlock *big.Int
			Certified     bool
		}{[32]byte{1}, 21, 30, 25, big.NewInt(400070), true})
	}
	return nil, nil
}

func TestTupleViews(t *testing.T) {
	b := New(common.Address{1}, fakeCaller{})
	k, err := b.KeyInfo(context.Background(), common.Address{2})
	if err != nil || k.SeatID != 3 || !k.IsAttester() || !k.Active {
		t.Fatalf("%+v %v", k, err)
	}
	c, err := b.Checkpoint(context.Background(), 400000)
	if err != nil || c.Count != 21 || !c.Certified || c.SnapshotBlock != 400070 || c.BlockHash[0] != 1 {
		t.Fatalf("%+v %v", c, err)
	}
}

func TestAttesterSince(t *testing.T) {
	key := common.HexToAddress("0x67d4f97ff01895332b912a30535f139617140f3d")
	ev := ABI.Events["AttesterRotated"].ID
	seat := common.BigToHash(big.NewInt(7))
	fc := fakeCaller{logs: []types.Log{
		{BlockNumber: 50, Topics: []common.Hash{ev, seat, {}, common.BytesToHash(key.Bytes())}},                             // before deploy: ignored
		{BlockNumber: 300, Topics: []common.Hash{ev, common.BigToHash(big.NewInt(8)), {}, common.BytesToHash(key.Bytes())}}, // other seat
		{BlockNumber: 400, Topics: []common.Hash{ev, seat, {}, common.BytesToHash(key.Bytes())}},
	}}
	b := New(common.Address{1}, fc)
	blk, rotated, err := b.AttesterSince(context.Background(), 7, key)
	if err != nil || !rotated || blk != 400 {
		t.Fatalf("%d %v %v", blk, rotated, err)
	}
	if _, rotated, _ := b.AttesterSince(context.Background(), 9, key); rotated {
		t.Fatal("rotation found for the wrong seat")
	}
}

// Seats are decoded from raw storage: the slot must match the hub build.
func TestSeatSlotMatchesHubBuild(t *testing.T) {
	b, err := os.ReadFile("../../testdata/hubtest/out/ValidatorHub.sol/ValidatorHub.json")
	if err != nil {
		t.Skip("no hub build (run testdata/hubtest/gen-abi.sh)")
	}
	var art struct {
		StorageLayout struct {
			Storage []struct {
				Label string `json:"label"`
				Slot  string `json:"slot"`
			} `json:"storage"`
		} `json:"storageLayout"`
	}
	if err := json.Unmarshal(b, &art); err != nil {
		t.Fatal(err)
	}
	if len(art.StorageLayout.Storage) == 0 {
		t.Skip("hub build has no storage layout (rebuild testdata/hubtest)")
	}
	for _, v := range art.StorageLayout.Storage {
		if v.Label == "_seats" {
			if v.Slot != fmt.Sprint(slotSeats) {
				t.Fatalf("ValidatorHub._seats is at slot %s, the decoder reads %d", v.Slot, slotSeats)
			}
			return
		}
	}
	t.Fatal("ValidatorHub has no _seats")
}

// The embedded ABI must be what gen-abi.sh extracts from the real hub. When a
// build of the hub is present (testdata/hubtest/out), compare them.
func TestABIMatchesHubBuild(t *testing.T) {
	b, err := os.ReadFile("../../testdata/hubtest/out/ValidatorHub.sol/ValidatorHub.json")
	if err != nil {
		t.Skip("no hub build (run testdata/hubtest/gen-abi.sh)")
	}
	var art struct {
		ABI json.RawMessage `json:"abi"`
	}
	json.Unmarshal(b, &art)
	full, err := abi.JSON(bytes.NewReader(art.ABI))
	if err != nil {
		t.Fatal(err)
	}
	for name, m := range ABI.Methods {
		fm, ok := full.Methods[name]
		if !ok || fm.Sig != m.Sig || len(fm.Outputs) != len(m.Outputs) {
			t.Fatalf("%s drifted from the hub build: regenerate abi.json", name)
		}
	}
}
