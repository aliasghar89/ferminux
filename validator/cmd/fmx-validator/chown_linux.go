//go:build linux

package main

import (
	"fmt"
	"os"
	"path/filepath"

	"golang.org/x/sys/unix"
)

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

// chownDirAt chowns everything in the directory open at fd, then the
// directory, then closes fd. path is only for error messages.
//
// The directory is handed over after what is in it, not before: its owner is
// what chownEntryAt trusts with links, and a directory root still owns
// cannot gain an entry from the service user while it is being walked.
func chownDirAt(fd int, path string, uid, gid int) error {
	dir := os.NewFile(uintptr(fd), path)
	defer dir.Close()
	var st unix.Stat_t
	if err := unix.Fstat(fd, &st); err != nil {
		return &os.PathError{Op: "fstat", Path: path, Err: err}
	}
	names, err := dir.Readdirnames(-1)
	if err != nil {
		return err
	}
	for _, name := range names {
		if err := chownEntryAt(fd, path, name, st.Uid, uid, gid); err != nil {
			return err
		}
	}
	if err := unix.Fchown(fd, uid, gid); err != nil {
		return &os.PathError{Op: "chown", Path: path, Err: err}
	}
	return nil
}

// chownEntryAt chowns name in the directory open at dfd, which dirOwner owned
// before the walk, entering it if it is a directory.
//
// A hard link is the file itself, wherever its other names are: where
// fs.protected_hardlinks is off the service user can link any file on its
// filesystem into the directory it owns, and chowning that name gave the user
// /etc/shadow or a binary root runs. AT_SYMLINK_NOFOLLOW stops only a symlink.
// The link count does not tell such a file apart: once its outside name is
// replaced (passwd renames a new /etc/shadow over the old one) the inode the
// user linked in has one link and looks like a file root made there itself.
// So an entry that belongs neither to uid nor to the directory's owner is
// refused, whatever its link count. Nothing root writes into the tree is left
// that way: config.json, keys, the protection files and the password copy all
// take their directory's owner, and run refuses root there. A file an earlier
// `sudo fmx-validator run` left is refused like the rest, for the operator to
// look at.
//
// The entry is opened O_PATH|O_NOFOLLOW (which opens a link as itself, and
// reads, runs or blocks on nothing) and checked and chowned through that
// descriptor: by name, the user could swap what is there between the check
// and the chown.
func chownEntryAt(dfd int, dir, name string, dirOwner uint32, uid, gid int) error {
	path := filepath.Join(dir, name)
	fd, err := unix.Openat(dfd, name, unix.O_PATH|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return &os.PathError{Op: "open", Path: path, Err: err}
	}
	var st unix.Stat_t
	if err := unix.Fstat(fd, &st); err != nil {
		unix.Close(fd)
		return &os.PathError{Op: "fstat", Path: path, Err: err}
	}
	if st.Mode&unix.S_IFMT == unix.S_IFDIR {
		// "." of the descriptor: the directory just checked, not what is at name now
		sub, err := unix.Openat(fd, ".", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
		unix.Close(fd)
		if err != nil {
			return &os.PathError{Op: "open", Path: path, Err: err}
		}
		return chownDirAt(sub, path, uid, gid)
	}
	defer unix.Close(fd)
	if st.Uid != uint32(uid) && st.Uid != dirOwner {
		return fmt.Errorf("%s belongs to uid %d, neither to the service user nor to the owner of %s; refusing to give it away: it may be a file from elsewhere linked in, its other name since replaced (rm removes only that name; chown it yourself only once you know what it is)", path, st.Uid, dir)
	}
	// an O_PATH descriptor cannot be fchown(2)ed; AT_EMPTY_PATH chowns it
	if err := unix.Fchownat(fd, "", uid, gid, unix.AT_EMPTY_PATH|unix.AT_SYMLINK_NOFOLLOW); err != nil {
		return &os.PathError{Op: "chown", Path: path, Err: err}
	}
	return nil
}
