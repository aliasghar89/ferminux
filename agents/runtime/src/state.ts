import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface JobStateEntry {
  /** declined = the agent could not serve it and cancelled it on chain, so the client was credited in full */
  status: "delivered" | "abandoned" | "skipped" | "declined";
  attempts: number;
  updatedAt: number;
  reason?: string;
  tx?: string;
}

export type HandledState = Record<string, JobStateEntry>;

export function loadState(path: string): HandledState {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as HandledState;
  } catch {
    return {};
  }
}

export function saveState(path: string, state: HandledState): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2));
}
