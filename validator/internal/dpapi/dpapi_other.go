//go:build !windows

package dpapi

// Protect is unavailable off Windows.
func Protect(data []byte, purpose string) ([]byte, error) { return nil, ErrUnsupported }

// Unprotect is unavailable off Windows.
func Unprotect(blob []byte, purpose string) ([]byte, error) { return nil, ErrUnsupported }

// RestrictFile is unavailable off Windows.
func RestrictFile(path string) error { return ErrUnsupported }

// WriteProtected is unavailable off Windows.
func WriteProtected(path string, data []byte, purpose string) error { return ErrUnsupported }

// ReadProtected is unavailable off Windows.
func ReadProtected(path, purpose string) ([]byte, error) { return nil, ErrUnsupported }

// Supported reports whether DPAPI is available.
func Supported() bool { return false }

// RestrictDir is a no-op off Windows (directories are created 0700 there).
func RestrictDir(path string) error { return nil }

// SecureDataDir is a no-op off Windows (install creates the data directory as
// root with mode 0700 and hands it to the service user).
func SecureDataDir(path string) error { return nil }
