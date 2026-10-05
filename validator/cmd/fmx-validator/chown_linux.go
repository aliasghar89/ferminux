//go:build linux

package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

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
//
// An entry chownEntryAt refuses does not stop the walk, and the error names
// every one. An earlier release's `sudo fmx-validator run` left root-owned
// logs and chain data in the service user's directories, often many files in
// chaindata alone, and install.sh stops the service before it runs install.
// Stopping at the first, install named one file per run, and an upgrade took
// as many failed runs as there were files.
func chownTree(root string, uid, gid int) error {
	fd, err := unix.Open(root, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return &os.PathError{Op: "open", Path: root, Err: err}
	}
	var refused []string
	if err := chownDirAt(fd, root, uid, gid, &refused); err != nil {
		return err
	}
	if len(refused) == 0 {
		return nil
	}
	list, more := refused, ""
	if len(list) > refusedShown {
		list = list[:refusedShown]
		more = fmt.Sprintf("\n  and %d more (find %s ! -type d ! -user %d -ls lists them all)", len(refused)-refusedShown, root, uid)
	}
	return fmt.Errorf("refusing to give away what belongs neither to the service user nor to the owner of its directory: each may be a file from elsewhere linked in, its other name since replaced (rm removes only that name). The root-owned logs and chain data a `sudo fmx-validator run` of an earlier release left look the same. Chown each yourself (chown -h, which never follows a link) only once you know what it is, then run install again:\n  %s%s", strings.Join(list, "\n  "), more)
}

// refusedShown caps the entries chownTree's error lists: a node run as root
// writes chain data files by the thousand.
const refusedShown = 20

// chownDirAt chowns everything in the directory open at fd, then the
// directory, then closes fd. path is only for error messages; an entry
// refused is added to refused.
//
// The directory is handed over after what is in it, not before: its owner is
// what chownEntryAt trusts with links, and a directory root still owns
// cannot gain an entry from the service user while it is being walked. One
// with a refused entry anywhere under it is not handed over at all, as when
// the walk stopped at the first: that waits for the install after the
// operator has dealt with the entry.
func chownDirAt(fd int, path string, uid, gid int, refused *[]string) error {
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
	before := len(*refused)
	for _, name := range names {
		if err := chownEntryAt(fd, path, name, st.Uid, uid, gid, refused); err != nil {
			return err
		}
	}
	if len(*refused) > before {
		return nil
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
// look at: it is added to refused, which chownTree reports in full once the
// rest of the tree is done.
//
// The entry is opened O_PATH|O_NOFOLLOW (which opens a link as itself, and
// reads, runs or blocks on nothing) and checked and chowned through that
// descriptor: by name, the user could swap what is there between the check
// and the chown.
func chownEntryAt(dfd int, dir, name string, dirOwner uint32, uid, gid int, refused *[]string) error {
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
		return chownDirAt(sub, path, uid, gid, refused)
	}
	defer unix.Close(fd)
	if st.Uid != uint32(uid) && st.Uid != dirOwner {
		*refused = append(*refused, fmt.Sprintf("%s (uid %d)", path, st.Uid))
		return nil
	}
	// an O_PATH descriptor cannot be fchown(2)ed; AT_EMPTY_PATH chowns it
	if err := unix.Fchownat(fd, "", uid, gid, unix.AT_EMPTY_PATH|unix.AT_SYMLINK_NOFOLLOW); err != nil {
		return &os.PathError{Op: "chown", Path: path, Err: err}
	}
	return nil
}
