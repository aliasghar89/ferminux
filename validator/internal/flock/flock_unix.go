//go:build !windows

package flock

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"syscall"

	"github.com/aliasghar89/ferminux/validator/internal/dirfd"
	"golang.org/x/sys/unix"
)

// openLockFile opens path for reading and writing, creating it 0600, without
// following a link at path or in place of its directory. Root takes locks in a
// network directory the service user owns: `sudo fmx-validator status` and the
// protection commands lock the slashing-protection database there. Opening
// by path followed a link that user planted at the lock's name, or where the
// directory was, and root then truncated the link's target and wrote its PID
// into it. Here the directory is opened once with O_NOFOLLOW, the lock is
// opened relative to it with O_NOFOLLOW, and anything but a regular file is
// refused. A lock root creates takes the directory's owner (dirfd.OpenFile):
// left root's 0600 file, it kept the service from ever opening its lock.
func openLockFile(path string) (*os.File, error) {
	dir, name := filepath.Dir(path), filepath.Base(path)
	dfd, err := unix.Open(dir, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	switch {
	case err == unix.ELOOP || err == unix.ENOTDIR || err == unix.EMLINK: // EMLINK: a link, on FreeBSD
		return nil, fmt.Errorf("%s is a link or not a directory; refusing to lock %s through it", dir, name)
	case err != nil:
		return nil, &os.PathError{Op: "open", Path: dir, Err: err}
	}
	defer unix.Close(dfd)
	return dirfd.OpenFile(dfd, dir, name, os.O_RDWR|os.O_CREATE)
}

func lockFile(f *os.File) error {
	err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
	if errors.Is(err, syscall.EWOULDBLOCK) {
		return ErrLocked
	}
	return err
}

func unlockFile(f *os.File) error { return syscall.Flock(int(f.Fd()), syscall.LOCK_UN) }
