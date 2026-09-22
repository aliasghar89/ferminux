import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface JobStateEntry {
  status: "delivered" | "abandoned" | "skipped";
  attempts: number;
  updatedAt: number;
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
