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
  /** package-lock.json. `npm version` keeps it in step; a hand-edit does not. */
  lock: string | null;
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

/** A repository deleted on purpose, and what it was.
 *
 *  The only thing gtrack describes that it cannot scan — every other row
 *  measures something on disk. It exists because deletion alone does not
 *  answer the question that made this tool: a dead end removed is cheaper to
 *  store but no easier to identify later, when its name still turns up in a
 *  deploy note with nothing behind it. */
export interface Tombstone {
  name: string;
  /** ISO date. Optional, so an already-deleted backlog can still be written. */
  removed: string | null;
  /** What it was, and where anything worth keeping survives. */
  note: string | null;
}

export interface Config {
  roots: Root[];
  groups: Group[];
  /** Repos retired on purpose. A repo with no remote is *derived* to be an
   *  archive; this is the other half — one whose remote still exists but has
   *  been retired, which nothing on disk could reveal. */
  archived: string[];
  /** Repos deleted on purpose, kept as notes rather than trees. */
  retired: Tombstone[];
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
export type Bucket = "clean" | "dirty" | "config" | "archive" | "unpinned";

/** Things that are actually broken, and stay red.
 *
 *  `unpinned` is deliberately not among them. A remote that does not name the
 *  account it authenticates as fetches perfectly well and usually pushes fine
 *  too — it only bites on a machine with several identities, and then only on
 *  a write. Red made a tidy machine read as an emergency over a URL form. */
const CONFIG_FLAGS = new Set([
  "stale lock",
  "no upstream",
  // Both halves of what used to be one flag. `orphan` is red for a different
  // reason than the others: nothing is broken, a decision is missing — either
  // drop the remote and keep it as an archive, or delete it and leave a
  // tombstone. It stays red until one of those is made, which is the point.
  "orphan",
  "unreachable",
  "version mismatch",
]);

export function bucket(r: RepoStatus): Bucket {
  // Config first: an archive or an unpinned remote with a stale lock or
  // disagreeing version files still has a fault worth the red. Only otherwise
  // sound ones reach their own bucket — those flags describe how a repo is
  // set up, not that something is wrong with it.
  if (r.flags.some((f) => CONFIG_FLAGS.has(f))) return "config";
  if (r.flags.includes("archive")) return "archive";
  // Above `dirty`, as it was when this counted as config: a remote protocol
  // persists until someone changes it, where uncommitted work turns over daily.
  if (r.flags.includes("unpinned")) return "unpinned";
  return r.flags.length > 0 ? "dirty" : "clean";
}

export type Severity = "alert" | "warn" | "ok" | "archive" | "unpinned";

export function severity(r: RepoStatus): Severity {
  const b = bucket(r);
  switch (b) {
    case "config":
      return "alert";
    case "dirty":
      return "warn";
    case "archive":
      return "archive";
    case "unpinned":
      return "unpinned";
    default:
      return "ok";
  }
}

export type Filter = "all" | "clean" | "dirty" | "unpinned" | "archive";

export function matches(r: RepoStatus, f: Filter): boolean {
  switch (f) {
    case "all":
      return true;
    case "unpinned":
      // The flag, not the remote kind: `unpinned` covers https *and* bare
      // git@github.com, and duplicating that judgement here is what let a
      // serialisation bug disagree with the flags once already.
      return r.flags.includes("unpinned");
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
  unpinned: number;
}

export function counts(rows: RepoStatus[]): Counts {
  const c: Counts = { clean: 0, dirty: 0, config: 0, archive: 0, unpinned: 0 };
  for (const r of rows) c[bucket(r)]++;
  return c;
}
