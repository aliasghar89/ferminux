//go:build !windows

package flock

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"syscall"

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
// refused.
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
	// O_NONBLOCK so that a FIFO put there is refused below instead of waited on
	fd, err := unix.Openat(dfd, name, unix.O_RDWR|unix.O_CREAT|unix.O_NOFOLLOW|unix.O_NONBLOCK|unix.O_CLOEXEC, 0o600)
	switch {
	case err == unix.ELOOP || err == unix.EMLINK:
		return nil, fmt.Errorf("%s is a link; refusing to lock through it", path)
	case err != nil:
		return nil, &os.PathError{Op: "open", Path: path, Err: err}
	}
	var st unix.Stat_t
	if err := unix.Fstat(fd, &st); err != nil {
		unix.Close(fd)
		return nil, &os.PathError{Op: "fstat", Path: path, Err: err}
	}
	if st.Mode&unix.S_IFMT != unix.S_IFREG {
		unix.Close(fd)
		return nil, fmt.Errorf("%s is not a regular file; refusing to lock it", path)
	}
	if err := unix.SetNonblock(fd, false); err != nil {
		unix.Close(fd)
		return nil, &os.PathError{Op: "fcntl", Path: path, Err: err}
	}
	return os.NewFile(uintptr(fd), path), nil
}

func lockFile(f *os.File) error {
	err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
	if errors.Is(err, syscall.EWOULDBLOCK) {
		return ErrLocked
	}
	return err
}

func unlockFile(f *os.File) error { return syscall.Flock(int(f.Fd()), syscall.LOCK_UN) }
