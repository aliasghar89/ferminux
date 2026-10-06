//go:build !windows

package dirfd

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/sys/unix"
)

// install's createIn removes a planted file and then creates the password
// copy with O_EXCL, so that one put back in between is refused rather than
// written through: OpenFile must keep that meaning of os.O_EXCL even though
// it tries O_EXCL itself and falls back to the file already there.
func TestOpenFileKeepsExclusiveCreate(t *testing.T) {
	dir := t.TempDir()
	const text = "already there\n"
	if err := os.WriteFile(filepath.Join(dir, "x"), []byte(text), 0o600); err != nil {
		t.Fatal(err)
	}
	dfd, err := unix.Open(dir, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer unix.Close(dfd)
	if f, err := OpenFile(dfd, dir, "x", os.O_WRONLY|os.O_CREATE|os.O_EXCL|os.O_TRUNC); err == nil || !errors.Is(err, os.ErrExist) {
		if err == nil {
			f.Close()
		}
		t.Fatalf("O_EXCL on an existing file: %v, want it refused", err)
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "x")); string(b) != text {
		t.Fatalf("the existing file was changed: %q", b)
	}
	f, err := OpenFile(dfd, dir, "x", os.O_WRONLY|os.O_CREATE|os.O_TRUNC)
	if err != nil {
		t.Fatalf("without O_EXCL the existing file is opened: %v", err)
	}
	f.Close()
	if b, _ := os.ReadFile(filepath.Join(dir, "x")); len(b) != 0 {
		t.Fatalf("O_TRUNC not applied: %q", b)
	}
}
