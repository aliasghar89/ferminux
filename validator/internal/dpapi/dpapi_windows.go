//go:build windows

package dpapi

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Protect encrypts data with machine-scope DPAPI.
func Protect(data []byte, purpose string) ([]byte, error) {
	if len(data) == 0 {
		return nil, fmt.Errorf("dpapi: nothing to protect")
	}
	ent := entropy(purpose)
	in := windows.DataBlob{Size: uint32(len(data)), Data: &data[0]}
	eb := windows.DataBlob{Size: uint32(len(ent)), Data: &ent[0]}
	var out windows.DataBlob
	flags := uint32(windows.CRYPTPROTECT_UI_FORBIDDEN | windows.CRYPTPROTECT_LOCAL_MACHINE)
	if err := windows.CryptProtectData(&in, nil, &eb, 0, nil, flags, &out); err != nil {
		return nil, fmt.Errorf("dpapi: CryptProtectData: %w", err)
	}
	defer windows.LocalFree(windows.Handle(unsafe.Pointer(out.Data)))
	return append([]byte(nil), unsafe.Slice(out.Data, out.Size)...), nil
}

// Unprotect opens a blob made by Protect with the same purpose.
func Unprotect(blob []byte, purpose string) ([]byte, error) {
	if len(blob) == 0 {
		return nil, fmt.Errorf("dpapi: empty blob")
	}
	ent := entropy(purpose)
	in := windows.DataBlob{Size: uint32(len(blob)), Data: &blob[0]}
	eb := windows.DataBlob{Size: uint32(len(ent)), Data: &ent[0]}
	var out windows.DataBlob
	if err := windows.CryptUnprotectData(&in, nil, &eb, 0, nil, windows.CRYPTPROTECT_UI_FORBIDDEN, &out); err != nil {
		return nil, fmt.Errorf("dpapi: CryptUnprotectData: %w", err)
	}
	defer windows.LocalFree(windows.Handle(unsafe.Pointer(out.Data)))
	plain := append([]byte(nil), unsafe.Slice(out.Data, out.Size)...)
	// wipe the system buffer before freeing it
	for i := range unsafe.Slice(out.Data, out.Size) {
		*(*byte)(unsafe.Add(unsafe.Pointer(out.Data), i)) = 0
	}
	return plain, nil
}

// RestrictFile replaces a file's ACL with full control for SYSTEM and the
// Administrators group only, and stops inheritance from the parent directory.
func RestrictFile(path string) error {
	sd, err := windows.SecurityDescriptorFromString("D:P(A;;FA;;;SY)(A;;FA;;;BA)")
	if err != nil {
		return err
	}
	dacl, _, err := sd.DACL()
	if err != nil {
		return err
	}
	return windows.SetNamedSecurityInfo(path, windows.SE_FILE_OBJECT,
		windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, dacl, nil)
}

// RestrictDir gives a directory (and, by inheritance, everything created in
// it) full control for SYSTEM and Administrators only. It is applied only in
// an elevated process, so a user never locks themselves out of their own files.
func RestrictDir(path string) error {
	if !windows.GetCurrentProcessToken().IsElevated() {
		return nil
	}
	sd, err := windows.SecurityDescriptorFromString("D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)")
	if err != nil {
		return err
	}
	dacl, _, err := sd.DACL()
	if err != nil {
		return err
	}
	return windows.SetNamedSecurityInfo(path, windows.SE_FILE_OBJECT,
		windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, dacl, nil)
}

// SecureDataDir locks down the service's data directory. The service runs as
// LocalSystem and trusts what is in it (config.json names the node binary it
// starts; protection.log decides what it may sign), but a new folder under
// %ProgramData% inherits "Users may create files and folders". SecureDataDir
// makes Administrators its owner and gives it a protected DACL: full control
// for SYSTEM and Administrators, read for Users (as %ProgramData% already
// grants), nothing else, inherited by everything inside (keys\ keeps its own
// stricter DACL). It then refuses when anything already inside was created by
// an account that is not SYSTEM, Administrators or this administrator, since
// such a file could have been planted before the lock-down.
func SecureDataDir(path string) error {
	tok := windows.GetCurrentProcessToken()
	if !tok.IsElevated() {
		return errors.New("run install from an administrator prompt")
	}
	admins, err := windows.CreateWellKnownSid(windows.WinBuiltinAdministratorsSid)
	if err != nil {
		return err
	}
	sd, err := windows.SecurityDescriptorFromString("D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;BU)")
	if err != nil {
		return err
	}
	dacl, _, err := sd.DACL()
	if err != nil {
		return err
	}
	if err := windows.SetNamedSecurityInfo(path, windows.SE_FILE_OBJECT,
		windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION,
		admins, nil, dacl, nil); err != nil {
		return fmt.Errorf("restricting %s: %w", path, err)
	}
	var me *windows.SID
	if tu, err := tok.GetTokenUser(); err == nil {
		me = tu.User.Sid
	}
	return filepath.WalkDir(path, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if p == path {
			return nil
		}
		fsd, err := windows.GetNamedSecurityInfo(p, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION)
		if err != nil {
			return fmt.Errorf("reading the owner of %s: %w", p, err)
		}
		owner, _, err := fsd.Owner()
		if err != nil {
			return fmt.Errorf("reading the owner of %s: %w", p, err)
		}
		if owner.IsWellKnown(windows.WinLocalSystemSid) || owner.IsWellKnown(windows.WinBuiltinAdministratorsSid) || (me != nil && owner.Equals(me)) {
			return nil
		}
		name := owner.String()
		if acct, dom, _, err := owner.LookupAccount(""); err == nil {
			name = dom + `\` + acct
		}
		return fmt.Errorf("%s was created by %s, not by an administrator, so it may have been planted there; move it out of %s (keep any key you made yourself) and run install again from an administrator prompt", p, name, path)
	})
}

// WriteProtected protects data and writes it to path, restricted to SYSTEM and Administrators.
func WriteProtected(path string, data []byte, purpose string) error {
	blob, err := Protect(data, purpose)
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, blob, 0o600); err != nil {
		return err
	}
	if err := RestrictFile(tmp); err != nil {
		os.Remove(tmp)
		return fmt.Errorf("dpapi: restrict %s: %w", tmp, err)
	}
	return os.Rename(tmp, path)
}

// ReadProtected reads and opens a file written by WriteProtected.
func ReadProtected(path, purpose string) ([]byte, error) {
	blob, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	return Unprotect(blob, purpose)
}

// Supported reports whether DPAPI is available.
func Supported() bool { return true }
