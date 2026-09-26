// Package protect is the sidecar's local slashing-protection database.
//
// It is an append-only text file. Before any attestation is signed, the
// (chain, hub, attester, height, hash) it is about to sign is appended and
// fsynced; only then is the signature produced. For a height that already has
// a record, only the same hash is ever approved again (re-signing the same
// message yields the same deterministic signature, which is harmless); a
// different hash is refused. That is the one offence the hub slashes.
//
// Record line (one per line, space separated, CRC-32C over everything before
// the checksum):
//
//	A1 <chainId> <hub> <attester> <height> <blockHash> <unixTime> <crc>
//
// A watermark line refuses every unrecorded height at or below it for one
// scope. It is written when a key is adopted on a machine whose database does
// not know the key's earlier signatures:
//
//	W1 <chainId> <hub> <attester> <height> <unixTime> <crc>
//
// A torn last line (a crash during the append, before the fsync returned and
// therefore before any signature existed) is cut off on open. Before the cut, a
// companion file path+".repair" is written; it keeps Repaired() non-zero across
// restarts (and across read-only commands that open the database) until the
// caller has raised the watermark and called RepairHandled. Damage anywhere
// else makes Open fail: the file is never silently rewritten.
//
// An append that fails part-way (a full disk, an I/O error) is cut back to the
// previous end of the file before Approve returns its error, so the next record
// never lands on the end of a fragment.
package protect

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"hash/crc32"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/aliasghar89/ferminux/chain/common"
	"github.com/aliasghar89/ferminux/validator/internal/flock"
)

var (
	// ErrConflict: a different hash is already recorded for this height.
	ErrConflict = errors.New("slashing protection: a different block hash was already signed at this height")
	// ErrBelowWatermark: the height is at or below the scope's watermark and has no record.
	ErrBelowWatermark = errors.New("slashing protection: height is at or below the watermark and was never recorded here")
	// ErrCorrupt: a record other than the last one is damaged.
	ErrCorrupt = errors.New("slashing protection: database is damaged")
)

var castagnoli = crc32.MakeTable(crc32.Castagnoli)

// Scope is one attester key on one hub on one chain.
type Scope struct {
	ChainID  uint64         `json:"chainId"`
	Hub      common.Address `json:"hub"`
	Attester common.Address `json:"attester"`
}

func (s Scope) String() string {
	return fmt.Sprintf("chain %d hub %s attester %s", s.ChainID, s.Hub.Hex(), s.Attester.Hex())
}

// Record is one approved (signed) attestation.
type Record struct {
	Scope
	Height    uint64      `json:"height"`
	BlockHash common.Hash `json:"blockHash"`
	Time      int64       `json:"time"`
}

// ExportRecord is the portable form used by export/import.
type ExportRecord struct {
	ChainID   uint64         `json:"chainId"`
	Hub       common.Address `json:"hub"`
	Attester  common.Address `json:"attester"`
	Height    uint64         `json:"height"`
	BlockHash common.Hash    `json:"blockHash,omitempty"`
	Watermark bool           `json:"watermark,omitempty"`
	Time      int64          `json:"time"`
}

type key struct {
	Scope
	height uint64
}

// DB is an open protection database. It holds an exclusive OS lock for its
// lifetime, so two sidecars on one machine can never share it.
type DB struct {
	mu         sync.Mutex
	path       string
	f          *os.File
	lock       *flock.Lock
	records    map[key]Record
	watermarks map[Scope]uint64
	repaired   int64 // bytes cut from a torn tail on open (or by an earlier open, see RepairHandled)
	broken     error // a failed append could not be cut back: every later write is refused
	now        func() time.Time
	// writeString appends to the file; tests replace it to simulate a short write.
	writeString func(f *os.File, s string) (int, error)
}

