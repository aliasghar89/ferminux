//go:build !windows

// Package dirfd opens files relative to a directory that was opened once,
// without following a link in its place, for code that runs as root in a
// directory another user owns: `sudo fmx-validator status` and the
// protection commands lock and open the slashing-protection database in the
// network directory the service user owns. Windows opens these files by path:
// its data directory is SYSTEM and Administrators only.
package dirfd

import (
	"fmt"
	"os"
	"path/filepath"

	"golang.org/x/sys/unix"
)

// OpenFile opens name in the directory open at dfd with flag (os.O_*). dir is
// that directory's path, for messages.
//
// A link at name is refused, and so is anything but a regular file (it is
// opened O_NONBLOCK, so a FIFO put there is refused instead of waited on).
//
// With os.O_CREATE, a file this call creates is given the directory's owner.
// A new file belongs to whoever creates it, so a database root opened first
// (`sudo fmx-validator protection import` before the service had ever opened
// it, or `sudo fmx-validator status` cutting a torn record) left the service
// user a root-owned 0600 protection.log, protection.log.lock or
// protection.log.repair it could not open: the service never signed again
// until someone chowned them by hand. The file is made O_EXCL first, so only
// a file this call made is given away, never one already there.
func OpenFile(dfd int, dir, name string, flag int) (*os.File, error) {
	path := filepath.Join(dir, name)
	flag |= unix.O_NOFOLLOW | unix.O_NONBLOCK | unix.O_CLOEXEC
	created := false
	var fd int
	var err error
	if flag&unix.O_CREAT != 0 {
		// O_CREAT|O_EXCL never follows a link at name either: EEXIST
		fd, err = unix.Openat(dfd, name, flag|unix.O_EXCL, 0o600)
		created = err == nil
		if err == unix.EEXIST {
			fd, err = unix.Openat(dfd, name, flag&^unix.O_CREAT, 0)
		}
	} else {
		fd, err = unix.Openat(dfd, name, flag, 0)
	}
	switch {
	case err == unix.ELOOP || err == unix.EMLINK: // EMLINK: a link, on FreeBSD
		return nil, fmt.Errorf("%s is a link; refusing to open it", path)
	case err != nil:
		return nil, &os.PathError{Op: "open", Path: path, Err: err}
	}
	fail := func(err error) (*os.File, error) {
		unix.Close(fd)
		return nil, err
	}
	var st unix.Stat_t
	if err := unix.Fstat(fd, &st); err != nil {
		return fail(&os.PathError{Op: "fstat", Path: path, Err: err})
	}
	if st.Mode&unix.S_IFMT != unix.S_IFREG {
		return fail(fmt.Errorf("%s is not a regular file; refusing to open it", path))
	}
	if created {
		var dst unix.Stat_t
		if err := unix.Fstat(dfd, &dst); err != nil {
			return fail(&os.PathError{Op: "fstat", Path: dir, Err: err})
		}
		if err := keepOwner(fd, dst.Uid, dst.Gid); err != nil {
			return fail(&os.PathError{Op: "chown", Path: path, Err: err})
		}
	}
	if err := unix.SetNonblock(fd, false); err != nil {
		return fail(&os.PathError{Op: "fcntl", Path: path, Err: err})
	}
	return os.NewFile(uintptr(fd), path), nil
}

// keepOwner gives what is open at fd, a file OpenFile created, uid:gid, the
// owner of the directory it was created in. Only root can give a file away;
// anyone else keeps the file as their own. It chowns through the descriptor:
// chowning by name would act on whatever is there by then.
func keepOwner(fd int, uid, gid uint32) error {
	if os.Geteuid() != 0 {
		return nil
	}
	return unix.Fchown(fd, int(uid), int(gid))
}
