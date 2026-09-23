# Support setting various labels on the final image
ARG COMMIT=""
ARG VERSION=""
ARG BUILDNUM=""

# Build the Ferminux node in a stock Go builder container
FROM golang:1.18-alpine as builder

RUN apk add --no-cache gcc musl-dev linux-headers git

# Get dependencies - will also be cached if we won't change go.mod/go.sum
COPY go.mod /src/
COPY go.sum /src/
RUN cd /src && go mod download

ADD . /src
RUN cd /src && go run build/ci.go install -static ./cmd/ferminux

# Pull the node binary into a second stage deploy alpine container
FROM alpine:latest

RUN apk add --no-cache ca-certificates
COPY --from=builder /src/build/bin/ferminux /usr/local/bin/ferminux
# Compatibility symlinks. NEITHER is optional:
#   ferminux-geth — the previously published binary name; operator scripts,
#                   systemd units and cron-piped installs call it.
#   geth          — every container healthcheck in infra/compose and infra/k8s
#                   runs `geth attach --exec net.listening /data/geth.ipc`.
#                   Deleting it takes the whole fleet unhealthy at once.
RUN ln -s /usr/local/bin/ferminux /usr/local/bin/ferminux-geth \
 && ln -s /usr/local/bin/ferminux /usr/local/bin/geth

EXPOSE 8545 8546 30303 30303/udp
ENTRYPOINT ["ferminux"]

# Add some metadata labels to help programatic image consumption
ARG COMMIT=""
ARG VERSION=""
ARG BUILDNUM=""

LABEL commit="$COMMIT" version="$VERSION" buildnum="$BUILDNUM"
