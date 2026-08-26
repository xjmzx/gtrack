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

export interface Config {
  roots: string[];
  groups: Group[];
}

export const loadConfig = () => invoke<Config>("load_config");
export const saveConfig = (cfg: Config) => invoke<void>("save_config", { cfg });
export const scanRepos = (fetch: boolean) => invoke<RepoStatus[]>("scan_repos", { fetch });

/** Severity of a row, driving its colour. Anything that will fail later but
 *  looks fine now ranks as a warning, not a note — that is the class of
 *  problem this tool exists to surface. */
export function severity(r: RepoStatus): "alert" | "warn" | "ok" {
  if (r.locks.length > 0 || r.fetchError) return "alert";
  if (!r.versions.agree || r.remoteKind === "https" || !r.upstream) return "alert";
  if (r.ahead > 0 || r.behind > 0 || r.dirty > 0) return "warn";
  return "ok";
}
