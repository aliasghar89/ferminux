package protect

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/aliasghar89/ferminux/chain/common"
	"github.com/aliasghar89/ferminux/chain/crypto"
)

var (
	scA = Scope{ChainID: 3961, Hub: common.HexToAddress("0x5FbDB2315678afecb367f032d93F642f64180aa3"), Attester: common.HexToAddress("0x67d4f97ff01895332b912a30535f139617140f3d")}
	scB = Scope{ChainID: 39610, Hub: scA.Hub, Attester: scA.Attester}
	h1  = crypto.Keccak256Hash([]byte("one"))
	h2  = crypto.Keccak256Hash([]byte("two"))
)

func open(t *testing.T, path string) *DB {
	t.Helper()
	db, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	return db
}

func TestApproveRefusesConflict(t *testing.T) {
	p := filepath.Join(t.TempDir(), "protection.log")
	db := open(t, p)
	fresh, err := db.Approve(scA, 400000, h1)
	if err != nil || !fresh {
		t.Fatalf("first approve: %v %v", fresh, err)
	}
	fresh, err = db.Approve(scA, 400000, h1)
	if err != nil || fresh {
		t.Fatalf("same hash again must be allowed and not fresh: %v %v", fresh, err)
	}
	if _, err := db.Approve(scA, 400000, h2); !errors.Is(err, ErrConflict) {
		t.Fatalf("different hash: got %v, want ErrConflict", err)
	}
	// another chain or hub is a different scope
	if _, err := db.Approve(scB, 400000, h2); err != nil {
		t.Fatalf("other scope: %v", err)
	}
	if _, err := db.Approve(scA, 400000, common.Hash{}); err == nil {
		t.Fatal("zero hash approved")
	}
	db.Close()

	// survives reopen, and still refuses
	db = open(t, p)
	defer db.Close()
	if _, err := db.Approve(scA, 400000, h2); !errors.Is(err, ErrConflict) {
		t.Fatalf("after reopen: got %v, want ErrConflict", err)
	}
	if h, ok := db.Lookup(scA, 400000); !ok || h != h1 {
		t.Fatal("lookup after reopen")
	}
	if m, ok := db.MaxHeight(scA); !ok || m != 400000 {
		t.Fatal("max height")
	}
}

func TestAppendOnly(t *testing.T) {
	p := filepath.Join(t.TempDir(), "protection.log")
	db := open(t, p)
	for i := uint64(1); i <= 5; i++ {
		if _, err := db.Approve(scA, i*200, crypto.Keccak256Hash([]byte{byte(i)})); err != nil {
			t.Fatal(err)
		}
	}
	before, _ := os.ReadFile(p)
	db.Approve(scA, 1200, h1)
	db.Close()
	after, _ := os.ReadFile(p)
	if !bytes.HasPrefix(after, before) {
		t.Fatal("existing bytes were rewritten")
	}
	if n := strings.Count(string(after), "\n"); n != 6 {
		t.Fatalf("%d lines, want 6", n)
	}
}

func TestExclusiveLock(t *testing.T) {
	p := filepath.Join(t.TempDir(), "protection.log")
	db := open(t, p)
	if _, err := Open(p); err == nil {
		t.Fatal("second open of the same database succeeded")
	}
	db.Close()
	db2 := open(t, p)
	db2.Close()
}

func TestTornTailIsCut(t *testing.T) {
	p := filepath.Join(t.TempDir(), "protection.log")
	db := open(t, p)
	db.Approve(scA, 200, h1)
	db.Approve(scA, 400, h1)
	db.Close()
	good, _ := os.ReadFile(p)
	// simulate a crash half-way through the next append
	f, _ := os.OpenFile(p, os.O_APPEND|os.O_WRONLY, 0)
	f.WriteString("A1 3961 0x5fbdb2315678afecb367f032d93f642f64180aa3 0x67d4f9")
	f.Close()
	db = open(t, p)
	if db.Repaired() == 0 {
		t.Fatal("torn tail not reported")
	}
	if _, ok := db.Lookup(scA, 400); !ok {
		t.Fatal("good record lost")
	}
	db.Close()
	now, _ := os.ReadFile(p)
	if !bytes.Equal(now, good) {
		t.Fatal("file not cut back to the last good record")
	}
	// a complete line with a bad checksum at the end is also a torn write
	f, _ = os.OpenFile(p, os.O_APPEND|os.O_WRONLY, 0)
	f.WriteString("A1 3961 0x5fbdb2315678afecb367f032d93f642f64180aa3 0x67d4f97ff01895332b912a30535f139617140f3d 600 " + h1.Hex() + " 1 deadbeef\n")
	f.Close()
	db = open(t, p)
	if db.Repaired() == 0 {
		t.Fatal("bad-checksum tail not cut")
	}
	db.Close()
}

