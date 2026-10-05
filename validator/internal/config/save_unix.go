//go:build !windows

package config

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"

	"golang.org/x/sys/unix"
)

// writeConfig puts b in dir/config.json without resolving dir by path more
// than once. install and sudo fmx-validator init run it as root in a directory
// the service user owns and can swap for a link while it runs. Lstat(dir)
// followed by CreateTemp(dir) and Rename(tmp, path) looked dir up three
// times, so a link swapped in after the check had root create a file in the
// link's target, give it to the service user and rename it over that
// directory's config.json. Here dir is opened once with O_NOFOLLOW, and the
// look at config.json, the create, the chown and the rename are all made
// relative to that descriptor.
func writeConfig(dir string, b []byte) error {
	dfd, err := unix.Open(dir, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	switch {
	case err == unix.ELOOP || err == unix.ENOTDIR || err == unix.EMLINK: // EMLINK: a link, on FreeBSD
		return fmt.Errorf("config: %s is a link or not a directory; refusing to write config.json through it", dir)
	case err != nil:
		return &os.PathError{Op: "open", Path: dir, Err: err}
	}
	defer unix.Close(dfd)
	var st unix.Stat_t
	if err := unix.Fstat(dfd, &st); err != nil {
		return &os.PathError{Op: "fstat", Path: dir, Err: err}
	}
	uid, gid := st.Uid, st.Gid // the directory's, unless there is a config.json to replace
	path := filepath.Join(dir, "config.json")
	switch err := unix.Fstatat(dfd, "config.json", &st, unix.AT_SYMLINK_NOFOLLOW); {
	case err == unix.ENOENT:
	case err != nil:
		return &os.PathError{Op: "lstat", Path: path, Err: err}
	case st.Mode&unix.S_IFMT != unix.S_IFREG:
		return fmt.Errorf("config: %s is a link or not a regular file; refusing to write through it", path)
	default:
		uid, gid = st.Uid, st.Gid
	}
	var r [8]byte
	if _, err := rand.Read(r[:]); err != nil {
		return err
	}
	tmp := ".config.json." + hex.EncodeToString(r[:])
	fd, err := unix.Openat(dfd, tmp, unix.O_WRONLY|unix.O_CREAT|unix.O_EXCL|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0o600)
	if err != nil {
		return &os.PathError{Op: "open", Path: filepath.Join(dir, tmp), Err: err}
	}
	f := os.NewFile(uintptr(fd), filepath.Join(dir, tmp))
	if _, err := f.Write(b); err != nil {
		f.Close()
		unix.Unlinkat(dfd, tmp, 0)
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		unix.Unlinkat(dfd, tmp, 0)
		return err
	}
	if err := keepOwner(f, uid, gid); err != nil {
		f.Close()
		unix.Unlinkat(dfd, tmp, 0)
		return err
	}
	if err := f.Close(); err != nil {
		unix.Unlinkat(dfd, tmp, 0)
		return err
	}
	if err := unix.Renameat(dfd, tmp, dfd, "config.json"); err != nil {
		unix.Unlinkat(dfd, tmp, 0)
		return &os.LinkError{Op: "rename", Old: filepath.Join(dir, tmp), New: path, Err: err}
	}
	return nil
}

// removeConfig unlinks dir/config.json relative to dir opened once with
// O_NOFOLLOW, for the reason writeConfig does: the service user can swap dir
// for a link at any time. A missing directory or file is not an error.
func removeConfig(dir string) error {
	dfd, err := unix.Open(dir, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	switch {
	case err == unix.ENOENT:
		return nil
	case err == unix.ELOOP || err == unix.ENOTDIR || err == unix.EMLINK: // EMLINK: a link, on FreeBSD
		return fmt.Errorf("config: %s is a link or not a directory; refusing to remove config.json through it", dir)
	case err != nil:
		return &os.PathError{Op: "open", Path: dir, Err: err}
	}
	defer unix.Close(dfd)
	if err := unix.Unlinkat(dfd, "config.json", 0); err != nil && err != unix.ENOENT {
		return &os.PathError{Op: "remove", Path: filepath.Join(dir, "config.json"), Err: err}
	}
	return nil
}

// keepOwner gives f, about to be renamed over config.json, the owner of the
// file it replaces, or of the directory when it replaces none. A renamed-in
// file belongs to whoever wrote it, so without this a Save run as root (sudo
// fmx-validator init, init --force, install --print, an install that stops
// before it hands the tree over) leaves the service user a config.json it
// cannot read, and the service fails at its next start. Only root can give a
// file away; anyone else keeps the file as their own. It chowns through the
// descriptor: chowning by name would act on whatever is there by then.
func keepOwner(f *os.File, uid, gid uint32) error {
	if os.Geteuid() != 0 {
		return nil
	}
	return f.Chown(int(uid), int(gid))
}
