//go:build !windows

package keys

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/aliasghar89/ferminux/chain/accounts/keystore"
	"github.com/aliasghar89/ferminux/chain/crypto"
)

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