func TestFailedAppendIsCutBack(t *testing.T) {
	p := filepath.Join(t.TempDir(), "protection.log")
	db := open(t, p)
	if _, err := db.Approve(scA, 200, h1); err != nil {
		t.Fatal(err)
	}
	// a full disk: part of the next record reaches the file, then the write fails
	db.writeString = func(f *os.File, s string) (int, error) {
		n, _ := f.WriteString(s[:25])
		return n, errors.New("no space left on device")
	}
	if _, err := db.Approve(scA, 400, h1); err == nil {
		t.Fatal("approve succeeded although the write failed")
	}
	if _, ok := db.Lookup(scA, 400); ok {
		t.Fatal("a record that was not saved is in memory")
	}
	// the disk has room again: the next record must start on a clean line
	db.writeString = func(f *os.File, s string) (int, error) { return f.WriteString(s) }
	if _, err := db.Approve(scA, 400, h2); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Approve(scA, 600, h1); err != nil {
		t.Fatal(err)
	}
	db.Close()
	db = open(t, p)
	defer db.Close()
	if db.Repaired() != 0 {
		t.Fatal("a clean file was reported as repaired")
	}
	for h, want := range map[uint64]common.Hash{200: h1, 400: h2, 600: h1} {
		if got, ok := db.Lookup(scA, h); !ok || got != want {
			t.Fatalf("height %d: %s %v", h, got.Hex(), ok)
		}
	}
}

func TestRepairObligationSurvivesReopen(t *testing.T) {
	p := filepath.Join(t.TempDir(), "protection.log")
	db := open(t, p)
	db.Approve(scA, 200, h1)
	db.Close()
	f, _ := os.OpenFile(p, os.O_APPEND|os.O_WRONLY, 0)
	f.WriteString("A1 3961 0x5fbdb23156")
	f.Close()
	// a read-only command (status, protection show) opens it first and cuts the tail
	db = open(t, p)
	n := db.Repaired()
	db.Close()
	if n == 0 {
		t.Fatal("torn tail not reported")
	}
	// the sidecar opening it afterwards must still be told to raise the watermark
	db = open(t, p)
	if db.Repaired() != n {
		t.Fatalf("repair obligation lost across reopen: %d, want %d", db.Repaired(), n)
	}
	if err := db.SetWatermark(scA, 1000); err != nil {
		t.Fatal(err)
	}
	if err := db.RepairHandled(); err != nil {
		t.Fatal(err)
	}
	db.Close()
	db = open(t, p)
	defer db.Close()
	if db.Repaired() != 0 {
		t.Fatal("handled repair still reported")
	}
	if db.Watermark(scA) != 1000 {
		t.Fatal("watermark lost")
	}
}

func TestCorruptionInTheMiddleFails(t *testing.T) {
	p := filepath.Join(t.TempDir(), "protection.log")
	db := open(t, p)
	db.Approve(scA, 200, h1)
	db.Approve(scA, 400, h1)
	db.Approve(scA, 600, h1)
	db.Close()
	data, _ := os.ReadFile(p)
	lines := strings.SplitAfter(string(data), "\n")
	lines[1] = strings.Replace(lines[1], " 400 ", " 401 ", 1) // checksum now wrong
	os.WriteFile(p, []byte(strings.Join(lines, "")), 0o600)
	if _, err := Open(p); !errors.Is(err, ErrCorrupt) {
		t.Fatalf("got %v, want ErrCorrupt", err)
	}
}

