//go:build !windows

package protect

import (
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

// `sudo fmx-validator status` and the protection commands open the database as
// root in a network directory the service user owns. The lock was opened by
// path and had this process's PID written into whatever a link planted at
// protection.log.lock pointed at; repairing a torn tail then wrote
// protection.log.repair and cut protection.log by path, through a link at
// either name.
func TestOpenNeverWritesThroughAPlantedLink(t *testing.T) {
	const torn = "A1 3961 0x5fbdb2315678afecb367f032d93f642f64180aa3 0x67d4f9"
	for _, name := range []string{"protection.log.lock", "protection.log.repair", "protection.log"} {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			p := filepath.Join(dir, "protection.log")
			// a victim whose only line does not parse is what the torn-tail
			// repair cuts when it is reached through protection.log
			victimText := "a file only root may change"
			if name != "protection.log" {
				victimText += "\n"
				// a torn tail, so that Open repairs it
				if err := os.WriteFile(p, []byte(torn), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			victim := filepath.Join(t.TempDir(), "victim")
			if err := os.WriteFile(victim, []byte(victimText), 0o644); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(victim, filepath.Join(dir, name)); err != nil {
				t.Skipf("symlinks unavailable here: %v", err)
			}
			db, err := Open(p)
			if err == nil {
				db.Close()
			}
			if b, rerr := os.ReadFile(victim); rerr != nil || string(b) != victimText {
				t.Fatalf("Open wrote through the link planted at %s: %q %v", name, b, rerr)
			}
			if err == nil {
				t.Fatalf("Open accepted a link at %s", name)
			}
		})
	}
}

// The service user can also put a link where the network directory was: root
// must not create or write the database's files in the link's target.
func TestOpenRefusesALinkedDirectory(t *testing.T) {
	dd := t.TempDir()
	target := t.TempDir() // stands in for a directory only root may change
	if err := os.Symlink(target, filepath.Join(dd, "devnet")); err != nil {
		t.Skipf("symlinks unavailable here: %v", err)
	}
	if db, err := Open(filepath.Join(dd, "devnet", "protection.log")); err == nil {
		db.Close()
		t.Fatal("the database was opened through a linked network directory")
	}
	if entries, _ := os.ReadDir(target); len(entries) != 0 {
		t.Fatalf("files written in the link's target: %v", entries)
	}
}

// The service opens its database only once it has a hub address and a key, so
// on an installed node `sudo fmx-validator protection import` (a key moved
// with its database), `protection show` or `export` is often the first to open
// it; and `sudo fmx-validator status` cuts a torn record the service left
// before the service reopens the database. Root created protection.log, its
// lock and the repair marker as its own 0600 files in the network directory
// the service user owns, and the service could never open its database again.
func TestOpenGivesNewFilesTheDirectoryOwner(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("only root can give a file to another user")
	}
	const uid, gid = 65534, 65534
	check := func(t *testing.T, p string) {
		t.Helper()
		fi, err := os.Lstat(p)
		if err != nil {
			t.Fatal(err)
		}
		st := fi.Sys().(*syscall.Stat_t)
		if st.Uid != uid || st.Gid != gid || fi.Mode().Perm() != 0o600 {
			t.Fatalf("%s is %d:%d %v, want its directory's %d:%d 0600", filepath.Base(p), st.Uid, st.Gid, fi.Mode().Perm(), uid, gid)
		}
	}
	serviceDir := func(t *testing.T) string {
		dir := t.TempDir()
		if err := os.Chown(dir, uid, gid); err != nil {
			t.Fatal(err)
		}
		return dir
	}
	t.Run("new database", func(t *testing.T) {
		p := filepath.Join(serviceDir(t), "protection.log")
		db, err := Open(p)
		if err != nil {
			t.Fatal(err)
		}
		db.Close()
		check(t, p)
		check(t, p+".lock")
	})
	t.Run("torn record cut", func(t *testing.T) {
		p := filepath.Join(serviceDir(t), "protection.log")
		// as the service left them: its own database and lock, a torn last line
		for name, b := range map[string]string{p: "A1 3961 0x5fbdb2315678afecb367f032d93f642f64180aa3 0x67d4f9", p + ".lock": ""} {
			if err := os.WriteFile(name, []byte(b), 0o600); err != nil {
				t.Fatal(err)
			}
			if err := os.Chown(name, uid, gid); err != nil {
				t.Fatal(err)
			}
		}
		db, err := Open(p)
		if err != nil {
			t.Fatal(err)
		}
		if db.Repaired() == 0 {
			t.Fatal("torn tail not reported")
		}
		db.Close()
		check(t, p+".repair")
	})
}
