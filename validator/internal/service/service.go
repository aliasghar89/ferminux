// Package service registers fmx-validator with the operating system: a
// Windows service (Automatic, delayed start, restarted on failure) or a
// systemd unit on Linux.
package service

import (
	"fmt"
	"strings"
)

// Windows service identity. The installer scripts in validator/packaging use
// the same name.
const (
	Name        = "FerminuxValidator"
	DisplayName = "Ferminux Validator"
	Description = "Keeps a Ferminux node running and signs its checkpoint attestations (validator Step 1). It does not produce blocks."
)

// UnitName is the systemd unit.
const UnitName = "fmx-validator.service"

// ExitFailed is the service-specific exit code the Windows service stops
// with when the sidecar fails; the reason is in the event log.
const ExitFailed = 1

// UnitOptions fills the systemd unit template.
type UnitOptions struct {
	Binary   string // absolute path to fmx-validator
	User     string // service user
	DataDir  string
	Network  string
	Password string // host path of the keystore password file, passed as a systemd credential
	// NodeBinary is the node the sidecar supervises, if any: it is not in the
	// unit, but must be somewhere the hardened unit can see.
	NodeBinary string
}

// Unit renders a hardened systemd unit.
func Unit(o UnitOptions) (string, error) {
	for name, v := range map[string]string{"binary": o.Binary, "user": o.User, "data dir": o.DataDir, "network": o.Network} {
		if v == "" {
			return "", fmt.Errorf("systemd unit: %s is required", name)
		}
		if strings.ContainsAny(v, "\n\r\"'\\ %$;") {
			return "", fmt.Errorf("systemd unit: %s %q contains characters a unit file cannot carry", name, v)
		}
	}
	// ProtectHome=true hides these trees from the service: a binary or data
	// directory there would fail at start (203/EXEC or permission denied).
	for name, v := range map[string]string{"binary": o.Binary, "data dir": o.DataDir, "node binary": o.NodeBinary} {
		if v == "" {
			continue
		}
		for _, hidden := range []string{"/home/", "/root/", "/run/user/"} {
			if strings.HasPrefix(v+"/", hidden) {
				return "", fmt.Errorf("systemd unit: the %s %s is under %s, which the hardened unit cannot see; install the binary in /usr/local/bin and keep the data in /var/lib", name, v, strings.TrimSuffix(hidden, "/"))
			}
		}
	}
	var b strings.Builder
	fmt.Fprintf(&b, `[Unit]
Description=Ferminux Validator (checkpoint attestations, %s)
Documentation=https://ferminux.net/docs
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=%s
Group=%s
ExecStart=%s run --data-dir %s --network %s
Restart=on-failure
RestartSec=10
TimeoutStopSec=120
# the sidecar stops a supervised node itself (interrupt, then wait), so only it gets SIGTERM
KillMode=mixed
`, o.Network, o.User, o.User, o.Binary, o.DataDir, o.Network)
	if o.Password != "" {
		if strings.ContainsAny(o.Password, "\n\r\"' %$") {
			return "", fmt.Errorf("systemd unit: password path %q contains characters a unit file cannot carry", o.Password)
		}
		fmt.Fprintf(&b, "LoadCredential=attester-password:%s\n", o.Password)
	}
	fmt.Fprintf(&b, `NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true
UMask=0077
ReadWritePaths=%s

[Install]
WantedBy=multi-user.target
`, o.DataDir)
	return b.String(), nil
}
