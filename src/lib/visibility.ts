// Last-known visibility, remembered between launches.
//
// Visibility is measured only during a fetch, and gtrack never fetches on its
// own — so without this every launch showed no `private` chip at all until
// someone clicked fetch, which is exactly when the reminder was not needed.
// It changes rarely enough that the last answer is almost always still true.
//
// Almost is not always, so a remembered answer is drawn dimmed and says it is
// remembered, and only a fetch in this session draws it at full strength. The
// same rule as ahead/behind: stale is shown as stale, never passed off as
// current.
//
// localStorage rather than gtrack.json, for the reason prefs.ts gives: this is
// a cache of something measured, not configuration anyone decides.

import type { RepoStatus, Visibility } from "./tauri";

const KEY = "gtrack.visibility";

/** Keyed by path *and* remote URL. A tree re-pointed at another remote is
 *  another repository as far as GitHub is concerned, and inheriting the old
 *  one's answer would be a confident wrong one. */
export type VisibilityCache = Record<string, Visibility>;

const keyOf = (r: RepoStatus) => `${r.path}\n${r.remote ?? ""}`;

export interface ShownVisibility {
  value: Visibility;
  /** Measured by a fetch in this session, rather than remembered. */
  confirmed: boolean;
}

/** What to draw for a repo: this session's measurement, else the memory. */
export function shownVisibility(r: RepoStatus, cache: VisibilityCache): ShownVisibility | null {
  if (r.visibility) return { value: r.visibility, confirmed: true };
  const v = cache[keyOf(r)];
  return v ? { value: v, confirmed: false } : null;
}

/** The cache after a scan.
 *
 *  Only a measurement overwrites an entry — a fetch that could not tell (the
 *  probe failed, the fetch failed) keeps the last answer rather than erasing
 *  it. Entries for trees no longer on disk, or no longer on that remote, are
 *  dropped, so the cache cannot outgrow the machine. */
export function remember(cache: VisibilityCache, rows: RepoStatus[]): VisibilityCache {
  const next: VisibilityCache = {};
  for (const r of rows) {
    const k = keyOf(r);
    const v = r.visibility ?? cache[k];
    if (v) next[k] = v;
  }
  return next;
}

export function loadVisibility(): VisibilityCache {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== "object") return {};
    const out: VisibilityCache = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (v === "public" || v === "private") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export function saveVisibility(cache: VisibilityCache): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(cache));
  } catch {
    /* Storage unavailable — chips still appear after a fetch, just not on open. */
  }
}
