#!/usr/bin/env python3
"""Point the compiled Ferminux authority constants at DEVNET keys in a SCRATCH
copy of chain/ (never the repo's own chain/).

Only chain/params/ferminux.go changes:
  FerminuxInitialSigners    -> the devnet signers (3)
  FerminuxBreakGlassOwners  -> the devnet multisig owners (3)
  FerminuxRewardSink        -> the devnet FMXRewardSink address (deployer nonce 1)
  FerminuxPosaPeriod        -> 1 s (the smallest period the engine accepts:
                               consensus/posa.New refuses 0)
Everything else (the posa wrapper, the Ferminux Clique engine, the reward
split, the 64-block reorg cap, fork choice, the 30,000-block epoch) is the
repo's HEAD source byte for byte. The devnet genesis (chain id 39619) sets
posaBlock 1 in its own config, so blocks are confirmed by the signers from
block 1.

Usage: patch-devnet-params.py <scratch-chain-dir> <devnet.env>
"""
import pathlib
import re
import sys

root = pathlib.Path(sys.argv[1])
env = {}
for line in pathlib.Path(sys.argv[2]).read_text().splitlines():
    line = line.strip()
    if line and not line.startswith("#") and "=" in line:
        k, v = line.split("=", 1)
        env[k] = v

p = root / "params" / "ferminux.go"
s = p.read_text()


def replace_list(src, var, addrs):
    pat = re.compile(r"(" + re.escape(var) + r" = \[\]common\.Address\{\n)(.*?)(\n\t\})", re.S)
    m = pat.search(src)
    if not m:
        raise SystemExit(f"{var} block not found")
    body = "\n".join(f'\t\tcommon.HexToAddress("{a}"),' for a in addrs)
    return src[: m.start(2)] + body + src[m.end(2):]


signers = [env[f"SIGNER{i}"] for i in (1, 2, 3)]
owners = [env[f"OWNER{i}"] for i in (1, 2, 3)]
s = replace_list(s, "FerminuxInitialSigners", signers)
s = replace_list(s, "FerminuxBreakGlassOwners", owners)

sink_pat = re.compile(r'FerminuxRewardSink = common\.(?:Address\{\}|HexToAddress\("0x[0-9a-fA-F]+"\))')
assert len(sink_pat.findall(s)) == 1, sink_pat.findall(s)
s = sink_pat.sub(f'FerminuxRewardSink = common.HexToAddress("{env["SINK"]}")', s, count=1)

per_pat = re.compile(r"FerminuxPosaPeriod = \d+")
assert len(per_pat.findall(s)) == 1, per_pat.findall(s)
s = per_pat.sub("FerminuxPosaPeriod = 1", s, count=1)

s = s.replace("package params\n", "package params\n\n// *** DEVNET BUILD (validator/devnet, chain id 39619): signers, owners, sink and the\n// block period are devnet values. Never run this binary against any other network. ***\n", 1)
p.write_text(s)
print(f"patched {p}: signers={signers} owners={owners} sink={env['SINK']} period=1")
