#!/usr/bin/env bash
# Refreshes validator/internal/hub/abi.json from the real ValidatorHub
# (agents/contracts/src/validators). The sidecar embeds only the functions it
# calls, plus every custom error so reverts decode by name. Run it whenever the
# hub's interface changes, then `go test ./...` in validator/.
set -euo pipefail
cd "$(dirname "$0")"
forge build --offline >/dev/null
jq '[.abi[] | select(
      (.type == "error") or
      (.type == "event" and (.name | IN("Attested", "AttesterRotated", "SeatOpened"))) or
      (.type == "function" and (.name | IN(
        "domainSeparator", "attestationDigest", "attesterKeyDigest", "enodeDigest",
        "keyInfo", "attested", "checkpoint", "currentRewardPerAttest", "rewardPool",
        "eligibleCount", "occupiedSeats", "maxSeats", "attestationsPaused",
        "participation", "lastClosedCheckpoint", "extsload", "attest", "openSeat",
        "SEAT_DEPOSIT", "seatCount", "deployBlock")))
    )]' out/ValidatorHub.sol/ValidatorHub.json > ../../internal/hub/abi.json
echo "internal/hub/abi.json: $(jq length ../../internal/hub/abi.json) entries"
