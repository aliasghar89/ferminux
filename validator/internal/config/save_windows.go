//go:build windows

package config

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
)

// writeConfig puts b in dir/config.json. A Windows file takes its directory's
// ACL; there is no owner to keep.
func writeConfig(dir string, b []byte) error {
	dirInfo, err := os.Lstat(dir)
	if err != nil {
		return err
	}
	if !dirInfo.IsDir() {
		return fmt.Errorf("config: %s is a link or not a directory; refusing to write config.json through it", dir)
	}
	path := filepath.Join(dir, "config.json")
	old, err := os.Lstat(path)
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	if err == nil && !old.Mode().IsRegular() {
		return fmt.Errorf("config: %s is a link or not a regular file; refusing to write through it", path)
	}
	f, err := os.CreateTemp(dir, ".config.json.*") // O_EXCL, mode 0600
	if err != nil {
		return err
	}
	tmp := f.Name()
	if _, err := f.Write(b); err != nil {
		f.Close()
		os.Remove(tmp)
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		os.Remove(tmp)
		return err
	}
	if err := f.Close(); err != nil {
		os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		os.Remove(tmp)
		return err
	}
	return nil
}
