#!/usr/bin/env python3
"""London-safety scan for EVM bytecode.

Usage: opscan.py <hex-or-file> [...]

Chain 3961 runs the London rule set, so it has no PUSH0 (Shanghai) and no
TLOAD/TSTORE/MCOPY/BLOBHASH/BLOBBASEFEE (Cancun). This walks each input as
the EVM would decode it: PUSH immediates are skipped, Solidity CBOR metadata
blobs are skipped, and bytes after a terminating opcode (STOP, RETURN, REVERT,
INVALID, SELFDESTRUCT, JUMP) count as data until the next JUMPDEST or the
start of an embedded contract (PUSH1 xx PUSH1 0x40 MSTORE). A forbidden
opcode in reachable code fails the scan; one inside data (a revert string,
for example) is reported but does not fail it.

Exit status 1 if any input has a forbidden opcode in code.
Also prints the solc version(s) recorded in the metadata.
"""
import os
import re
import sys

POST_LONDON = {0x5F: "PUSH0", 0x5C: "TLOAD", 0x5D: "TSTORE", 0x5E: "MCOPY",
               0x49: "BLOBHASH", 0x4A: "BLOBBASEFEE"}
TERMINATORS = {0x00, 0x56, 0xF3, 0xFD, 0xFE, 0xFF}
JUMPDEST = 0x5B
# Solidity metadata is a CBOR map that ends with "solc" -> 3 version bytes,
# followed by the 2-byte big-endian length of the CBOR blob.
SOLC_TAIL = re.compile(rb"\x64solc\x43(...)(..)", re.S)
SUB_ASSEMBLY = re.compile(rb"\x60.\x60\x40\x52", re.S)


def metadata_regions(code: bytes):
    regions, versions = [], []
    for m in SOLC_TAIL.finditer(code):
        end = m.end()
        start = end - 2 - int.from_bytes(m.group(2), "big")
        if 0 <= start < m.start() and code[start] in (0xA1, 0xA2, 0xA3, 0xA4):
            regions.append((start, end))
            v = m.group(1)
            versions.append(f"{v[0]}.{v[1]}.{v[2]}")
    return sorted(regions), sorted(set(versions))


def scan(code: bytes):
    regions, versions = metadata_regions(code)
    in_code, in_data = {}, {}
    i, r, live = 0, 0, True
    while i < len(code):
        if r < len(regions) and i >= regions[r][0]:
            i, r, live = regions[r][1], r + 1, False
            continue
        op = code[i]
        if op == JUMPDEST or SUB_ASSEMBLY.match(code, i):
            live = True
        if op in POST_LONDON:
            bucket = in_code if live else in_data
            bucket[POST_LONDON[op]] = bucket.get(POST_LONDON[op], 0) + 1
        if op in TERMINATORS:
            live = False
        if 0x60 <= op <= 0x7F:
            i += op - 0x5F
        i += 1
    return in_code, in_data, versions


def load(arg: str) -> bytes:
    s = (open(arg).read() if os.path.isfile(arg) else arg).strip()
    return bytes.fromhex(s[2:] if s.startswith("0x") else s)


def fmt(d):
    return ",".join(f"{k}x{v}" for k, v in sorted(d.items()))


def main():
    bad = False
    for arg in sys.argv[1:]:
        in_code, in_data, versions = scan(load(arg))
        label = os.path.basename(arg) if os.path.isfile(arg) else f"{arg[:18]}..."
        status = "LONDON-OK" if not in_code else "NOT-LONDON " + fmt(in_code)
        note = f" (ignored in data: {fmt(in_data)})" if in_data else ""
        print(f"{label:48} {status:10} solc={'/'.join(versions) or 'none'}{note}")
        bad |= bool(in_code)
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
