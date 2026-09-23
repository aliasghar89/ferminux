# Vendored libraries (MIT)

Copied byte-for-byte from Optimism's audited contracts-bedrock, then only their
import paths were rewritten to be relative. Do not edit these files; update by
re-vendoring from a pinned commit.

- Source: https://github.com/ethereum-optimism/optimism
- Commit: `77222155837ae817033d28775a0e97fcb1fe3758`
- Path: `packages/contracts-bedrock/src/libraries/{rlp/RLPReader.sol, rlp/RLPErrors.sol, trie/MerkleTrie.sol, Bytes.sol}`
- Licence: MIT (SPDX headers retained in each file)

`SHA256SUMS` records the files as vendored (after the import rewrite).
