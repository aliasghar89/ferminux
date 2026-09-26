# fmx-validator: the Ferminux validator sidecar.
# Pure Go (CGO_ENABLED=0), built with the same toolchain as chain/.

GO      ?= go
export GOTOOLCHAIN ?= go1.20.14
export CGO_ENABLED := 0
VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
LDFLAGS := -s -w -X main.version=$(VERSION)
TARGETS := windows/amd64 linux/amd64 linux/arm64

.PHONY: build cross test test-integration vectors abi clean

build:
	$(GO) build -trimpath -ldflags "$(LDFLAGS)" -o bin/fmx-validator ./cmd/fmx-validator

cross:
	@for t in $(TARGETS); do \
		os=$${t%/*}; arch=$${t#*/}; ext=; [ $$os = windows ] && ext=.exe; \
		echo "bin/fmx-validator-$$os-$$arch$$ext"; \
		GOOS=$$os GOARCH=$$arch $(GO) build -trimpath -ldflags "$(LDFLAGS)" -o bin/fmx-validator-$$os-$$arch$$ext ./cmd/fmx-validator || exit 1; \
	done

# unit tests (no anvil or forge needed)
test:
	$(GO) test -short ./...

# the full run against the real ValidatorHub on a local anvil chain (needs anvil and forge)
test-integration:
	$(GO) test -count=1 -run TestSidecarAgainstRealHubOnAnvil -v ./internal/integration
	cd testdata/hubtest && forge test --offline

# regenerate testdata/attestation_vectors.json (only when the signing format changes on purpose)
vectors:
	$(GO) test ./internal/attest -run TestVectorFile -update

# refresh internal/hub/abi.json from agents/contracts/src/validators/ValidatorHub.sol
abi:
	./testdata/hubtest/gen-abi.sh

clean:
	rm -rf bin