// Open opens or creates the database at path. A companion lock file path+".lock"
// is held until Close.
func Open(path string) (*DB, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	lk, err := flock.Acquire(path + ".lock")
	if err != nil {
		return nil, fmt.Errorf("slashing protection database is in use: %w", err)
	}
	db := &DB{path: path, lock: lk, records: map[key]Record{}, watermarks: map[Scope]uint64{}, now: time.Now,
		writeString: func(f *os.File, s string) (int, error) { return f.WriteString(s) }}
	if err := db.load(); err != nil {
		lk.Release()
		return nil, err
	}
	return db, nil
}

func (db *DB) repairPath() string { return db.path + ".repair" }

// writeRepairMarker durably records that n bytes of torn tail were cut, before
// the cut happens.
func (db *DB) writeRepairMarker(n int64) error {
	f, err := os.OpenFile(db.repairPath(), os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	if _, err := f.WriteString(strconv.FormatInt(n, 10) + "\n"); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	syncDir(filepath.Dir(db.path))
	return nil
}

func (db *DB) load() error {
	if b, err := os.ReadFile(db.repairPath()); err == nil {
		// an earlier open cut a torn tail and the watermark was not raised yet
		n, perr := strconv.ParseInt(strings.TrimSpace(string(b)), 10, 64)
		if perr != nil || n <= 0 {
			n = 1
		}
		db.repaired = n
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	_, statErr := os.Stat(db.path)
	created := os.IsNotExist(statErr)
	f, err := os.OpenFile(db.path, os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		return err
	}
	if created {
		syncDir(filepath.Dir(db.path))
	}
	data, err := io.ReadAll(f)
	if err != nil {
		f.Close()
		return err
	}
	good := int64(0)
	lines := bytes.SplitAfter(data, []byte{'\n'})
	lastIdx := len(lines) - 1
	for lastIdx >= 0 && len(lines[lastIdx]) == 0 {
		lastIdx--
	}
	for i := 0; i <= lastIdx; i++ {
		raw := lines[i]
		complete := raw[len(raw)-1] == '\n'
		text := strings.TrimRight(string(raw), "\r\n")
		var perr error
		switch {
		case !complete:
			perr = errors.New("unterminated line")
		case text == "":
			// blank line: tolerated
		default:
			perr = db.apply(text)
		}
		if perr != nil {
			var sem semanticError
			if i == lastIdx && !errors.As(perr, &sem) {
				// Torn tail: the append never returned from fsync, so no
				// signature was produced for it. Cut it off and report it so
				// the caller can raise a watermark; the marker keeps that
				// obligation if this process stops before the caller does.
				cut := int64(len(data)) - good
				if err := db.writeRepairMarker(db.repaired + cut); err != nil {
					f.Close()
					return fmt.Errorf("slashing protection: recording the repair of a torn record: %w", err)
				}
				db.repaired += cut
				if err := f.Truncate(good); err != nil {
					f.Close()
					return err
				}
				if err := f.Sync(); err != nil {
					f.Close()
					return err
				}
				break
			}
			f.Close()
			return fmt.Errorf("%w: %s line %d: %v", ErrCorrupt, db.path, i+1, perr)
		}
		good += int64(len(raw))
	}
	if _, err := f.Seek(0, io.SeekEnd); err != nil {
		f.Close()
		return err
	}
	db.f = f
	return nil
}

// apply parses one line and folds it into memory. Duplicate identical records
// are fine; two different hashes for one height in the file are a hard error
// (the file itself would then prove an earlier bug).
func (db *DB) apply(line string) error {
	fields := strings.Fields(line)
	if len(fields) < 2 {
		return errors.New("short line")
	}
	body := strings.Join(fields[:len(fields)-1], " ")
	want, err := strconv.ParseUint(fields[len(fields)-1], 16, 32)
	if err != nil {
		return errors.New("bad checksum field")
	}
	if crc32.Checksum([]byte(body), castagnoli) != uint32(want) {
		return errors.New("checksum mismatch")
	}
	fields = fields[:len(fields)-1]
	switch fields[0] {
	case "A1":
		if len(fields) != 7 {
			return errors.New("bad record arity")
		}
		sc, err := parseScope(fields[1], fields[2], fields[3])
		if err != nil {
			return err
		}
		h, err := strconv.ParseUint(fields[4], 10, 64)
		if err != nil {
			return err
		}
		hash, err := parseHash(fields[5])
		if err != nil {
			return err
		}
		ts, err := strconv.ParseInt(fields[6], 10, 64)
		if err != nil {
			return err
		}
		k := key{sc, h}
		if prev, ok := db.records[k]; ok && prev.BlockHash != hash {
			return semanticError{fmt.Errorf("two different hashes recorded for height %d (%s)", h, sc)}
		}
		db.records[k] = Record{Scope: sc, Height: h, BlockHash: hash, Time: ts}
	case "W1":
		if len(fields) != 6 {
			return errors.New("bad watermark arity")
		}
		sc, err := parseScope(fields[1], fields[2], fields[3])
		if err != nil {
			return err
		}
		h, err := strconv.ParseUint(fields[4], 10, 64)
		if err != nil {
			return err
		}
		if h > db.watermarks[sc] {
			db.watermarks[sc] = h
		}
	default:
		return fmt.Errorf("unknown record type %q", fields[0])
	}
	return nil
}

// semanticError is a well-formed, checksummed line that contradicts earlier
// records. It is never treated as a torn write.
type semanticError struct{ error }

func parseScope(chain, hub, att string) (Scope, error) {
	c, err := strconv.ParseUint(chain, 10, 64)
	if err != nil {
		return Scope{}, err
	}
	if !common.IsHexAddress(hub) || !common.IsHexAddress(att) {
		return Scope{}, errors.New("bad address")
	}
	return Scope{ChainID: c, Hub: common.HexToAddress(hub), Attester: common.HexToAddress(att)}, nil
}

func parseHash(s string) (common.Hash, error) {
	if len(s) != 66 || !strings.HasPrefix(s, "0x") {
		return common.Hash{}, errors.New("bad hash")
	}
	b, err := hex.DecodeString(s[2:])
	if err != nil {
		return common.Hash{}, err
	}
	return common.BytesToHash(b), nil
}

func line(body string) string {
	return fmt.Sprintf("%s %08x\n", body, crc32.Checksum([]byte(body), castagnoli))
}

// appendDurable writes one or more complete lines and fsyncs before returning.
// If the write or the fsync fails, whatever part of it reached the file is cut
// back off, so a later append never lands on the end of a fragment (which would
// merge two records into one damaged line). If even that fails, the database
// refuses every later write until it is reopened.
func (db *DB) appendDurable(l string) error {
	if db.f == nil {
		return errors.New("slashing protection: database is closed")
	}
	if db.broken != nil {
		return db.broken
	}
	off, err := db.f.Seek(0, io.SeekCurrent)
	if err != nil {
		return err
	}
	_, werr := db.writeString(db.f, l)
	if werr == nil {
		if werr = db.f.Sync(); werr == nil {
			return nil
		}
	}
	if err := db.f.Truncate(off); err != nil {
		db.broken = fmt.Errorf("slashing protection: a failed write could not be undone (%v); restart fmx-validator", err)
		return werr
	}
	if _, err := db.f.Seek(off, io.SeekStart); err != nil {
		db.broken = fmt.Errorf("slashing protection: a failed write could not be undone (%v); restart fmx-validator", err)
		return werr
	}
	if err := db.f.Sync(); err != nil {
		db.broken = fmt.Errorf("slashing protection: a failed write could not be undone (%v); restart fmx-validator", err)
	}
	return werr
}

// Approve must be called, and must return nil, before signing (scope, height,
// hash). It durably records the approval first. fresh is false when the exact
// same record already existed (a re-sign of an identical message).
func (db *DB) Approve(sc Scope, height uint64, hash common.Hash) (fresh bool, err error) {
	if hash == (common.Hash{}) {
		return false, errors.New("slashing protection: refusing to sign a zero hash")
	}
	db.mu.Lock()
	defer db.mu.Unlock()
	k := key{sc, height}
	if prev, ok := db.records[k]; ok {
		if prev.BlockHash != hash {
			return false, fmt.Errorf("%w: height %d already signed %s, asked to sign %s (%s)",
				ErrConflict, height, prev.BlockHash.Hex(), hash.Hex(), sc)
		}
		return false, nil
	}
	if wm, ok := db.watermarks[sc]; ok && height <= wm {
		return false, fmt.Errorf("%w: height %d <= watermark %d (%s)", ErrBelowWatermark, height, wm, sc)
	}
	ts := db.now().Unix()
	body := fmt.Sprintf("A1 %d %s %s %d %s %d", sc.ChainID, lower(sc.Hub), lower(sc.Attester), height, hash.Hex(), ts)
	if err := db.appendDurable(line(body)); err != nil {
		return false, fmt.Errorf("slashing protection: could not record approval, not signing: %w", err)
	}
	db.records[k] = Record{Scope: sc, Height: height, BlockHash: hash, Time: ts}
	return true, nil
}

// Lookup returns the recorded hash for a height, if any.
func (db *DB) Lookup(sc Scope, height uint64) (common.Hash, bool) {
	db.mu.Lock()
	defer db.mu.Unlock()
	r, ok := db.records[key{sc, height}]
	return r.BlockHash, ok
}

// SetWatermark refuses every unrecorded height <= h for the scope from now on.
// Watermarks only ever rise.
func (db *DB) SetWatermark(sc Scope, h uint64) error {
	db.mu.Lock()
	defer db.mu.Unlock()
	if h <= db.watermarks[sc] {
		return nil
	}
	body := fmt.Sprintf("W1 %d %s %s %d %d", sc.ChainID, lower(sc.Hub), lower(sc.Attester), h, db.now().Unix())
	if err := db.appendDurable(line(body)); err != nil {
		return err
	}
	db.watermarks[sc] = h
	return nil
}

// Watermark returns the scope's watermark (0 if none).
func (db *DB) Watermark(sc Scope) uint64 {
	db.mu.Lock()
	defer db.mu.Unlock()
	return db.watermarks[sc]
}

// Records returns the scope's records, newest height first.
func (db *DB) Records(sc Scope) []Record {
	db.mu.Lock()
	defer db.mu.Unlock()
	var out []Record
	for k, r := range db.records {
		if k.Scope == sc {
			out = append(out, r)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Height > out[j].Height })
	return out
}

// MaxHeight returns the highest recorded height for a scope.
func (db *DB) MaxHeight(sc Scope) (uint64, bool) {
	db.mu.Lock()
	defer db.mu.Unlock()
	var m uint64
	found := false
	for k := range db.records {
		if k.Scope == sc && (!found || k.height > m) {
			m, found = k.height, true
		}
	}
	return m, found
}

// Export returns every record and watermark, for moving a key between machines.
func (db *DB) Export() []ExportRecord {
	db.mu.Lock()
	defer db.mu.Unlock()
	var out []ExportRecord
	for _, r := range db.records {
		out = append(out, ExportRecord{ChainID: r.ChainID, Hub: r.Hub, Attester: r.Attester, Height: r.Height, BlockHash: r.BlockHash, Time: r.Time})
	}
	for sc, h := range db.watermarks {
		out = append(out, ExportRecord{ChainID: sc.ChainID, Hub: sc.Hub, Attester: sc.Attester, Height: h, Watermark: true})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Attester != out[j].Attester {
			return bytes.Compare(out[i].Attester[:], out[j].Attester[:]) < 0
		}
		if out[i].Height != out[j].Height {
			return out[i].Height < out[j].Height
		}
		return !out[i].Watermark && out[j].Watermark
	})
	return out
}

// Import merges exported records. It checks every record for conflicts before
// writing any, so a conflicting import changes nothing.
func (db *DB) Import(in []ExportRecord) (added int, err error) {
	db.mu.Lock()
	defer db.mu.Unlock()
	seen := map[key]common.Hash{}
	for _, r := range in {
		if r.Watermark {
			continue
		}
		if r.BlockHash == (common.Hash{}) {
			return 0, fmt.Errorf("import: record for height %d has no hash", r.Height)
		}
		sc := Scope{ChainID: r.ChainID, Hub: r.Hub, Attester: r.Attester}
		k := key{sc, r.Height}
		if prev, ok := db.records[k]; ok && prev.BlockHash != r.BlockHash {
			return 0, fmt.Errorf("%w: import height %d has %s, this machine signed %s", ErrConflict, r.Height, r.BlockHash.Hex(), prev.BlockHash.Hex())
		}
		if prev, ok := seen[k]; ok && prev != r.BlockHash {
			return 0, fmt.Errorf("%w: import file has two hashes for height %d", ErrConflict, r.Height)
		}
		seen[k] = r.BlockHash
	}
	var buf strings.Builder
	type pending struct {
		k key
		r Record
	}
	var adds []pending
	wms := map[Scope]uint64{}
	for _, r := range in {
		sc := Scope{ChainID: r.ChainID, Hub: r.Hub, Attester: r.Attester}
		if r.Watermark {
			if r.Height > db.watermarks[sc] && r.Height > wms[sc] {
				wms[sc] = r.Height
			}
			continue
		}
		k := key{sc, r.Height}
		if _, ok := db.records[k]; ok {
			continue
		}
		ts := r.Time
		if ts == 0 {
			ts = db.now().Unix()
		}
		buf.WriteString(line(fmt.Sprintf("A1 %d %s %s %d %s %d", sc.ChainID, lower(sc.Hub), lower(sc.Attester), r.Height, r.BlockHash.Hex(), ts)))
		adds = append(adds, pending{k, Record{Scope: sc, Height: r.Height, BlockHash: r.BlockHash, Time: ts}})
		db.records[k] = Record{} // placeholder to dedupe within the import; replaced below
	}
	for sc, h := range wms {
		buf.WriteString(line(fmt.Sprintf("W1 %d %s %s %d %d", sc.ChainID, lower(sc.Hub), lower(sc.Attester), h, db.now().Unix())))
	}
	if buf.Len() > 0 {
		if err := db.appendDurable(buf.String()); err != nil {
			for _, p := range adds {
				delete(db.records, p.k)
			}
			return 0, err
		}
	}
	for _, p := range adds {
		db.records[p.k] = p.r
	}
	for sc, h := range wms {
		db.watermarks[sc] = h
	}
	return len(adds), nil
}

// Repaired reports how many bytes of a torn last record were cut, on this open
// or on an earlier one whose repair was not yet handled. When it is non-zero the
// caller must raise the watermark to the current chain head before signing (the
// torn record's height is unknown but cannot exceed it), then call RepairHandled.
func (db *DB) Repaired() int64 {
	db.mu.Lock()
	defer db.mu.Unlock()
	return db.repaired
}

// RepairHandled clears the repair obligation once the watermark covers it.
func (db *DB) RepairHandled() error {
	db.mu.Lock()
	defer db.mu.Unlock()
	if db.repaired == 0 {
		return nil
	}
	if err := os.Remove(db.repairPath()); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	syncDir(filepath.Dir(db.path))
	db.repaired = 0
	return nil
}

// Path is the database file.
func (db *DB) Path() string { return db.path }

// Close releases the file and its lock.
func (db *DB) Close() error {
	db.mu.Lock()
	defer db.mu.Unlock()
	var err error
	if db.f != nil {
		err = db.f.Close()
		db.f = nil
	}
	if db.lock != nil {
		db.lock.Release()
		db.lock = nil
	}
	return err
}

func lower(a common.Address) string { return strings.ToLower(a.Hex()) }

// syncDir makes a newly created file's directory entry durable (no-op where
// directories cannot be fsynced).
func syncDir(dir string) {
	d, err := os.Open(dir)
	if err != nil {
		return
	}
	_ = d.Sync()
	d.Close()
}

// ReadExport parses an export file.
func ReadExport(r io.Reader) ([]ExportRecord, error) {
	var out []ExportRecord
	dec := json.NewDecoder(r)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&out); err != nil {
		return nil, err
	}
	return out, nil
}
