//go:build windows

package main

import (
	"errors"
	"os"
)

// statOwner has no uid/gid on Windows.
func statOwner(os.FileInfo) (uid, gid int, ok bool) { return 0, 0, false }

// chownTree: only a Linux install hands its tree to a service user.
func chownTree(string, int, int) error { return errors.New("no file owners to set on Windows") }
