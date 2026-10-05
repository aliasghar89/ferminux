//go:build windows

package protect

import (
	"os"
	"path/filepath"
)

// dbDir is the database's directory. Its files are opened by path: the Windows
// data directory is SYSTEM and Administrators only, so no less privileged
// account can put a link in it.
type dbDir struct{ path string }

func openDBDir(path string) (*dbDir, error) { return &dbDir{path: path}, nil }

// open opens name with flag, creating it 0600 when flag says so.
func (d *dbDir) open(name string, flag int) (*os.File, error) {
	return os.OpenFile(filepath.Join(d.path, name), flag, 0o600)
}

func (d *dbDir) readFile(name string) ([]byte, error) {
	return os.ReadFile(filepath.Join(d.path, name))
}

func (d *dbDir) remove(name string) error { return os.Remove(filepath.Join(d.path, name)) }

// sync makes a newly created or removed file's directory entry durable, where
// a directory can be fsynced.
func (d *dbDir) sync() {
	f, err := os.Open(d.path)
	if err != nil {
		return
	}
	_ = f.Sync()
	f.Close()
}

func (d *dbDir) close() {}
