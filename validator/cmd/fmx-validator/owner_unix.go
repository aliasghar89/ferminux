//go:build !windows

package main

import (
	"fmt"
	"os"
	"os/user"
	"strconv"
	"syscall"

	"github.com/aliasghar89/ferminux/validator/internal/service"
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
