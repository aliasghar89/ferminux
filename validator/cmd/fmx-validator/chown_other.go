//go:build !linux && !windows

package main

import "errors"

// chownTree: only a Linux install hands its tree to a service user, and the
// walk relies on O_PATH to check and chown each entry, a link included,
// through one descriptor.
func chownTree(string, int, int) error {
	return errors.New("only a Linux install hands its directory to a service user")
}
