//go:build linux

package config

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

// On an installed node the service user owns the data directory, so while
// root saves (sudo fmx-validator init --force) it can keep swapping its
// network directory with a link to a directory root trusts. Save must write
// into the directory it checked, or refuse; a checked directory that was
// resolved by path again for the create and the rename had root put a
// config.json in the link's target and give it to the service user.
func TestSaveNeverWritesThroughASwappedDirectory(t *testing.T) {
	dd := t.TempDir()
	dir := NetworkDir(dd, "devnet")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	target := t.TempDir() // stands in for a root-only directory
	link := filepath.Join(dd, "swap")
	if err := os.Symlink(target, link); err != nil {
		t.Skipf("symlinks unavailable here: %v", err)
	}
	if err := unix.Renameat2(unix.AT_FDCWD, dir, unix.AT_FDCWD, link, unix.RENAME_EXCHANGE); err != nil {
		t.Skipf("RENAME_EXCHANGE unavailable here: %v", err)
	}
	if runtime.GOMAXPROCS(0) < 2 { // the swapper has to run while Save does
		defer runtime.GOMAXPROCS(runtime.GOMAXPROCS(2))
	}
	stop, stopped := make(chan struct{}), make(chan struct{})
	go func() {
		defer close(stopped)
		for {
			select {
			case <-stop:
				return
			default:
				unix.Renameat2(unix.AT_FDCWD, dir, unix.AT_FDCWD, link, unix.RENAME_EXCHANGE)
			}
		}
	}()
	defer func() { close(stop); <-stopped }()

	saved := 0
	deadline := time.Now().Add(3 * time.Second)
	for i := 1; i <= 3000 && time.Now().Before(deadline); i++ {
		// refused while the link is in place, which is right
		if Save(dir, base()) == nil {
			saved++
		}
		entries, err := os.ReadDir(target)
		if err != nil {
			t.Fatal(err)
		}
		if len(entries) > 0 {
			t.Fatalf("attempt %d: Save wrote %s into the link's target", i, entries[0].Name())
		}
	}
	if saved == 0 {
		t.Fatal("no Save succeeded while the directory was being swapped")
	}
}
