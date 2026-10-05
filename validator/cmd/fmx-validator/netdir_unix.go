//go:build !windows

package main

import (
	"fmt"
	"os"
	"path/filepath"

	"golang.org/x/sys/unix"
)

// createIn puts data in dir/name as a new 0600 file, removing whatever was
// there first. install runs it as root in a network directory the service user
// owns, after Save has checked that directory, and the user can put a link
// where the directory was in between. unlink(2) and open(2) by path follow a
// link in any component but the last, and O_EXCL refuses one only there, so
// root deleted and created the file in the link's target. Here dir is opened
// once with O_NOFOLLOW and the remove and the create are relative to it.
func createIn(dir, name string, data []byte) error {
	dfd, err := openDirNoFollow(dir, "write "+name)
	if err != nil {
		return err
	}
	defer unix.Close(dfd)
	path := filepath.Join(dir, name)
	if err := unix.Unlinkat(dfd, name, 0); err != nil && err != unix.ENOENT {
		return &os.PathError{Op: "remove", Path: path, Err: err}
	}
	fd, err := unix.Openat(dfd, name, unix.O_WRONLY|unix.O_CREAT|unix.O_EXCL|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0o600)
	if err != nil {
		return &os.PathError{Op: "open", Path: path, Err: err}
	}
	f := os.NewFile(uintptr(fd), path)
	if _, err := f.Write(data); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}

// removeIn unlinks dir/name relative to dir opened once with O_NOFOLLOW, for
// the reason createIn does.
func removeIn(dir, name string) error {
	dfd, err := openDirNoFollow(dir, "remove "+name)
	if err != nil {
		return err
	}
	defer unix.Close(dfd)
	if err := unix.Unlinkat(dfd, name, 0); err != nil {
		return &os.PathError{Op: "remove", Path: filepath.Join(dir, name), Err: err}
	}
	return nil
}

func openDirNoFollow(dir, what string) (int, error) {
	dfd, err := unix.Open(dir, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	switch {
	case err == unix.ELOOP || err == unix.ENOTDIR || err == unix.EMLINK: // EMLINK: a link, on FreeBSD
		return -1, fmt.Errorf("%s is a link or not a directory; refusing to %s through it", dir, what)
	case err != nil:
		return -1, &os.PathError{Op: "open", Path: dir, Err: err}
	}
	return dfd, nil
}
