package scheduler

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
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

var hubAddr = common.HexToAddress("0x5FbDB2315678afecb367f032d93F642f64180aa3")

type rig struct {
	t      *testing.T
	f      *fakeChain
	e      *Engine
	db     *protect.DB
	dbPath string
	log    *bytes.Buffer
}

func newRig(t *testing.T, f *fakeChain, dbPath string, mut func(e *Engine)) *rig {
	t.Helper()
	key := attestKey("seat-1")
	if dbPath == "" {
		dbPath = filepath.Join(t.TempDir(), "protection.log")
	}
	db, err := protect.Open(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	var logBuf bytes.Buffer
	e := &Engine{
		Chain: f, Hub: f, DB: db, Sub: f, Key: key, Addr: crypto.PubkeyToAddress(key.PublicKey),
		Domain: f.domain, Sched: attest.DefaultSchedule(),
		Policy: node.Policy{ChainID: f.chainID, MinPeers: 3, MaxHeadAge: time.Minute, DeepReorg: func() (bool, error) { return false, nil }},
		Status: status.NewTracker(status.Snapshot{}),
		Log:    logx.New(&logBuf, logx.Debug),
		Now: func() time.Time {
			return time.Unix(int64(f.timeAt(f.headNum())+2), 0)
		},
		DoppelgangerCheckpoints: 2,
	}
	if mut != nil {
		mut(e)
	}
	return &rig{t: t, f: f, e: e, db: db, dbPath: dbPath, log: &logBuf}
}

func attestKey(label string) *ecdsaKey {
	k, _ := crypto.ToECDSA(crypto.Keccak256([]byte("scheduler-test/" + label)))
	return k
}

// run mines to `to`, ticking the engine after every block.
func (r *rig) run(to uint64) {
	ctx := context.Background()
	for r.f.headNum() < to {
		r.e.Tick(ctx)
		r.f.mine()
	}
	r.e.Tick(ctx)
}

func (r *rig) addSeat(st hub.Status) uint64 {
	id := uint64(len(r.f.seats) + 1)
	r.f.seats[r.e.Addr] = id
	r.f.status[id] = st
	return id
}

func (r *rig) state(h uint64) status.Attestation {
	for _, a := range r.e.Status.Snapshot().Attestations {
		if a.Height == h {
			return a
		}
	}
	return status.Attestation{}
}

func TestHappyPath(t *testing.T) {
	f := newFake(3961, hubAddr)
	r := newRig(t, f, "", nil)
	seat := r.addSeat(hub.StatusActive)
	if err := r.e.Preflight(context.Background()); err != nil {
		t.Fatal(err)
	}
	r.run(1800)
	for _, h := range []uint64{1200, 1400, 1600} {
		got := f.atts[[2]uint64{seat, h}]
		if got != f.hashAt(h) {
			t.Fatalf("checkpoint %d: on-chain %s want %s", h, got.Hex(), f.hashAt(h).Hex())
		}
		st := r.state(h)
		if st.State != status.StateIncluded || st.IncludedIn < h+64 || st.IncludedIn > h+250 {
			t.Fatalf("checkpoint %d status %+v", h, st)
		}
		if rec, ok := r.db.Lookup(r.e.scope, h); !ok || rec != f.hashAt(h) {
			t.Fatalf("checkpoint %d not in protection db", h)
		}
	}
	// exactly one submission per checkpoint, each signed only once final (>= h+64 on the node)
	if n := f.sentCount(); n != 3 { // 1200, 1400, 1600
		t.Fatalf("%d submissions, want 3", n)
	}
	if r.e.Halted() != nil {
		t.Fatal(r.e.Halted())
	}
	snap := r.e.Status.Snapshot()
	if snap.Rewards.ExpectedPerDay == nil || snap.Rewards.ExpectedPerDay.Sign() == 0 || snap.Rewards.PoolEmpty {
		t.Fatal("no reward estimate")
	}
	// 1200 and 1400 closed and attested; 1600 still open
	if snap.Day.Included != 2 || snap.Day.Window != 62 {
		t.Fatalf("participation %+v", snap.Day)
	}
}

func TestSignsOnlyAtDepth64(t *testing.T) {
	f := newFake(3961, hubAddr)
	r := newRig(t, f, "", nil)
	r.addSeat(hub.StatusActive)
	if err := r.e.Preflight(context.Background()); err != nil {
		t.Fatal(err)
	}
	r.run(1263)
	if n := f.sentCount(); n != 0 {
		t.Fatalf("signed checkpoint 1200 at head %d (only %d deep)", f.headNum(), f.headNum()-1200)
	}
	r.run(1264)
	if n := f.sentCount(); n != 1 {
		t.Fatalf("not signed at depth 64")
	}
}

func TestNotReadyThenReady(t *testing.T) {
	f := newFake(3961, hubAddr)
	f.head = 1150
	r := newRig(t, f, "", nil)
	r.addSeat(hub.StatusActive)
	r.e.Preflight(context.Background())
	f.syncing = true
	r.run(1300)
	if f.sentCount() != 0 {
		t.Fatal("signed while syncing")
	}
	if st := r.state(1200); st.State != status.StateWaiting || !strings.Contains(st.Reason, "syncing") {
		t.Fatalf("%+v", st)
	}
	f.syncing = false
	f.peers = 1
	r.run(1320)
	if f.sentCount() != 0 {
		t.Fatal("signed with too few peers")
	}
	f.peers = 5
	r.run(1440)
	if st := r.state(1200); st.State != status.StateIncluded {
		t.Fatalf("after recovering: %+v", st)
	}
}

func TestLateStartMissesClosedWindow(t *testing.T) {
	f := newFake(3961, hubAddr)
	f.head = 1200 + 241 // too late to submit for 1200
	r := newRig(t, f, "", nil)
	r.addSeat(hub.StatusActive)
	r.e.Preflight(context.Background())
	r.run(1463)
	if f.sentCount() != 0 {
		t.Fatal("submitted into a closing window")
	}
	r.run(1670)
	if st := r.state(1400); st.State != status.StateIncluded {
		t.Fatalf("next checkpoint: %+v", st)
	}
}

func TestSeatNotActiveNoSignature(t *testing.T) {
	f := newFake(3961, hubAddr)
	r := newRig(t, f, "", nil)
	r.addSeat(hub.StatusPending)
	r.e.Preflight(context.Background())
	r.run(1300)
	if f.sentCount() != 0 {
		t.Fatal("signed for a pending seat")
	}
	if _, ok := r.db.MaxHeight(r.e.scope); ok {
		t.Fatal("recorded an approval for a pending seat")
	}
}

func TestNoSeatNoSignature(t *testing.T) {
	f := newFake(3961, hubAddr)
	r := newRig(t, f, "", nil)
	r.e.Preflight(context.Background())
	r.run(1300)
	if f.sentCount() != 0 {
		t.Fatal("signed without a seat")
	}
	if !strings.Contains(r.e.Status.Snapshot().SeatError, "no seat") {
		t.Fatal("no explanation for the missing seat")
	}
}

func TestKeyInUseElsewhereAtStartup(t *testing.T) {
	f := newFake(3961, hubAddr)
	r := newRig(t, f, "", nil)
	seat := r.addSeat(hub.StatusActive)
	f.forceAttest(seat, 800, f.hashAt(800)) // signed by another machine
	r.e.Imported = true                     // a key created here could not have signed it
	err := r.e.Preflight(context.Background())
	if !errors.Is(err, ErrKeyInUse) || !IsFatal(err) {
		t.Fatalf("got %v, want fatal ErrKeyInUse", err)
	}
}

func TestKeyInUseElsewhereAtRuntime(t *testing.T) {
	f := newFake(3961, hubAddr)
	f.head = 1150
	r := newRig(t, f, "", nil)
	seat := r.addSeat(hub.StatusActive)
	if err := r.e.Preflight(context.Background()); err != nil {
		t.Fatal(err)
	}
	f.mineTo(1263)
	f.forceAttest(seat, 1200, f.hashAt(1200)) // the other machine got there first
	r.run(1500)
	if !errors.Is(r.e.Halted(), ErrKeyInUse) {
		t.Fatalf("halted = %v", r.e.Halted())
	}
	if f.sentCount() != 0 {
		t.Fatal("kept signing after the key was seen elsewhere")
	}
	if !strings.Contains(r.log.String(), "SIGNING STOPPED") {
		t.Fatal("halt not logged")
	}
	// a restart refuses to start
	r.db.Close()
	r2 := newRig(t, f, r.dbPath, nil)
	if err := r2.e.Preflight(context.Background()); !errors.Is(err, ErrKeyInUse) {
		t.Fatalf("restart: %v", err)
	}
}

func TestAuditCatchesForeignAttestationAfterWindow(t *testing.T) {
	f := newFake(3961, hubAddr)
	f.head = 1150
	r := newRig(t, f, "", nil)
	seat := r.addSeat(hub.StatusPending) // this machine does not sign 1200
	r.e.Preflight(context.Background())
	r.run(1270)
	f.status[seat] = hub.StatusActive
	f.forceAttest(seat, 1200, f.hashAt(1200))
	r.run(1460)
	if !errors.Is(r.e.Halted(), ErrKeyInUse) {
		t.Fatalf("closed-checkpoint audit missed a foreign attestation: %v", r.e.Halted())
	}
}

func TestConflictingHashHalts(t *testing.T) {
	f := newFake(3961, hubAddr)
	r := newRig(t, f, "", nil)
	r.addSeat(hub.StatusActive)
	r.e.Preflight(context.Background())
	// this machine already signed another hash at 1200 (e.g. before a deep rewrite)
	if _, err := r.db.Approve(r.e.scope, 1200, crypto.Keccak256Hash([]byte("old"))); err != nil {
		t.Fatal(err)
	}
	r.run(1300)
	if !errors.Is(r.e.Halted(), protect.ErrConflict) {
		t.Fatalf("halted = %v", r.e.Halted())
	}
	if f.sentCount() != 0 {
		t.Fatal("signed a second hash for one height")
	}
	r.run(1500)
	if f.sentCount() != 0 {
		t.Fatal("kept signing after a conflict")
	}
}

func TestRestartResubmitsIdenticalSignature(t *testing.T) {
	f := newFake(3961, hubAddr)
	f.head = 1263
	dbPath := filepath.Join(t.TempDir(), "p.log")
	r := newRig(t, f, dbPath, nil)
	seat := r.addSeat(hub.StatusActive)
	r.e.Preflight(context.Background())
	r.e.Tick(context.Background()) // head 1263: not yet
	f.mine()
	r.e.Tick(context.Background()) // head 1264: signs and submits
	if f.sentCount() != 1 {
		t.Fatal("not submitted")
	}
	first := f.sentData[0]
	f.pending = nil // the transaction is lost (crash before it was propagated)
	r.db.Close()

	r2 := newRig(t, f, dbPath, nil)
	if err := r2.e.Preflight(context.Background()); err != nil {
		t.Fatal(err)
	}
	r2.run(1300)
	if f.sentCount() != 2 || !bytes.Equal(f.sentData[1], first) {
		t.Fatal("restart did not resubmit the identical attestation")
	}
	if f.atts[[2]uint64{seat, 1200}] != f.hashAt(1200) {
		t.Fatal("resubmission not included")
	}
}

func TestImportedKeyWatchesBeforeSigning(t *testing.T) {
	f := newFake(3961, hubAddr)
	f.head = 1150
	r := newRig(t, f, "", func(e *Engine) { e.Imported = true })
	seat := r.addSeat(hub.StatusActive)
	if err := r.e.Preflight(context.Background()); err != nil {
		t.Fatal(err)
	}
	r.run(1660)
	if f.atts[[2]uint64{seat, 1200}] != (common.Hash{}) || f.atts[[2]uint64{seat, 1400}] != (common.Hash{}) {
		t.Fatal("signed during the watch period")
	}
	if st := r.state(1200); st.State != status.StateWatching {
		t.Fatalf("1200: %+v", st)
	}
	r.run(1900)
	if f.atts[[2]uint64{seat, 1600}] != f.hashAt(1600) {
		t.Fatalf("did not start signing after two clean checkpoints (watch left %d)", r.e.watchLeft)
	}
}

func TestImportedKeySeesOtherUser(t *testing.T) {
	f := newFake(3961, hubAddr)
	f.head = 1150
	r := newRig(t, f, "", func(e *Engine) { e.Imported = true })
	seat := r.addSeat(hub.StatusActive)
	r.e.Preflight(context.Background())
	r.run(1270)
	f.forceAttest(seat, 1200, f.hashAt(1200)) // the old machine is still running
	r.run(1900)
	if !errors.Is(r.e.Halted(), ErrKeyInUse) || f.sentCount() != 0 {
		t.Fatalf("halted=%v sent=%d", r.e.Halted(), f.sentCount())
	}
}

func TestAdoptOnChainHistory(t *testing.T) {
	f := newFake(3961, hubAddr)
	f.head = 1150
	r := newRig(t, f, "", func(e *Engine) { e.Adopt = true; e.Imported = true })
	seat := r.addSeat(hub.StatusActive)
	f.forceAttest(seat, 1000, f.hashAt(1000))
	if err := r.e.Preflight(context.Background()); err != nil {
		t.Fatal(err)
	}
	if h, ok := r.db.Lookup(r.e.scope, 1000); !ok || h != f.hashAt(1000) {
		t.Fatal("on-chain history not imported")
	}
	if r.db.Watermark(r.e.scope) != 1150 {
		t.Fatalf("watermark %d", r.db.Watermark(r.e.scope))
	}
	r.run(1900)
	if f.atts[[2]uint64{seat, 1600}] != f.hashAt(1600) {
		t.Fatal("adopted key never started signing")
	}
}

func TestRotatedKeyTakesOverSeatHistory(t *testing.T) {
	// the seat's previous attester key attested 1000; this key took over at block 1251
	f := newFake(3961, hubAddr)
	r := newRig(t, f, "", nil)
	seat := r.addSeat(hub.StatusActive)
	f.forceAttest(seat, 1000, f.hashAt(1000))
	f.rotatedAt[r.e.Addr] = 1251
	if err := r.e.Preflight(context.Background()); err != nil {
		t.Fatal(err)
	}
	r.run(1300)
	if f.atts[[2]uint64{seat, 1200}] != f.hashAt(1200) {
		t.Fatal("did not attest after taking over the seat")
	}
}

func TestRotationInsideWindowIsAmbiguous(t *testing.T) {
	// rotated at 1240: the attestation for 1000 could have been included after
	// that (its window runs to 1250), so it may be this key's
	f := newFake(3961, hubAddr)
	r := newRig(t, f, "", nil)
	seat := r.addSeat(hub.StatusActive)
	f.forceAttest(seat, 1000, f.hashAt(1000))
	f.rotatedAt[r.e.Addr] = 1240
	if err := r.e.Preflight(context.Background()); !errors.Is(err, ErrKeyInUse) {
		t.Fatalf("got %v", err)
	}
}

func TestTakeOverAfterPreviousKeyAttestedNoHalt(t *testing.T) {
	// This key waits as the seat's queued attester. The old machine attests
	// 1200 at 1270 with the previous key; the rotation is applied at 1280,
	// inside 1200's window. That attestation is not a sign of another user.
	f := newFake(3961, hubAddr)
	r := newRig(t, f, "", nil)
	const seat = 1
	f.status[seat] = hub.StatusActive
	if err := r.e.Preflight(context.Background()); err != nil {
		t.Fatal(err)
	}
	r.run(1270)
	f.forceAttest(seat, 1200, f.hashAt(1200))
	r.run(1280)
	f.seats[r.e.Addr] = seat
	f.rotatedAt[r.e.Addr] = 1280
	r.run(1500)
	if err := r.e.Halted(); err != nil {
		t.Fatalf("halted after a normal key rotation: %v", err)
	}
	if st := r.state(1200); st.State != status.StateSkipped {
		t.Fatalf("1200: %+v", st)
	}
	if f.atts[[2]uint64{seat, 1400}] != f.hashAt(1400) {
		t.Fatal("did not attest the first checkpoint after taking over")
	}
}

func TestAuditHaltsWhenChainHoldsAnotherHash(t *testing.T) {
	// this machine signed X at 1200; the seat's attestation on-chain is the
	// canonical hash, so it was signed elsewhere with this key
	f := newFake(3961, hubAddr)
	f.head = 1150
	r := newRig(t, f, "", nil)
	seat := r.addSeat(hub.StatusPending)
	r.e.Preflight(context.Background())
	r.run(1270)
	if _, err := r.db.Approve(r.e.scope, 1200, crypto.Keccak256Hash([]byte("fork"))); err != nil {
		t.Fatal(err)
	}
	f.forceAttest(seat, 1200, f.hashAt(1200))
	r.run(1460)
	if !errors.Is(r.e.Halted(), ErrKeyInUse) {
		t.Fatalf("halted = %v", r.e.Halted())
	}
}

func TestHaltCallback(t *testing.T) {
	f := newFake(3961, hubAddr)
	var got error
	r := newRig(t, f, "", func(e *Engine) { e.OnHalt = func(err error) { got = err } })
	seat := r.addSeat(hub.StatusActive)
	r.e.Preflight(context.Background())
	f.mineTo(1263)
	f.forceAttest(seat, 1200, f.hashAt(1200))
	r.run(1300)
	if !errors.Is(got, ErrKeyInUse) {
		t.Fatalf("OnHalt got %v", got)
	}
}

func TestPausedHubNoSignature(t *testing.T) {
	f := newFake(3961, hubAddr)
	f.paused = true
	r := newRig(t, f, "", nil)
	r.addSeat(hub.StatusActive)
	r.e.Preflight(context.Background())
	r.run(1300)
	if f.sentCount() != 0 {
		t.Fatal("submitted while the hub is paused")
	}
	if st := r.state(1200); !strings.Contains(st.Reason, "paused") {
		t.Fatalf("%+v", st)
	}
}

func TestDomainMismatchIsFatal(t *testing.T) {
	f := newFake(3961, hubAddr)
	other := attest.Domain{ChainID: 3961, Hub: common.HexToAddress("0x01")}.Separator()
	f.separator = &other
	r := newRig(t, f, "", nil)
	if err := r.e.Preflight(context.Background()); err == nil || !IsFatal(err) {
		t.Fatalf("got %v", err)
	}
}

func TestWrongChainIsFatal(t *testing.T) {
	f := newFake(3961, hubAddr)
	r := newRig(t, f, "", func(e *Engine) { e.Domain.ChainID = 39610 })
	if err := r.e.Preflight(context.Background()); err == nil || !IsFatal(err) {
		t.Fatalf("got %v", err)
	}
}

func TestTornDatabaseRaisesWatermark(t *testing.T) {
	f := newFake(3961, hubAddr)
	f.head = 1263
	dbPath := filepath.Join(t.TempDir(), "p.log")
	db, _ := protect.Open(dbPath)
	db.Close()
	appendRaw(t, dbPath, "A1 3961 0x5fbdb2315678afecb367f032d93f642f64180aa3 0xdead")
	r := newRig(t, f, dbPath, nil)
	r.addSeat(hub.StatusActive)
	if err := r.e.Preflight(context.Background()); err != nil {
		t.Fatal(err)
	}
	if r.db.Repaired() != 0 {
		t.Fatal("repair still pending after the watermark was raised")
	}
	r.run(1300)
	if f.sentCount() != 0 {
		t.Fatal("signed a height at or below the head seen when the torn record was found")
	}
	r.run(1500)
	if f.sentCount() != 1 {
		t.Fatal("did not resume at the next checkpoint")
	}
}

func TestNoSecretsInLog(t *testing.T) {
	f := newFake(3961, hubAddr)
	r := newRig(t, f, "", nil)
	r.addSeat(hub.StatusActive)
	r.e.Preflight(context.Background())
	r.run(1500)
	keyHex := common.Bytes2Hex(crypto.FromECDSA(r.e.Key))
	if strings.Contains(strings.ToLower(r.log.String()), keyHex) {
		t.Fatal("private key in the log")
	}
}

type ecdsaKey = ecdsa.PrivateKey

func appendRaw(t *testing.T, path, s string) {
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	f.WriteString(s)
	f.Close()
}
