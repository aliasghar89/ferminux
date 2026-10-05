//go:build !windows

package protect

import (
	"fmt"
	"io"
	"os"
	"path/filepath"

	"github.com/aliasghar89/ferminux/validator/internal/dirfd"
	"golang.org/x/sys/unix"
)

// dbDir is the database's directory, opened once with O_NOFOLLOW; the
// database's files are opened and removed relative to it, never by path.
// `sudo fmx-validator status` and the protection commands open the database as
// root in a network directory the service user owns, and that user can put a
// link at protection.log or protection.log.repair, or where the directory
// was. Opening them by path had root cut protection.log's torn tail, and
// truncate and write the repair marker, in the link's target. A link at a
// name, or in place of the directory, is refused, and so is anything but a
// regular file. A file root creates there takes the directory's owner, so the
// service can still open it (dirfd.OpenFile).
type dbDir struct {
	fd   int
	path string
}

func openDBDir(path string) (*dbDir, error) {
	fd, err := unix.Open(path, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	switch {
	case err == unix.ELOOP || err == unix.ENOTDIR || err == unix.EMLINK: // EMLINK: a link, on FreeBSD
		return nil, fmt.Errorf("%s is a link or not a directory; refusing to open the slashing protection database through it", path)
	case err != nil:
		return nil, &os.PathError{Op: "open", Path: path, Err: err}
	}
	return &dbDir{fd: fd, path: path}, nil
}

// open opens name with flag, creating it 0600, with the directory's owner,
// when flag says so.
func (d *dbDir) open(name string, flag int) (*os.File, error) {
	return dirfd.OpenFile(d.fd, d.path, name, flag)
}

func (d *dbDir) readFile(name string) ([]byte, error) {
	f, err := d.open(name, os.O_RDONLY)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return io.ReadAll(f)
}

func (d *dbDir) remove(name string) error {
	if err := unix.Unlinkat(d.fd, name, 0); err != nil {
		return &os.PathError{Op: "remove", Path: filepath.Join(d.path, name), Err: err}
	}
	return nil
}

// sync makes a newly created or removed file's directory entry durable.
func (d *dbDir) sync() { _ = unix.Fsync(d.fd) }

func (d *dbDir) close() { unix.Close(d.fd) }
