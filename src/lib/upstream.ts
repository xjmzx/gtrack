// The upstream tab: other people's projects, cloned to follow.
//
// Typed wrappers around `scan_upstream` / `scan_upstream_repo` in
// src-tauri/src/lib.rs, and the reading of their flags. Kept apart from
// lib/tauri.ts on purpose — the main tab's buckets ask whether your work is
// safe, and these ask whether a clone still matches its upstream. Sharing one
// `bucket` would mean every new flag here had to be taught to the other tab.

import { invoke } from "@tauri-apps/api/core";

export interface UpstreamStatus {
  /** Directory name, or `sub/name` one folder deeper inside its category. */
  name: string;
  path: string;
  /** The category folder: bitcoin, nostr, … */
  group: string;
  /** `null` when HEAD is detached. */
  branch: string | null;
  /** The tag or short hash a detached HEAD sits on. */
  detachedAt: string | null;
  upstream: string | null;
  remote: string | null;
  ahead: number;
  behind: number;
  /** Tracked files whose content differs. Permission-only changes are not counted. */
  edited: number;
  untracked: number;
  /** Newest commit on the upstream, as of the last fetch. */
  upstreamDate: string | null;
  idleDays: number | null;
  fetched: boolean;
  fetchError: string | null;
  locks: string[];
  flags: string[];
}

export const scanUpstream = (fetch: boolean) => invoke<UpstreamStatus[]>("scan_upstream", { fetch });
/** One clone. Refused by Rust for any path the upstream roots do not hold. */
export const scanUpstreamRepo = (path: string, fetch: boolean) =>
  invoke<UpstreamStatus>("scan_upstream_repo", { path, fetch });

/** How a tracked clone stands against its upstream.
 *
 *  - `stuck` — a plain fast-forward is not possible: a broken remote, nothing
 *    to follow, or local commits the upstream lacks.
 *  - `behind` — a fast-forward away from current.
 *  - `differs` — local edits or stray files. Not stuck (a fast-forward may well
 *    go through), but no longer the one-to-one copy this tab expects.
 *  - `pinned` — a detached HEAD, usually on a release tag. A choice.
 *  - `inactive` — identical to an upstream that has stopped moving.
 *  - `synced` — identical to a live upstream. */
export type Standing = "stuck" | "behind" | "differs" | "pinned" | "inactive" | "synced";

const STUCK = new Set(["stale lock", "no remote", "no upstream", "orphan", "unreachable", "diverged"]);

/** The flag kinds, with their counts stripped: `633 behind` → `behind`. */
export function kind(flag: string): string {
  return flag.replace(/^\d+ /, "");
}

/** Read off the flags Rust computed — never re-judged from the raw counts,
 *  for the reason lib/tauri.ts gives: one judgement, made in one place. */
export function standing(r: UpstreamStatus): Standing {
  const kinds = r.flags.map(kind);
  if (kinds.some((k) => STUCK.has(k) || k === "local")) return "stuck";
  if (kinds.includes("behind")) return "behind";
  if (kinds.includes("edited") || kinds.includes("untracked")) return "differs";
  if (kinds.includes("detached")) return "pinned";
  if (kinds.includes("inactive")) return "inactive";
  return "synced";
}

/** The group roll-up: the worst standing among its clones. A `Record`, so a
 *  standing added later without a rank is a compile error rather than the
 *  blank window `SEVERITY_RANK` once produced in the main tab. */
const RANK: Record<Standing, number> = {
  stuck: 0,
  behind: 1,
  differs: 2,
  pinned: 3,
  synced: 4,
  // Below `synced`, as `archive` is in the main tab: a quiet project is a
  // settled fact, and one among ten live ones should not grey the group.
  inactive: 5,
};

export function groupStanding(rows: UpstreamStatus[]): Standing {
  let worst: Standing = "synced";
  let first = true;
  for (const r of rows) {
    const s = standing(r);
    if (first || RANK[s] < RANK[worst]) worst = s;
    first = false;
  }
  return worst;
}

export type UpstreamCounts = Record<Standing, number>;

export function upstreamCounts(rows: UpstreamStatus[]): UpstreamCounts {
  const c: UpstreamCounts = { stuck: 0, behind: 0, differs: 0, pinned: 0, inactive: 0, synced: 0 };
  for (const r of rows) c[standing(r)]++;
  return c;
}

export type UpstreamFilter = "all" | Standing;

/** By flag where a flag exists, so an inactive project that is also behind
 *  still turns up under `inactive` — the filter asks a question, and the
 *  answer is not limited to rows whose worst standing it happens to be. */
export function upstreamMatches(r: UpstreamStatus, f: UpstreamFilter): boolean {
  if (f === "all") return true;
  if (f === "inactive") return r.flags.includes("inactive");
  if (f === "pinned") return r.flags.includes("detached");
  return standing(r) === f;
}
