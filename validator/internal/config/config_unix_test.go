//go:build !windows

package config

import (
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

// Operators run `sudo fmx-validator init --hub ...` on a config.json the
// service user owns: the saved file must stay the service user's, or the
// service cannot read its own config at the next start.
func TestSaveKeepsTheOwner(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("only root can give a file to another user")
	}
	const uid, gid = 65534, 65534
	dd := t.TempDir()
	dir := NetworkDir(dd, "devnet")
	if err := Save(dir, base()); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "config.json")
	if err := os.Chown(path, uid, gid); err != nil {
		t.Fatal(err)
	}
	if err := Save(dir, base()); err != nil {
		t.Fatal(err)
	}
	fi, err := os.Lstat(path)
	if err != nil {
		t.Fatal(err)
	}
	st := fi.Sys().(*syscall.Stat_t)
	if st.Uid != uid || st.Gid != gid {
		t.Fatalf("config.json is now %d:%d, want the replaced file's %d:%d", st.Uid, st.Gid, uid, gid)
	}
	if fi.Mode().Perm() != 0o600 {
		t.Fatalf("config.json mode %v, want 0600", fi.Mode().Perm())
	}
}
