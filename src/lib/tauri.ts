// Typed wrappers around the Rust commands in src-tauri/src/lib.rs.
//
// gtrack is a reader. Nothing here mutates a repository — `scanRepos` runs
// git queries, and its only side effect, when `fetch` is true, is updating
// remote-tracking refs.

import { invoke } from "@tauri-apps/api/core";

export type RemoteKind = "ssh-alias" | "ssh" | "https" | "none";

export interface Versions {
  package: string | null;
  cargo: string | null;
  tauri: string | null;
  /** False when two files that both declare a version disagree. */
  agree: boolean;
}

export interface RepoStatus {
  name: string;
  path: string;
  group: string;
  branch: string | null;
  upstream: string | null;
  remote: string | null;
  remoteKind: RemoteKind;
  ahead: number;
  behind: number;
  dirty: number;
  /** Whether ahead/behind were computed against freshly fetched refs. */
  fetched: boolean;
  fetchError: string | null;
  versions: Versions;
  latestTag: string | null;
  tagDate: string | null;
  commitsSinceTag: number | null;
  locks: string[];
  flags: string[];
}

export interface Group {
  label: string;
  repos: string[];
}

export interface Root {
  path: string;
  /** Heading for repos this root's named groups don't claim. Explicit rather
   *  than derived from the directory name, because the same collection lives
   *  at different paths on different machines. */
  label: string | null;
}

export interface Config {
  roots: Root[];
  groups: Group[];
}

export const loadConfig = () => invoke<Config>("load_config");
export const saveConfig = (cfg: Config) => invoke<void>("save_config", { cfg });
export const scanRepos = (fetch: boolean) => invoke<RepoStatus[]>("scan_repos", { fetch });

/** Which of three lenses a repo falls under.
 *
 *  The split matters for how it reads: `dirty` is work you did and can finish
 *  — uncommitted changes, unpushed commits, commits behind. `config` is the
 *  setup being wrong in a way that will bite later: a remote that 403s, a lock
 *  blocking every write, three version files disagreeing. Showing both as one
 *  undifferentiated red count made a tidy machine look alarming.
 *
 *  Derived from the flags Rust already computed, deliberately. Recomputing the
 *  same judgement in TypeScript is what let a serialisation bug colour broken
 *  repos green while their flags said otherwise. */
export type Bucket = "clean" | "dirty" | "config";

const CONFIG_FLAGS = new Set([
  "stale lock",
  "no upstream",
  "unreachable",
  "https remote",
  "version mismatch",
]);

export function bucket(r: RepoStatus): Bucket {
  if (r.flags.some((f) => CONFIG_FLAGS.has(f))) return "config";
  return r.flags.length > 0 ? "dirty" : "clean";
}

export function severity(r: RepoStatus): "alert" | "warn" | "ok" {
  const b = bucket(r);
  return b === "config" ? "alert" : b === "dirty" ? "warn" : "ok";
}

export type Filter = "all" | "clean" | "dirty" | "https";

export function matches(r: RepoStatus, f: Filter): boolean {
  switch (f) {
    case "all":
      return true;
    case "https":
      return r.remoteKind === "https";
    default:
      return bucket(r) === f;
  }
}

export interface Counts {
  clean: number;
  dirty: number;
  config: number;
}

export function counts(rows: RepoStatus[]): Counts {
  const c: Counts = { clean: 0, dirty: 0, config: 0 };
  for (const r of rows) c[bucket(r)]++;
  return c;
}
