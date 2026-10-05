//go:build !windows

package main

import (
	"fmt"
	"os"
	"os/user"
	"path/filepath"
	"strconv"
	"syscall"

	"github.com/aliasghar89/ferminux/validator/internal/service"
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

// checkRunUser refuses to run the sidecar as root in a data or network
// directory another user owns. Root's default data directory is the one
// install hands to the service user, so a plain `sudo fmx-validator run` (an
// obvious try when the service will not start) ran there as root: it started
// the node binary named in config.json, which the service user can rewrite,
// as root; it wrote its logs, last-error.txt, dashboard.addr and static peers
// by path, through any link that user had planted; and it left root-owned
// logs and node data that the service could not open at its next start.
// Every directory is checked as itself and, if it is a link, as what the link
// leads to. A missing one is fine: run makes it, as root's own.
func checkRunUser(dirs ...string) error {
	if os.Geteuid() != 0 {
		return nil
	}
	for _, d := range dirs {
		for _, stat := range []func(string) (os.FileInfo, error){os.Lstat, os.Stat} {
			st, err := stat(d)
			if err != nil {
				continue
			}
			if uid, _, ok := statOwner(st); ok && uid != 0 {
				name := "uid " + strconv.Itoa(uid)
				if u, err := user.LookupId(strconv.Itoa(uid)); err == nil {
					name = u.Username
				}
				return fmt.Errorf("refusing to run as root in %s, which belongs to %s: start the installed service (systemctl start %s) or run fmx-validator as that user", d, name, service.UnitName)
			}
		}
	}
	return nil
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
