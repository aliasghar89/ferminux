//go:build windows

package main

import "os"

// statOwner has no uid/gid on Windows.
func statOwner(os.FileInfo) (uid, gid int, ok bool) { return 0, 0, false }
