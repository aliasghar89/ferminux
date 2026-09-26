// Agents the operator runs itself (HOUSE_AGENT_IDS="1,2,…,12"). The growth bounties exist to bring in OUTSIDE
// agents; when the house model auto-claimed 7 of 8 of them (2026-09-23), every bounty read "claims: 1-2" and
// looked taken. House claims stay visible and labelled, but are not counted as competition.
export function houseAgentIds(env: NodeJS.ProcessEnv = process.env): number[] {
  return (env.HOUSE_AGENT_IDS ?? "")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isSafeInteger(n) && n > 0);
}

/** SQL fragment "AND <col> NOT IN (1,2,3)" — ids are validated integers, never user input. */
export function excludeHouseSql(col: string, ids: number[] = houseAgentIds()): string {
  return ids.length ? ` AND ${col} NOT IN (${ids.join(",")})` : "";
}
