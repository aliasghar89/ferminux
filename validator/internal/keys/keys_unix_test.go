//go:build !windows

package keys

import (
	"os"
	"path/filepath"
	"syscall"
	"testing"

	"github.com/aliasghar89/ferminux/chain/accounts/keystore"
	"github.com/aliasghar89/ferminux/chain/crypto"
)

// On an installed node (install.sh --no-key prints `sudo fmx-validator keys
// import ...` for afterwards) root writes the key into a network directory
// the service user owns. A key file root creates was root's, 0600, and so was
// a keys directory it made: the service could not read its own attester key.
func TestWriteTakesTheDirectoryOwner(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("only root can give a file to another user")
	}
	const uid, gid = 65534, 65534
	priv, _ := crypto.GenerateKey()
	enc, err := keystore.EncryptKey(&keystore.Key{Address: crypto.PubkeyToAddress(priv.PublicKey), PrivateKey: priv}, string(pw), keystore.LightScryptN, keystore.LightScryptP)
	if err != nil {
		t.Fatal(err)
	}
	for _, keysDirExists := range []bool{false, true} {
		name := "keys directory made"
		if keysDirExists {
			name = "keys directory there"
		}
		t.Run(name, func(t *testing.T) {
			dd := t.TempDir()
			net := filepath.Join(dd, "devnet")
			dir := filepath.Join(net, "keys")
			mk := []string{net}
			if keysDirExists {
				mk = append(mk, dir)
			}
			for _, d := range mk {
				if err := os.Mkdir(d, 0o700); err != nil {
					t.Fatal(err)
				}
				if err := os.Chown(d, uid, gid); err != nil {
					t.Fatal(err)
				}
			}
			if keysDirExists {
				_, err = Import(dd, dir, "devnet", 31337, enc, pw)
			} else {
				_, err = Create(dd, dir, "devnet", 31337, pw)
			}
			if err != nil {
				t.Fatal(err)
			}
			for p, mode := range map[string]os.FileMode{dir: 0o700, filepath.Join(dir, KeyFile): 0o600, filepath.Join(dir, MarkerFile): 0o600} {
				fi, err := os.Lstat(p)
				if err != nil {
					t.Fatal(err)
				}
				st := fi.Sys().(*syscall.Stat_t)
				if st.Uid != uid || st.Gid != gid {
					t.Fatalf("%s is %d:%d, want the service user's %d:%d", p, st.Uid, st.Gid, uid, gid)
				}
				if fi.Mode().Perm() != mode {
					t.Fatalf("%s mode %v, want %v", p, fi.Mode().Perm(), mode)
				}
			}
			if entries, _ := os.ReadDir(dir); len(entries) != 2 {
				t.Fatalf("keys directory holds %v, want the key and its marker only", entries)
			}
		})
	}
}

// `sudo fmx-validator keys new` and `keys import` write the key as root into a
// network directory the service user owns. A link that user planted at
// keys/attester.json.tmp had root truncate and overwrite the link's target,
// and the rename then made attester.json that link.
func TestWriteNeverFollowsAPlantedTmpLink(t *testing.T) {
	priv, _ := crypto.GenerateKey()
	enc, err := keystore.EncryptKey(&keystore.Key{Address: crypto.PubkeyToAddress(priv.PublicKey), PrivateKey: priv}, string(pw), keystore.LightScryptN, keystore.LightScryptP)
	if err != nil {
		t.Fatal(err)
	}
	for name, write := range map[string]func(dd, dir string) error{
		"new": func(dd, dir string) error {
			_, err := Create(dd, dir, "devnet", 31337, pw)
			return err
		},
		"import": func(dd, dir string) error {
			_, err := Import(dd, dir, "devnet", 31337, enc, pw)
			return err
		},
	} {
		t.Run(name, func(t *testing.T) {
			dd := t.TempDir()
			dir := filepath.Join(dd, "devnet", "keys")
			if err := os.MkdirAll(dir, 0o700); err != nil {
				t.Fatal(err)
			}
			const victimText = "a file only root may change\n"
			victims := map[string]string{}
			for _, f := range []string{KeyFile, MarkerFile} {
				v := filepath.Join(t.TempDir(), "victim")
				if err := os.WriteFile(v, []byte(victimText), 0o644); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(v, filepath.Join(dir, f+".tmp")); err != nil {
					t.Skipf("symlinks unavailable here: %v", err)
				}
				victims[f] = v
			}
			if err := write(dd, dir); err != nil {
				t.Fatal(err)
			}
			for f, v := range victims {
				if b, err := os.ReadFile(v); err != nil || string(b) != victimText {
					t.Fatalf("writing %s went through the link planted at %s.tmp: %q %v", f, f, b, err)
				}
				st, err := os.Lstat(filepath.Join(dir, f))
				if err != nil || !st.Mode().IsRegular() || st.Mode().Perm() != 0o600 {
					t.Fatalf("%s is not a fresh 0600 file: %v %v", f, st, err)
				}
			}
			if _, err := CheckNetwork(dd, dir, "devnet", 31337); err != nil {
				t.Fatal(err)
			}
		})
	}
}

// The service user can also put a link where the keys directory, or the
// network directory holding it, was: root must not write the key into the
// link's target.
func TestWriteRefusesALinkedDirectory(t *testing.T) {
	for _, linked := range []string{"keys", "network"} {
		t.Run(linked, func(t *testing.T) {
			dd := t.TempDir()
			target := t.TempDir() // stands in for a directory only root may change
			dir := filepath.Join(dd, "devnet", "keys")
			link, into := filepath.Join(dd, "devnet", "keys"), target
			if linked == "network" {
				link, into = filepath.Join(dd, "devnet"), filepath.Join(target, "keys")
				if err := os.Mkdir(into, 0o700); err != nil {
					t.Fatal(err)
				}
			} else if err := os.Mkdir(filepath.Join(dd, "devnet"), 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(target, link); err != nil {
				t.Skipf("symlinks unavailable here: %v", err)
			}
			if _, err := Create(dd, dir, "devnet", 31337, pw); err == nil {
				t.Fatalf("the key was written through a linked %s directory", linked)
			}
			if entries, _ := os.ReadDir(into); len(entries) != 0 {
				t.Fatalf("files written in the link's target: %v", entries)
			}
		})
	}
}
