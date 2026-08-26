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
export type Bucket = "clean" | "dirty" | "config" | "archive" | "https";

/** Things that are actually broken, and stay red.
 *
 *  `https remote` is deliberately not among them. It is a house preference —
 *  every remote on an SSH alias, so GitHub actions run as the right account —
 *  not a fault: an https remote fetches perfectly well and most of them push
 *  too. Red made a tidy machine read as an emergency over a naming choice. */
const CONFIG_FLAGS = new Set([
  "stale lock",
  "no upstream",
  "unreachable",
  "version mismatch",
]);

export function bucket(r: RepoStatus): Bucket {
  // Config first: an archive or an https remote with a stale lock or
  // disagreeing version files still has a fault worth the red. Only otherwise
  // sound ones reach their own bucket — those flags describe how a repo is
  // set up, not that something is wrong with it.
  if (r.flags.some((f) => CONFIG_FLAGS.has(f))) return "config";
  if (r.flags.includes("archive")) return "archive";
  // Above `dirty`, as it was when this counted as config: a remote protocol
  // persists until someone changes it, where uncommitted work turns over daily.
  if (r.flags.includes("https remote")) return "https";
  return r.flags.length > 0 ? "dirty" : "clean";
}

export type Severity = "alert" | "warn" | "ok" | "archive" | "https";

export function severity(r: RepoStatus): Severity {
  const b = bucket(r);
  switch (b) {
    case "config":
      return "alert";
    case "dirty":
      return "warn";
    case "archive":
      return "archive";
    case "https":
      return "https";
    default:
      return "ok";
  }
}

export type Filter = "all" | "clean" | "dirty" | "https" | "archive";

export function matches(r: RepoStatus, f: Filter): boolean {
  switch (f) {
    case "all":
      return true;
    case "https":
      return r.remoteKind === "https";
    case "archive":
      // The flag, not the bucket: an archive that also has a fault sits in
      // `config`, and hiding it from its own lens would be the wrong answer.
      return r.flags.includes("archive");
    default:
      return bucket(r) === f;
  }
}

export interface Counts {
  clean: number;
  dirty: number;
  config: number;
  archive: number;
  https: number;
}

export function counts(rows: RepoStatus[]): Counts {
  const c: Counts = { clean: 0, dirty: 0, config: 0, archive: 0, https: 0 };
  for (const r of rows) c[bucket(r)]++;
  return c;
}