func TestConflictingRecordsInFileFail(t *testing.T) {
	p := filepath.Join(t.TempDir(), "protection.log")
	db := open(t, p)
	db.Approve(scA, 200, h1)
	db.Close()
	// a well-formed second record with another hash for the same height, even as
	// the last line, must never be "repaired" away
	f, _ := os.OpenFile(p, os.O_APPEND|os.O_WRONLY, 0)
	f.WriteString(line("A1 3961 0x5fbdb2315678afecb367f032d93f642f64180aa3 0x67d4f97ff01895332b912a30535f139617140f3d 200 " + h2.Hex() + " 5"))
	f.Close()
	if _, err := Open(p); !errors.Is(err, ErrCorrupt) {
		t.Fatalf("got %v, want ErrCorrupt", err)
	}
}

func TestWatermark(t *testing.T) {
	p := filepath.Join(t.TempDir(), "protection.log")
	db := open(t, p)
	db.Approve(scA, 400, h1)
	if err := db.SetWatermark(scA, 1000); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Approve(scA, 800, h1); !errors.Is(err, ErrBelowWatermark) {
		t.Fatalf("below watermark: %v", err)
	}
	if _, err := db.Approve(scA, 1000, h1); !errors.Is(err, ErrBelowWatermark) {
		t.Fatalf("at watermark: %v", err)
	}
	// a recorded height below the watermark can still be re-signed identically
	if _, err := db.Approve(scA, 400, h1); err != nil {
		t.Fatalf("recorded height: %v", err)
	}
	if _, err := db.Approve(scA, 1200, h1); err != nil {
		t.Fatal(err)
	}
	db.SetWatermark(scA, 500) // never lowers
	db.Close()
	db = open(t, p)
	defer db.Close()
	if db.Watermark(scA) != 1000 {
		t.Fatalf("watermark after reopen %d", db.Watermark(scA))
	}
}

func TestExportImport(t *testing.T) {
	dir := t.TempDir()
	src := open(t, filepath.Join(dir, "a.log"))
	src.Approve(scA, 200, h1)
	src.Approve(scA, 400, h2)
	src.SetWatermark(scA, 150)
	exp := src.Export()
	src.Close()

	dst := open(t, filepath.Join(dir, "b.log"))
	defer dst.Close()
	dst.Approve(scA, 600, h1)
	n, err := dst.Import(exp)
	if err != nil || n != 2 {
		t.Fatalf("import: %d %v", n, err)
	}
	if _, err := dst.Approve(scA, 400, h1); !errors.Is(err, ErrConflict) {
		t.Fatal("imported record not enforced")
	}
	if dst.Watermark(scA) != 150 {
		t.Fatal("watermark not imported")
	}
	// importing again is a no-op
	if n, err := dst.Import(exp); err != nil || n != 0 {
		t.Fatalf("re-import: %d %v", n, err)
	}
	// a conflicting import changes nothing
	bad := []ExportRecord{{ChainID: 3961, Hub: scA.Hub, Attester: scA.Attester, Height: 800, BlockHash: h1},
		{ChainID: 3961, Hub: scA.Hub, Attester: scA.Attester, Height: 600, BlockHash: h2}}
	if _, err := dst.Import(bad); !errors.Is(err, ErrConflict) {
		t.Fatalf("conflicting import: %v", err)
	}
	if _, ok := dst.Lookup(scA, 800); ok {
		t.Fatal("partial import written")
	}
	var buf bytes.Buffer
	buf.WriteString(`[{"chainId":3961,"hub":"0x5fbdb2315678afecb367f032d93f642f64180aa3","attester":"0x67d4f97ff01895332b912a30535f139617140f3d","height":1000,"blockHash":"` + h1.Hex() + `","time":1}]`)
	recs, err := ReadExport(&buf)
	if err != nil || len(recs) != 1 {
		t.Fatalf("read export: %v", err)
	}
}

func TestFileMode(t *testing.T) {
	if os.PathSeparator == '\\' {
		t.Skip("POSIX modes")
	}
	p := filepath.Join(t.TempDir(), "protection.log")
	db := open(t, p)
	db.Close()
	st, _ := os.Stat(p)
	if st.Mode().Perm() != 0o600 {
		t.Fatalf("mode %v", st.Mode().Perm())
	}
}
