package keys

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"

	"github.com/aliasghar89/ferminux/validator/internal/dpapi"
	"golang.org/x/term"
)

// SystemdCredential is the credential name the systemd unit passes with
// LoadCredential= (read from $CREDENTIALS_DIRECTORY).
const SystemdCredential = "attester-password"

// dpapiPurpose binds the protected password to this use.
func dpapiPurpose(network string) string { return "attester-password/" + network }

// PasswordOptions says where the keystore password may come from.
type PasswordOptions struct {
	File        string // explicit password file
	Network     string
	KeysDir     string
	Interactive bool // may prompt on the terminal
	Prompt      string
	Stdin       *os.File
	Stderr      io.Writer
}

// Source describes where a password came from (never the password).
type Source string

// ResolvePassword finds the keystore password, in order: an explicit file, a
// systemd credential, a Windows DPAPI-protected file next to the key, a terminal
// prompt. The caller must Zero the result when done.
func ResolvePassword(o PasswordOptions) ([]byte, Source, error) {
	if o.File != "" {
		b, err := readPasswordFile(o.File)
		return b, Source("file " + o.File), err
	}
	if cd := os.Getenv("CREDENTIALS_DIRECTORY"); cd != "" {
		p := filepath.Join(cd, SystemdCredential)
		if _, err := os.Stat(p); err == nil {
			b, err := os.ReadFile(p)
			if err != nil {
				return nil, "", err
			}
			return trimNewline(b), Source("systemd credential " + SystemdCredential), nil
		}
	}
	if dpapi.Supported() && o.KeysDir != "" {
		p := filepath.Join(o.KeysDir, DPAPIFile)
		if _, err := os.Stat(p); err == nil {
			b, err := dpapi.ReadProtected(p, dpapiPurpose(o.Network))
			if err != nil {
				return nil, "", fmt.Errorf("could not open the DPAPI-protected password %s: %w", p, err)
			}
			return b, Source("windows dpapi " + p), nil
		}
	}
	if o.Interactive {
		b, err := Prompt(o.stdin(), o.stderr(), o.promptText())
		return b, Source("prompt"), err
	}
	return nil, "", errors.New("no keystore password available: give --password-file, store one with `fmx-validator keys store-password` (Windows), or run interactively")
}

func (o PasswordOptions) stdin() *os.File {
	if o.Stdin != nil {
		return o.Stdin
	}
	return os.Stdin
}

func (o PasswordOptions) stderr() io.Writer {
	if o.Stderr != nil {
		return o.Stderr
	}
	return os.Stderr
}

func (o PasswordOptions) promptText() string {
	if o.Prompt != "" {
		return o.Prompt
	}
	return "Attester key password: "
}

// Prompt reads a password from the terminal without echo.
func Prompt(in *os.File, out io.Writer, text string) ([]byte, error) {
	fd := int(in.Fd())
	if !term.IsTerminal(fd) {
		return nil, errors.New("cannot prompt for a password: not a terminal")
	}
	fmt.Fprint(out, text)
	b, err := term.ReadPassword(fd)
	fmt.Fprintln(out)
	return b, err
}

// PromptNew asks twice and checks the length.
func PromptNew(in *os.File, out io.Writer) ([]byte, error) {
	a, err := Prompt(in, out, fmt.Sprintf("New attester key password (at least %d characters): ", MinPasswordLength))
	if err != nil {
		return nil, err
	}
	b, err := Prompt(in, out, "Repeat the password: ")
	if err != nil {
		Zero(a)
		return nil, err
	}
	defer Zero(b)
	if string(a) != string(b) {
		Zero(a)
		return nil, errors.New("the passwords do not match")
	}
	if len(a) < MinPasswordLength {
		Zero(a)
		return nil, fmt.Errorf("password must be at least %d characters", MinPasswordLength)
	}
	return a, nil
}

func readPasswordFile(path string) ([]byte, error) {
	st, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	if runtime.GOOS != "windows" && st.Mode().Perm()&0o077 != 0 {
		return nil, fmt.Errorf("password file %s is readable by other users (mode %o); chmod 600 it", path, st.Mode().Perm())
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	return trimNewline(b), nil
}

// StorePassword stores the password next to the key with Windows machine DPAPI,
// after checking that it opens the key.
func StorePassword(keysDir, network string, password []byte) (string, error) {
	if !dpapi.Supported() {
		return "", dpapi.ErrUnsupported
	}
	priv, _, err := Load(keysDir, password)
	if err != nil {
		return "", err
	}
	zeroKey(priv)
	p := filepath.Join(keysDir, DPAPIFile)
	return p, dpapi.WriteProtected(p, password, dpapiPurpose(network))
}
