//go:build !windows

package keys

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"

	"golang.org/x/sys/unix"
)

// saveKey writes the encrypted key and its network marker into dir without
// resolving a path inside the network directory more than once. `sudo
// fmx-validator keys new` and `keys import`, and install.sh re-run on a data
// directory with no key, run it as root in a network directory the service
// user owns. Opening <dir>/attester.json.tmp by path with O_TRUNC followed a
// link that user planted there: root truncated and overwrote the link's
// target, and the rename then made attester.json that link. Here the network
// directory and dir are each opened once with O_NOFOLLOW, and the look at
// attester.json, the creates and the renames are all relative to dir's
// descriptor; each file is created O_EXCL under a fresh name, so nothing
// already in the directory is written through.
func saveKey(dir string, key, marker []byte) error {
	dfd, err := openKeysDir(dir)
	if err != nil {
		return err
	}
	defer unix.Close(dfd)
	var st unix.Stat_t
	if err := unix.Fstat(dfd, &st); err != nil {
		return &os.PathError{Op: "fstat", Path: dir, Err: err}
	}
	uid, gid := st.Uid, st.Gid // the key files take the keys directory's owner
	switch err := unix.Fstatat(dfd, KeyFile, &st, unix.AT_SYMLINK_NOFOLLOW); {
	case err == nil:
		return fmt.Errorf("%s already exists; refusing to overwrite an attester key", filepath.Join(dir, KeyFile))
	case err != unix.ENOENT:
		return &os.PathError{Op: "lstat", Path: filepath.Join(dir, KeyFile), Err: err}
	}
	if err := writeAt(dfd, dir, KeyFile, key, uid, gid); err != nil {
		return err
	}
	return writeAt(dfd, dir, MarkerFile, marker, uid, gid)
}

// openKeysDir opens dir, making it (0700) when it is missing, and refuses a
// link in place of dir or of its parent, the network directory: the service
// user owns the network directory and can put a link in either place at any
// time. A keys directory it makes takes the network directory's owner.
func openKeysDir(dir string) (int, error) {
	parent, name := filepath.Dir(dir), filepath.Base(dir)
	if err := os.MkdirAll(parent, 0o700); err != nil {
		return -1, err
	}
	pfd, err := openDirAt(unix.AT_FDCWD, parent, parent)
	if err != nil {
		return -1, err
	}
	defer unix.Close(pfd)
	made := true
	if err := unix.Mkdirat(pfd, name, 0o700); err == unix.EEXIST {
		made = false
	} else if err != nil {
		return -1, &os.PathError{Op: "mkdir", Path: dir, Err: err}
	}
	dfd, err := openDirAt(pfd, name, dir)
	if err != nil || !made {
		return dfd, err
	}
	var st unix.Stat_t
	if err := unix.Fstat(pfd, &st); err != nil {
		unix.Close(dfd)
		return -1, &os.PathError{Op: "fstat", Path: parent, Err: err}
	}
	if err := keepOwner(dfd, st.Uid, st.Gid); err != nil {
		unix.Close(dfd)
		return -1, &os.PathError{Op: "chown", Path: dir, Err: err}
	}
	return dfd, nil
}

// keepOwner gives what is open at fd, a keys directory or key file this
// process created, the owner of the directory it was created in. A new file
// belongs to whoever creates it, and only install's hand-over of the tree
// gave the key to the service user, so `sudo fmx-validator keys import` (or
// keys new) on an installed node left a root-owned keys directory or 0600 key
// in the service user's network directory: the service could not read its
// own attester key. Only root can give a file away; anyone else keeps the
// file as their own. It chowns through the descriptor: chowning by name would
// act on whatever is there by then.
func keepOwner(fd int, uid, gid uint32) error {
	if os.Geteuid() != 0 {
		return nil
	}
	return unix.Fchown(fd, int(uid), int(gid))
}

// openDirAt opens the directory name relative to at without following a link
// in its place. path is only for error messages.
func openDirAt(at int, name, path string) (int, error) {
	fd, err := unix.Openat(at, name, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	switch {
	case err == unix.ELOOP || err == unix.ENOTDIR || err == unix.EMLINK: // EMLINK: a link, on FreeBSD
		return -1, fmt.Errorf("%s is a link or not a directory; refusing to write the attester key through it", path)
	case err != nil:
		return -1, &os.PathError{Op: "open", Path: path, Err: err}
	}
	return fd, nil
}

// writeAt puts data in name, in the directory open at dfd: a new 0600 file
// made O_EXCL under a random name, given uid:gid (see keepOwner), synced, then
// renamed over name.
func writeAt(dfd int, dir, name string, data []byte, uid, gid uint32) error {
	var r [8]byte
	if _, err := rand.Read(r[:]); err != nil {
		return err
	}
	tmp := "." + name + "." + hex.EncodeToString(r[:])
	fd, err := unix.Openat(dfd, tmp, unix.O_WRONLY|unix.O_CREAT|unix.O_EXCL|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0o600)
	if err != nil {
		return &os.PathError{Op: "open", Path: filepath.Join(dir, tmp), Err: err}
	}
	f := os.NewFile(uintptr(fd), filepath.Join(dir, tmp))
	if err := keepOwner(fd, uid, gid); err != nil {
		f.Close()
		unix.Unlinkat(dfd, tmp, 0)
		return &os.PathError{Op: "chown", Path: filepath.Join(dir, tmp), Err: err}
	}
	if _, err := f.Write(data); err != nil {
		f.Close()
		unix.Unlinkat(dfd, tmp, 0)
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		unix.Unlinkat(dfd, tmp, 0)
		return err
	}
	if err := f.Close(); err != nil {
		unix.Unlinkat(dfd, tmp, 0)
		return err
	}
	if err := unix.Renameat(dfd, tmp, dfd, name); err != nil {
		unix.Unlinkat(dfd, tmp, 0)
		return &os.LinkError{Op: "rename", Old: filepath.Join(dir, tmp), New: filepath.Join(dir, name), Err: err}
	}
	return nil
}
