// What the last fetch measured, remembered between launches.
//
// Visibility and the account check are both measured only during a fetch, and
// gtrack never fetches on its own — so without this every launch showed no
// lock and no verified key until someone clicked fetch, which is exactly when
// the reminder was not needed. Both change rarely enough that the last answer
// is almost always still true.
//
// Almost is not always, so a remembered answer is drawn dimmed and says it is
// remembered, and only a fetch in this session draws it at full strength. The
// same rule as ahead/behind: stale is shown as stale, never passed off as
// current.
//
// localStorage rather than gtrack.json, for the reason prefs.ts gives: this is
// a cache of something measured, not configuration anyone decides.

import type { RepoStatus, Visibility } from "./tauri";

/** Keyed by path *and* remote URL. A tree re-pointed at another remote is
 *  another repository as far as GitHub is concerned, and inheriting the old
 *  one's answer would be a confident wrong one. */
export type Cache<T> = Record<string, T>;

const keyOf = (r: RepoStatus) => `${r.path}\n${r.remote ?? ""}`;

export interface Shown<T> {
  value: T;
  /** Measured by a fetch in this session, rather than remembered. */
  confirmed: boolean;
}

/** What one scan says about a remembered value.
 *
 *  Three answers, not two, and the third is the reason for the type: `null`
 *  is a measurement that there is nothing to remember — a key found on the
 *  wrong account must erase a remembered pass — where `undefined` is no
 *  measurement at all, and must keep what was there. */
type Measure<T> = (r: RepoStatus) => T | null | undefined;

export interface Memory<T> {
  shown(r: RepoStatus, cache: Cache<T>): Shown<T> | null;
  /** After a full scan: record every measurement, and drop trees no longer on
   *  disk so the cache cannot outgrow the machine. */
  remember(cache: Cache<T>, rows: RepoStatus[]): Cache<T>;
  /** After a single-repo scan: record that one, and touch nothing else. A
   *  one-row list must not prune the other sixty. */
  rememberOne(cache: Cache<T>, row: RepoStatus): Cache<T>;
  load(): Cache<T>;
  save(cache: Cache<T>): void;
}

function memory<T>(storageKey: string, measure: Measure<T>, valid: (v: unknown) => v is T): Memory<T> {
  const apply = (next: Cache<T>, prev: Cache<T>, r: RepoStatus) => {
    const k = keyOf(r);
    const m = measure(r);
    if (m === null) delete next[k];
    else if (m !== undefined) next[k] = m;
    else if (prev[k] !== undefined) next[k] = prev[k];
  };
  return {
    shown(r, cache) {
      const m = measure(r);
      if (m !== null && m !== undefined) return { value: m, confirmed: true };
      // Measured absent this session: the memory is known wrong, draw nothing.
      if (m === null) return null;
      const v = cache[keyOf(r)];
      return v !== undefined ? { value: v, confirmed: false } : null;
    },
    remember(cache, rows) {
      const next: Cache<T> = {};
      for (const r of rows) apply(next, cache, r);
      return next;
    },
    rememberOne(cache, row) {
      const next: Cache<T> = { ...cache };
      delete next[keyOf(row)];
      apply(next, cache, row);
      return next;
    },
    load() {
      try {
        const raw = localStorage.getItem(storageKey);
        const parsed: unknown = raw ? JSON.parse(raw) : {};
        if (!parsed || typeof parsed !== "object") return {};
        const out: Cache<T> = {};
        for (const [k, v] of Object.entries(parsed)) if (valid(v)) out[k] = v;
        return out;
      } catch {
        return {};
      }
    },
    save(cache) {
      try {
        localStorage.setItem(storageKey, JSON.stringify(cache));
      } catch {
        /* Storage unavailable — markers still appear after a fetch, just not on open. */
      }
    },
  };
}

/** Private or public. A fetch either measures it or cannot tell, so it is
 *  never measured absent — `undefined` when unknown. */
export const visibilityMemory = memory<Visibility>(
  "gtrack.visibility",
  (r) => r.visibility ?? undefined,
  (v): v is Visibility => v === "public" || v === "private",
);

/** The account a pinned key was verified to push as. Only a pass is kept; a
 *  mismatch is measured-absent and erases it, since a remembered green key
 *  beside a red `other account` would contradict the row it sits on. */
export const accountMemory = memory<string>(
  "gtrack.account",
  (r) => (r.account === "owner" ? r.authenticatesAs : r.account === "other" ? null : undefined),
  (v): v is string => typeof v === "string" && v.length > 0,
);
