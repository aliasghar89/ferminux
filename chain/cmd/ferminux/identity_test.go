// Copyright 2026 The Ferminux Network Authors
// This file is part of the Ferminux node client, which descends from
// go-ethereum v1.10.26 (LGPL-3.0 — see LICENSES.md).

package main

import "testing"

// TestDatadirInstanceNameIsFrozen guards the single most dangerous line in a
// client rename. node.Config.Name feeds both instanceDir() and NodeKey(), so
// the on-disk instance directory must stay "ferminux-geth" no matter what the
// binary or the product is called. If this test ever has to be "fixed", the
// fix is wrong: every existing node would resync from genesis, generate a new
// nodekey and therefore a new enode, invalidating the bootnode enodes in
// params/ferminux.go.
func TestDatadirInstanceNameIsFrozen(t *testing.T) {
	if datadirInstanceName != "ferminux-geth" {
		t.Fatalf("datadirInstanceName = %q, want %q", datadirInstanceName, "ferminux-geth")
	}
	if got := defaultNodeConfig().Name; got != "ferminux-geth" {
		t.Fatalf("defaultNodeConfig().Name = %q, want %q (never the product name)", got, "ferminux-geth")
	}
}

// TestIPCPathIsFrozen guards the IPC socket filename. Every container
// healthcheck in infra/compose and infra/k8s runs
// `ferminux attach --exec net.listening /data/ferminux.ipc`; renaming the socket
// restart-loops the whole fleet at once.
func TestIPCPathIsFrozen(t *testing.T) {
	if got := defaultNodeConfig().IPCPath; got != "geth.ipc" {
		t.Fatalf("defaultNodeConfig().IPCPath = %q, want %q", got, "geth.ipc")
	}
}
