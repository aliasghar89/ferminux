//go:build !windows

package main

import (
	"os"
	"path/filepath"
	"syscall"

	"golang.org/x/sys/unix"
)

// statOwner returns a file's owner uid and gid.
func statOwner(st os.FileInfo) (uid, gid int, ok bool) {
	s, ok := st.Sys().(*syscall.Stat_t)
	if !ok {
		return 0, 0, false
	}
	return int(s.Uid), int(s.Gid), true
}

// chownTree gives root and everything under it to uid:gid without resolving a
// path through the tree. install runs it as root over a directory the service
// user owns and can change while it runs. filepath.WalkDir re-opened each
// directory by path, so a directory replaced by a link after its parent was
// listed was entered, and what the link pointed at was chowned too. Here each
// directory is opened relative to its parent's descriptor with O_NOFOLLOW and
// each entry chowned relative to it without following a link: a link is
// chowned as itself and never entered.
func chownTree(root string, uid, gid int) error {
	fd, err := unix.Open(root, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return &os.PathError{Op: "open", Path: root, Err: err}
	}
	return chownDirAt(fd, root, uid, gid)
}

// chownDirAt chowns the directory open at fd and everything in it, then
// closes fd. path is only for error messages.
func chownDirAt(fd int, path string, uid, gid int) error {
	dir := os.NewFile(uintptr(fd), path)
	defer dir.Close()
	if err := unix.Fchown(fd, uid, gid); err != nil {
		return &os.PathError{Op: "chown", Path: path, Err: err}
	}
	names, err := dir.Readdirnames(-1)
	if err != nil {
		return err
	}
	for _, name := range names {
		p := filepath.Join(path, name)
		if err := unix.Fchownat(fd, name, uid, gid, unix.AT_SYMLINK_NOFOLLOW); err != nil {
			return &os.PathError{Op: "lchown", Path: p, Err: err}
		}
		sub, err := unix.Openat(fd, name, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
		switch {
		case err == unix.ENOTDIR || err == unix.ELOOP || err == unix.EMLINK:
			continue // not a directory, or a link (EMLINK on FreeBSD): chowned above, not entered
		case err != nil:
			return &os.PathError{Op: "open", Path: p, Err: err}
		}
		if err := chownDirAt(sub, p, uid, gid); err != nil {
			return err
		}
	}
	return nil
}
