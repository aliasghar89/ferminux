// ---------------------------------------------------------------------------
// The official-token check.
//
// The launchpad TokenFactory keeps an on-chain registry of every token it
// minted, exposed as `isFactoryToken(address) -> bool`. A token that is NOT in
// it is a contract someone deployed by hand: it can do whatever its author
// wrote, including skimming the asset you pair against it during addLiquidity
// and handing you back dust LP. The router refuses to complete such a deposit,
// but the friendlier outcome is to warn BEFORE the user signs — so the add-
// liquidity screen calls this and shows an unmissable notice for anything the
// registry does not vouch for.
//
// Fail-closed for the WARNING, fail-open for nothing: if the registry cannot be
// read we return `null` (unknown) and the UI treats unknown as "not verified",
// i.e. it still warns. It never silently marks an unknown token as trusted.
//
// No browser globals — importable by the e2e suite.
// ---------------------------------------------------------------------------

import { Contract, isAddress, type ContractRunner } from 'ethers';
import { TOKEN_REGISTRY_ADDRESS } from '../config.ts';

export const TOKEN_REGISTRY_ABI = ['function isFactoryToken(address token) view returns (bool)'] as const;

/**
 * Whether `tokenAddress` is a token minted by the official TokenFactory.
 *
 * @returns `true` / `false` from the registry, or `null` when the registry is
 *          not configured, the address is malformed, or the call fails — an
 *          "unknown" the caller must treat as NOT verified.
 */
export async function isFactoryToken(
  runner: ContractRunner,
  tokenAddress: string,
  registryAddress: string = TOKEN_REGISTRY_ADDRESS,
): Promise<boolean | null> {
  if (!isAddress(registryAddress) || !isAddress(tokenAddress)) return null;
  try {
    const registry = new Contract(registryAddress, TOKEN_REGISTRY_ABI, runner);
    return (await registry.isFactoryToken(tokenAddress)) as boolean;
  } catch {
    return null;
  }
}
