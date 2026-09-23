# This Makefile is meant to be used by people that do not usually work
# with Go source code. If you know what GOPATH is then you probably
# don't need to bother with make.

.PHONY: ferminux ferminux-geth geth android ios evm all test clean

GOBIN = ./build/bin
GO ?= latest
GORUN = env GO111MODULE=on go run

# `ferminux` is the product name and the command users type. The two
# compatibility names below are produced alongside it and are NOT going away:
#   ferminux-geth  — the previously published binary name; site/install.sh is
#                    served live and people have piped it into cron.
#   geth           — the name every container healthcheck calls
#                    (`geth attach --exec net.listening /data/geth.ipc`).
# Note this renames the BINARY only: the on-disk instance directory stays
# ~/.ferminux/ferminux-geth/ (cmd/ferminux: datadirInstanceName), so an existing
# node keeps its chaindata, its nodekey and therefore its enode.
ferminux:
	$(GORUN) build/ci.go install ./cmd/ferminux
	ln -sf ferminux $(GOBIN)/ferminux-geth
	ln -sf ferminux $(GOBIN)/geth
	@echo "Done building."
	@echo "Run \"$(GOBIN)/ferminux\" to launch a Ferminux Network node."
	@echo "Compatibility names \"ferminux-geth\" and \"geth\" point at the same binary."

# Kept so existing build scripts and CI invocations keep working.
ferminux-geth: ferminux

geth: ferminux

all:
	$(GORUN) build/ci.go install

android:
	$(GORUN) build/ci.go aar --local
	@echo "Done building."
	@echo "Import \"$(GOBIN)/ferminux.aar\" to use the library."
	@echo "Import \"$(GOBIN)/ferminux-sources.jar\" to add javadocs"
	@echo "For more info see https://stackoverflow.com/questions/20994336/android-studio-how-to-attach-javadoc"

ios:
	$(GORUN) build/ci.go xcode --local
	@echo "Done building."
	@echo "Import \"$(GOBIN)/Ferminux.framework\" to use the library."

test: all
	$(GORUN) build/ci.go test

lint: ## Run linters.
	$(GORUN) build/ci.go lint

clean:
	env GO111MODULE=on go clean -cache
	rm -fr build/_workspace/pkg/ $(GOBIN)/*

# The devtools target installs tools required for 'go generate'.
# You need to put $GOBIN (or $GOPATH/bin) in your PATH to use 'go generate'.

devtools:
	env GOBIN= go install golang.org/x/tools/cmd/stringer@latest
	env GOBIN= go install github.com/fjl/gencodec@latest
	env GOBIN= go install github.com/golang/protobuf/protoc-gen-go@latest
	env GOBIN= go install ./cmd/abigen
	@type "solc" 2> /dev/null || echo 'Please install solc'
	@type "protoc" 2> /dev/null || echo 'Please install protoc'
