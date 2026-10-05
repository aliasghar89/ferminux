//go:build !windows

package flock

import (
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

// Root takes locks in directories the service user owns (the slashing-
// protection database's, under `sudo fmx-validator status`). Opening the lock
// by path followed a link planted there, and the PID was written over the
// link's target.
func TestAcquireNeverWritesThroughALink(t *testing.T) {
	const victimText = "a file only root may change\n"
	t.Run("file", func(t *testing.T) {
		dir := t.TempDir()
		victim := filepath.Join(t.TempDir(), "victim")
		if err := os.WriteFile(victim, []byte(victimText), 0o644); err != nil {
			t.Fatal(err)
		}
		p := filepath.Join(dir, "x.lock")
		if err := os.Symlink(victim, p); err != nil {
			t.Skipf("symlinks unavailable here: %v", err)
		}
		l, err := Acquire(p)
		if err == nil {
			l.Release()
		}
		if b, rerr := os.ReadFile(victim); rerr != nil || string(b) != victimText {
			t.Fatalf("Acquire wrote through the link: %q %v", b, rerr)
		}
		if err == nil {
			t.Fatal("Acquire accepted a link")
		}
	})
	t.Run("directory", func(t *testing.T) {
		dd := t.TempDir()
		target := t.TempDir() // stands in for a directory only root may change
		if err := os.Symlink(target, filepath.Join(dd, "devnet")); err != nil {
			t.Skipf("symlinks unavailable here: %v", err)
		}
		if l, err := Acquire(filepath.Join(dd, "devnet", "x.lock")); err == nil {
			l.Release()
			t.Fatal("Acquire went through a linked directory")
		}
		if entries, _ := os.ReadDir(target); len(entries) != 0 {
			t.Fatalf("files created in the link's target: %v", entries)
		}
	})
}

// `sudo fmx-validator protection import` (or show, or export) on a node whose
// service had not opened its database yet created protection.log.lock as
// root's 0600 file in the network directory the service user owns: the
// service could never open its lock again.
func TestAcquireGivesANewLockTheDirectoryOwner(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("only root can give a file to another user")
	}
	const uid, gid = 65534, 65534
	owner := func(p string) (uint32, uint32, os.FileMode) {
		t.Helper()
		fi, err := os.Lstat(p)
		if err != nil {
			t.Fatal(err)
		}
		st := fi.Sys().(*syscall.Stat_t)
		return st.Uid, st.Gid, fi.Mode().Perm()
	}
	dir := t.TempDir()
	if err := os.Chown(dir, uid, gid); err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(dir, "x.lock")
	l, err := Acquire(p)
	if err != nil {
		t.Fatal(err)
	}
	l.Release()
	if u, g, m := owner(p); u != uid || g != gid || m != 0o600 {
		t.Fatalf("new lock is %d:%d %v, want its directory's %d:%d 0600", u, g, m, uid, gid)
	}
	// only a lock Acquire made is given away, never one already there
	mine := filepath.Join(dir, "mine.lock")
	if err := os.WriteFile(mine, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if l, err = Acquire(mine); err != nil {
		t.Fatal(err)
	}
	l.Release()
	if u, g, _ := owner(mine); u != 0 || g != 0 {
		t.Fatalf("a lock that was already there was given to %d:%d", u, g)
	}
}
