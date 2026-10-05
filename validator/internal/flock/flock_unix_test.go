//go:build !windows

package flock

import (
	"os"
	"path/filepath"
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
