//go:build windows

package main

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
)

// createIn puts data in dir/name as a new file, removing whatever was there
// first, and refuses a link in place of dir.
func createIn(dir, name string, data []byte) error {
	if err := checkNoLink(dir, "write "+name); err != nil {
		return err
	}
	path := filepath.Join(dir, name)
	if err := os.Remove(path); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	if _, err := f.Write(data); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}

// removeIn deletes dir/name, refusing a link in place of dir.
func removeIn(dir, name string) error {
	if err := checkNoLink(dir, "remove "+name); err != nil {
		return err
	}
	return os.Remove(filepath.Join(dir, name))
}

func checkNoLink(dir, what string) error {
	st, err := os.Lstat(dir)
	if err != nil {
		return err
	}
	if !st.IsDir() {
		return fmt.Errorf("%s is a link or not a directory; refusing to %s through it", dir, what)
	}
	return nil
}
