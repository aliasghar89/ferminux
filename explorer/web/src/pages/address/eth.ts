/* The only ethers the address pages use, imported by name so the bundle keeps just these (ABI coding, the
   bytecode hash, address checks). Loaded lazily through abi.ts `ethers()`. */
export { Interface, keccak256, isAddress, getAddress } from "ethers";
