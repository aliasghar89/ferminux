//go:build windows

package config

import "os"

// keepOwner: a Windows file takes its directory's ACL; there is no owner to keep.
func keepOwner(*os.File, os.FileInfo) error { return nil }
