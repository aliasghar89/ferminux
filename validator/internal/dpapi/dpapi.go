// Package dpapi protects small secrets (the keystore password) with the Windows
// Data Protection API, machine scope, so the validator service can open its
// key after a reboot with nobody logged in. The protected file is additionally
// restricted to SYSTEM and Administrators. On other systems every call returns
// ErrUnsupported.
package dpapi

import "errors"

// ErrUnsupported is returned off Windows.
var ErrUnsupported = errors.New("dpapi: only available on Windows")

// entropy binds a protected blob to this program and purpose: another program
// calling CryptUnprotectData on the file without it gets nothing.
func entropy(purpose string) []byte { return []byte("fmx-validator/dpapi/v1/" + purpose) }
