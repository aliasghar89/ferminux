package service

import (
	"strings"
	"testing"
)

func TestUnit(t *testing.T) {
	u, err := Unit(UnitOptions{Binary: "/usr/local/bin/fmx-validator", User: "fmx-validator", DataDir: "/var/lib/fmx-validator", Network: "mainnet", Password: "/etc/fmx-validator/attester-password"})
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"ExecStart=/usr/local/bin/fmx-validator run --data-dir /var/lib/fmx-validator --network mainnet",
		"LoadCredential=attester-password:/etc/fmx-validator/attester-password",
		"ProtectSystem=strict", "NoNewPrivileges=true", "ReadWritePaths=/var/lib/fmx-validator", "User=fmx-validator",
		"WantedBy=multi-user.target", "KillMode=mixed",
	} {
		if !strings.Contains(u, want) {
			t.Fatalf("unit lacks %q:\n%s", want, u)
		}
	}
	if _, err := Unit(UnitOptions{Binary: "/bin/x", User: "u", DataDir: "/d\nExecStartPre=/bin/sh", Network: "mainnet"}); err == nil {
		t.Fatal("newline injection accepted")
	}
	if _, err := Unit(UnitOptions{Binary: "/bin/x", User: "u", DataDir: "/d"}); err == nil {
		t.Fatal("missing network accepted")
	}
	if _, err := Unit(UnitOptions{Binary: "/opt/fmx%h/fmx-validator", User: "u", DataDir: "/d", Network: "mainnet"}); err == nil {
		t.Fatal("systemd specifier accepted")
	}
	for _, o := range []UnitOptions{
		{Binary: "/home/alice/Downloads/fmx-validator", User: "u", DataDir: "/var/lib/fmx-validator", Network: "mainnet"},
		{Binary: "/usr/local/bin/fmx-validator", User: "u", DataDir: "/root/.fmx-validator", Network: "mainnet"},
		{Binary: "/usr/local/bin/fmx-validator", User: "u", DataDir: "/home", Network: "mainnet"},
	} {
		if _, err := Unit(o); err == nil {
			t.Fatalf("%+v: a path ProtectHome hides was accepted", o)
		}
	}
	if _, err := Unit(UnitOptions{Binary: "/usr/local/bin/fmx-validator", User: "u", DataDir: "/var/lib/fmx", Network: "mainnet", NodeBinary: "/home/alice/ferminux"}); err == nil {
		t.Fatal("a supervised node binary ProtectHome hides was accepted")
	}
	if _, err := Unit(UnitOptions{Binary: "/usr/local/bin/fmx-validator", User: "u", DataDir: "/homes/fmx", Network: "mainnet"}); err != nil {
		t.Fatalf("/homes is not /home: %v", err)
	}
}
