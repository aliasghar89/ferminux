//go:build !windows

package config

import (
	"os"
	"syscall"
)

// keepOwner gives f, about to be renamed over config.json, the owner of the
// file it replaces, or of the directory when it replaces none. A renamed-in
// file belongs to whoever wrote it, so without this a Save run as root (sudo
// fmx-validator init, init --force, install --print, an install that stops
// before it hands the tree over) leaves the service user a config.json it
// cannot read, and the service fails at its next start. Only root can give a
// file away; anyone else keeps the file as their own.
func keepOwner(f *os.File, old os.FileInfo) error {
	st, ok := old.Sys().(*syscall.Stat_t)
	if !ok || os.Geteuid() != 0 {
		return nil
	}
	return f.Chown(int(st.Uid), int(st.Gid))
}
