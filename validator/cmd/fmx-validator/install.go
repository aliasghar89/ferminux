package main

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"

	"github.com/aliasghar89/ferminux/validator/internal/config"
	"github.com/aliasghar89/ferminux/validator/internal/dpapi"
	"github.com/aliasghar89/ferminux/validator/internal/keys"
	"github.com/aliasghar89/ferminux/validator/internal/service"
)

func cmdInstall(args []string, out io.Writer) error {
	fs := newFlags("install", out)
	var cm baseFlags
	var nf nodeFlags
	cm.register(fs)
	nf.register(fs)
	start := fs.Bool("start", false, "start the service after installing it")
	user := fs.String("user", "fmx-validator", "Linux: the (existing) system user the unit runs as")
	printUnit := fs.Bool("print", false, "Linux: print the systemd unit instead of writing it")
	unitDir := fs.String("unit-dir", "/etc/systemd/system", "Linux: where to write the unit")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if err := cm.resolve(); err != nil {
		return err
	}
	abs, err := filepath.Abs(cm.dataDir)
	if err != nil {
		return err
	}
	cm.dataDir = abs
	_, statErr := os.Stat(cm.dataDir)
	dataDirExisted := statErr == nil
	if runtime.GOOS == "windows" && nf.rpc == "" {
		nf.supervise = true // on Windows the service runs the node itself
	}
	if runtime.GOOS == "windows" {
		// the service runs as LocalSystem and trusts this directory: lock it
		// down before anything is written or read from it
		if err := secureWindowsDataDir(cm.dataDir); err != nil {
			return err
		}
	}
	// On Linux the password file goes into the unit as a systemd credential
	// (systemd reads it as root); the service user need not be able to read it.
	unitPassword := ""
	if runtime.GOOS == "linux" && nf.passwordFile != "" {
		if unitPassword, err = filepath.Abs(nf.passwordFile); err != nil {
			return err
		}
		nf.passwordFile = ""
	}
	c, created, err := loadOrCreate(cm, &nf, true)
	if err != nil {
		return err
	}
	if _, err := config.Resolve(c, cm.dir()); err != nil {
		return err
	}
	if created {
		fmt.Fprintf(out, "wrote %s\n", filepath.Join(cm.dir(), "config.json"))
	}
	// a service that supervises a node it cannot find would only fail at start
	if c.Node.Supervise {
		p, err := exec.LookPath(c.Node.Binary)
		if err != nil {
			return fmt.Errorf("the node binary %s: %v (give its path with --node-path)", c.Node.Binary, err)
		}
		if !filepath.IsAbs(c.Node.Binary) {
			if c.Node.Binary, err = filepath.Abs(p); err != nil {
				return err
			}
			if err := config.Save(cm.dir(), c); err != nil {
				return err
			}
		}
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	if exe, err = filepath.EvalSymlinks(exe); err != nil {
		return err
	}
	runArgs := []string{"run", "--data-dir", cm.dataDir, "--network", cm.network}
	switch runtime.GOOS {
	case "windows":
		if err := service.Install(exe, runArgs); err != nil {
			return err
		}
		fmt.Fprintf(out, "service %q (%s) registered: Automatic (Delayed Start), restarted on failure\n", service.Name, service.DisplayName)
		fmt.Fprintf(out, "errors go to Event Viewer (Windows Logs > Application, source %s) and `fmx-validator status`\n", service.Name)
		if *start {
			if err := service.Start(); err != nil {
				return withLastError(err, cm.dir())
			}
			fmt.Fprintln(out, "service started")
		}
		fmt.Fprintln(out, "the service opens the attester key with the password stored by `fmx-validator keys new --store-password` (or `keys store-password`)")
		return nil
	case "linux":
		nodeBinary := ""
		if c.Node.Supervise {
			nodeBinary = c.Node.Binary
		}
		if unitPassword != "" && !*printUnit {
			if err := checkCredentialFile(unitPassword); err != nil {
				return err
			}
			// LoadCredential= arrived in systemd 247; before it the sidecar reads
			// a copy kept in its own (service user only) network directory
			if v := systemdVersion(); v > 0 && v < 247 {
				p, err := copyPasswordFile(unitPassword, cm.dir())
				if err != nil {
					return err
				}
				c.PasswordFile, unitPassword = p, ""
				if err := config.Save(cm.dir(), c); err != nil {
					return err
				}
				fmt.Fprintf(out, "systemd %d has no LoadCredential=: the password was copied to %s (mode 0600, for the service user only)\n", v, p)
			}
		}
		unit, err := service.Unit(service.UnitOptions{Binary: exe, User: *user, DataDir: cm.dataDir, Network: cm.network, Password: unitPassword, NodeBinary: nodeBinary})
		if err != nil {
			return err
		}
		if *printUnit {
			_, err := io.WriteString(out, unit)
			return err
		}
		if os.Geteuid() != 0 {
			return errors.New("writing a systemd unit needs root (or use --print)")
		}
		// the unit runs as the service user: everything under the network
		// directory (config.json written just now as root, keys, the
		// protection database, a supervised node's datadir) must be its own
		if err := chownForService(*user, cm.dataDir, dataDirExisted, cm.dir()); err != nil {
			return err
		}
		path := filepath.Join(*unitDir, service.UnitName)
		if err := os.WriteFile(path, []byte(unit), 0o644); err != nil {
			return err
		}
		fmt.Fprintf(out, "wrote %s\n", path)
		if unitPassword == "" && c.PasswordFile == "" {
			fmt.Fprintln(out, "no --password-file given: the service will wait for one (LoadCredential=attester-password:<file> in the unit, or passwordFile in config.json)")
		}
		if err := exec.Command("systemctl", "daemon-reload").Run(); err != nil {
			fmt.Fprintf(out, "run: systemctl daemon-reload\n")
		}
		if *start {
			if b, err := exec.Command("systemctl", "enable", "--now", service.UnitName).CombinedOutput(); err != nil {
				return withLastError(fmt.Errorf("systemctl enable --now: %v: %s (journalctl -u %s shows why)", err, strings.TrimSpace(string(b)), service.UnitName), cm.dir())
			}
			fmt.Fprintln(out, "enabled and started")
		} else {
			fmt.Fprintf(out, "start it with: systemctl enable --now %s\n", service.UnitName)
		}
		return nil
	}
	return fmt.Errorf("install is for Windows and Linux; on %s run `fmx-validator run` directly", runtime.GOOS)
}

func cmdUninstall(args []string, out io.Writer) error {
	fs := newFlags("uninstall", out)
	unitDir := fs.String("unit-dir", "/etc/systemd/system", "Linux: where the unit is")
	if err := fs.Parse(args); err != nil {
		return err
	}
	switch runtime.GOOS {
	case "windows":
		if err := service.Uninstall(); err != nil {
			return err
		}
		fmt.Fprintf(out, "service %q removed; keys, the protection database and the chain data were left in place\n", service.Name)
		return nil
	case "linux":
		path := filepath.Join(*unitDir, service.UnitName)
		if _, err := os.Stat(path); err != nil {
			return fmt.Errorf("%s is not installed", path)
		}
		if os.Geteuid() != 0 {
			return errors.New("removing the systemd unit needs root")
		}
		exec.Command("systemctl", "disable", "--now", service.UnitName).Run()
		if err := os.Remove(path); err != nil {
			return err
		}
		exec.Command("systemctl", "daemon-reload").Run()
		fmt.Fprintf(out, "removed %s; keys, the protection database and the chain data were left in place\n", path)
		return nil
	}
	return fmt.Errorf("nothing to uninstall on %s", runtime.GOOS)
}

// withLastError adds the sidecar's own account of its last failed run.
func withLastError(err error, netDir string) error {
	if b, rerr := os.ReadFile(filepath.Join(netDir, LastErrorFile)); rerr == nil {
		return fmt.Errorf("%w\nlast error recorded by the sidecar: %s", err, strings.TrimSpace(string(b)))
	}
	return err
}

// checkCredentialFile: systemd reads the password file as root and hands it
// to the service, so it must be root's and unreadable by anyone else.
func checkCredentialFile(path string) error {
	st, err := os.Stat(path)
	if err != nil {
		return fmt.Errorf("password file: %w", err)
	}
	if !st.Mode().IsRegular() {
		return fmt.Errorf("password file %s is not a regular file", path)
	}
	if st.Mode().Perm()&0o077 != 0 {
		return fmt.Errorf("password file %s is readable or writable by others (mode %o): chmod 600 %s", path, st.Mode().Perm(), path)
	}
	if owner, _, ok := statOwner(st); ok && owner != 0 {
		return fmt.Errorf("password file %s must belong to root (uid %d owns it): chown root:root %s", path, owner, path)
	}
	return nil
}

// copyPasswordFile copies the password into <netDir>/attester-password (0600).
func copyPasswordFile(src, netDir string) (string, error) {
	pw, _, err := keys.ResolvePassword(keys.PasswordOptions{File: src})
	if err != nil {
		return "", err
	}
	defer keys.Zero(pw)
	dst := filepath.Join(netDir, "attester-password")
	if err := os.WriteFile(dst, append(append([]byte(nil), pw...), '\n'), 0o600); err != nil {
		return "", err
	}
	return dst, nil
}

// systemdVersion is systemd's major version, or 0 when unknown.
func systemdVersion() int {
	b, err := exec.Command("systemctl", "--version").Output()
	if err != nil {
		return 0
	}
	f := strings.Fields(string(b))
	if len(f) < 2 || f[0] != "systemd" {
		return 0
	}
	v, _ := strconv.Atoi(f[1])
	return v
}

// chownForService gives the service user the network directory tree, and the
// data directory itself when this install created it. It refuses when the
// user could still not reach its data.
func chownForService(name, dataDir string, dataDirExisted bool, netDir string) error {
	u, err := user.Lookup(name)
	if err != nil {
		return fmt.Errorf("service user %q: %w (create it first: useradd --system --shell /usr/sbin/nologin %s)", name, err, name)
	}
	uid, err := strconv.Atoi(u.Uid)
	if err != nil {
		return err
	}
	gid, err := strconv.Atoi(u.Gid)
	if err != nil {
		return err
	}
	if uid == 0 {
		return fmt.Errorf("service user %q is root; the unit must run as an unprivileged user", name)
	}
	if !dataDirExisted {
		if err := os.Lchown(dataDir, uid, gid); err != nil {
			return err
		}
	}
	err = filepath.WalkDir(netDir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		return os.Lchown(p, uid, gid)
	})
	if err != nil {
		return fmt.Errorf("giving %s to %s: %w", netDir, name, err)
	}
	// the user must be able to enter the data directory to reach its network directory
	if st, err := os.Stat(dataDir); err == nil {
		if owner, group, ok := statOwner(st); ok && owner != uid {
			perm := st.Mode().Perm()
			if perm&0o001 == 0 && !(group == gid && perm&0o010 != 0) {
				return fmt.Errorf("the service user %s cannot enter %s (owner uid %d, mode %o): chown it to %s or choose another --data-dir", name, dataDir, owner, perm, name)
			}
		}
	}
	return nil
}

// secureWindowsDataDir creates the data directory and restricts it to SYSTEM
// and Administrators (dpapi.SecureDataDir). It only does so for a directory
// that holds nothing but this program's network directories, so a mistaken
// --data-dir such as C:\ProgramData or a drive root is never re-permissioned.
func secureWindowsDataDir(dir string) error {
	if filepath.Dir(dir) == dir {
		return fmt.Errorf("--data-dir %s is a drive root; give the validator a directory of its own", dir)
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	for _, e := range entries {
		if _, ok := config.Presets[e.Name()]; !ok || !e.IsDir() {
			return fmt.Errorf("--data-dir %s holds %q, which is not one of this program's network folders; give the validator a directory of its own", dir, e.Name())
		}
	}
	if err := dpapi.SecureDataDir(dir); err != nil {
		return fmt.Errorf("securing %s: %w", dir, err)
	}
	return nil
}
