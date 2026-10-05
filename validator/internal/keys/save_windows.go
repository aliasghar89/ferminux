//go:build windows

package keys

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/aliasghar89/ferminux/validator/internal/dpapi"
)

// saveKey writes the encrypted key and its network marker into dir, which it
// first restricts to SYSTEM and Administrators. The service runs as
// LocalSystem: no less privileged account owns the directory.
func saveKey(dir string, key, marker []byte) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	if err := dpapi.RestrictDir(dir); err != nil {
		return fmt.Errorf("restricting %s to SYSTEM and Administrators: %w", dir, err)
	}
	if err := writeFileAtomic(filepath.Join(dir, KeyFile), key); err != nil {
		return err
	}
	return writeFileAtomic(filepath.Join(dir, MarkerFile), marker)
}

func writeFileAtomic(path string, data []byte) error {
	tmp := path + ".tmp"
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	if _, err := f.Write(data); err != nil {
		f.Close()
		os.Remove(tmp)
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		os.Remove(tmp)
		return err
	}
	f.Close()
	return os.Rename(tmp, path)
}
