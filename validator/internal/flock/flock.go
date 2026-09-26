// Package flock takes an exclusive, non-blocking, whole-file OS lock. The lock
// dies with the process (the kernel releases it), so a crash never leaves a
// stale lock behind, while a second process on the same machine is refused.
package flock

import (
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
)

// ErrLocked is returned when another process holds the lock.
var ErrLocked = errors.New("already locked by another process")

// Lock is a held lock.
type Lock struct {
	f    *os.File
	path string
}

// Acquire locks path (creating it with mode 0600) and writes this process's
// PID into it for diagnostics.
func Acquire(path string) (*Lock, error) {
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		return nil, err
	}
	if err := lockFile(f); err != nil {
		holder := ""
		if b, rerr := os.ReadFile(path); rerr == nil {
			holder = strings.TrimSpace(string(b))
		}
		f.Close()
		if errors.Is(err, ErrLocked) {
			if holder != "" {
				return nil, fmt.Errorf("%s: %w (pid %s)", path, ErrLocked, holder)
			}
			return nil, fmt.Errorf("%s: %w", path, ErrLocked)
		}
		return nil, fmt.Errorf("lock %s: %w", path, err)
	}
	// Best effort: record the holder's PID. The lock, not the content, is authoritative.
	if err := f.Truncate(0); err == nil {
		_, _ = f.WriteAt([]byte(strconv.Itoa(os.Getpid())+"\n"), 0)
	}
	return &Lock{f: f, path: path}, nil
}

// Release unlocks and closes. The file is left in place (removing it would race
// with a concurrent Acquire that already opened it).
func (l *Lock) Release() error {
	if l == nil || l.f == nil {
		return nil
	}
	_ = unlockFile(l.f)
	err := l.f.Close()
	l.f = nil
	return err
}

// Path is the lock file's path.
func (l *Lock) Path() string { return l.path }
