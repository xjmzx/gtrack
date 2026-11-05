// The upstream tab: other people's projects, cloned to follow.
//
// Every clone here is expected to be a one-to-one copy of its upstream, so a
// row says one of a few things: in sync, behind (a fast-forward away), stuck
// (no fast-forward possible), or drifted from the upstream. Whether the
// project itself is still moving rides beside that as `inactive`.
//
// Same contract as the main tab: nothing here writes to a repository, and the
// only network call is an explicit fetch. gtrack does not fast-forward —
// it shows what is behind; updating is done outside it.

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, RefreshCw, TriangleAlert } from "lucide-react";
import { cn } from "../lib/cn";
import type { Prefs } from "../lib/prefs";
import {
  groupStanding,
  kind,
  scanUpstream,
  scanUpstreamRepo,
  standing,
  upstreamCounts,
  upstreamMatches,
  type Standing,
  type UpstreamFilter,
  type UpstreamStatus,
} from "../lib/upstream";
import { barClip } from "./RepoRow";

/** Tones per standing: the margin bar, the group dot and the filter count. */
const TONE: Record<Standing, { bar: string; dot: string; text: string; box: string; hint: string }> = {
  stuck: {
    bar: "bg-alert",
    dot: "bg-alert",
    text: "text-alert",
    box: "bg-alert/25 text-alert font-semibold",
    hint: "No fast-forward possible — local commits the upstream lacks (usually an upstream force-push), no upstream to follow, or a remote that failed",
  },
  behind: {
    bar: "bg-warn",
    dot: "bg-warn",
    text: "text-warn",
    box: "bg-warn/15 text-warn",
    hint: "Behind its upstream and otherwise identical — a fast-forward away from current",
  },
  differs: {
    bar: "bg-warn/60",
    dot: "bg-warn",
    text: "text-warn",
    box: "bg-warn/15 text-warn",
    hint: "No longer a one-to-one copy — files edited, or files the upstream does not have. Permission-only changes are not counted",
  },
  pinned: {
    bar: "bg-mauve/60",
    dot: "bg-mauve",
    text: "text-mauve",
    box: "bg-mauve/15 text-mauve",
    hint: "Checked out at a tag or commit rather than a branch — pinned on purpose, so there is nothing to be behind",
  },
  synced: {
    bar: "bg-ok/50",
    dot: "bg-ok",
    text: "text-ok",
    box: "bg-ok/15 text-ok",
    hint: "Identical to its upstream",
  },
  inactive: {
    bar: "bg-muted/40",
    dot: "bg-muted/50",
    text: "text-muted",
    box: "bg-muted/15 text-muted",
    hint: "The upstream has had no commits for a year or more (upstream.inactive_days in gtrack.json)",
  },
};

/** Chip tone and hint for one flag, by its kind (`633 behind` → `behind`). */
function chip(flag: string, r: UpstreamStatus): { tone: string; hint: string } {
  switch (kind(flag)) {
    case "behind":
      return { tone: "bg-warn/15 text-warn", hint: `${r.behind} commits on ${r.upstream ?? "the upstream"} not yet here — a fast-forward brings it current` };
    case "edited":
      return { tone: "bg-warn/15 text-warn", hint: "Tracked files whose content differs from the checkout. Permission-only changes are ignored" };
    case "untracked":
      return { tone: "bg-warn/15 text-warn", hint: "Files git does not track and is not told to ignore" };
    case "detached":
      return { tone: "bg-mauve/15 text-mauve", hint: `Checked out at ${r.detachedAt ?? "a commit"} rather than a branch — pinned, so nothing to be behind` };
    case "inactive":
      return { tone: "bg-muted/15 text-muted", hint: `No upstream commits for ${r.idleDays ?? "?"} days — the project has gone quiet` };
    case "diverged":
      return {
        tone: "bg-alert/20 text-alert",
        hint: `${r.ahead} commits here the upstream lacks, and ${r.behind} the other way. On a clone kept only to follow, that is almost always an upstream history rewrite — a fresh clone is the clean way back`,
      };
    case "local":
      return { tone: "bg-alert/20 text-alert", hint: `${r.ahead} commits here that the upstream does not have — a fast-forward is not possible` };
    case "orphan":
      return { tone: "bg-alert/20 text-alert", hint: "The remote answered: no such repository — deleted, renamed, or not visible to this machine" };
    case "unreachable":
      return { tone: "bg-alert/20 text-alert", hint: r.fetchError ?? "The fetch failed — network, DNS or credentials" };
    case "no upstream":
      return { tone: "bg-alert/20 text-alert", hint: "The branch tracks nothing, so there is no upstream to compare against" };
    case "no remote":
      return { tone: "bg-alert/20 text-alert", hint: "No remote at all — nothing to follow" };
    case "stale lock":
      return { tone: "bg-alert/20 text-alert", hint: `Zero-byte lock files under .git: ${r.locks.join(", ")}` };
    default:
      return { tone: "bg-warn/15 text-warn", hint: flag };
  }
}

function Dot({ s }: { s: Standing }) {
  return (
    <span
      className={cn("h-[7px] w-[7px] rounded-full shrink-0", TONE[s].dot)}
      title={TONE[s].hint}
      aria-label={TONE[s].hint}
      role="img"
    />
  );
}

function Count({ n, s }: { n: number; s: Standing }) {
  if (n === 0) return null;
  return (
    <span className={cn("px-1.5 rounded min-w-[1.5rem] text-center", TONE[s].box)} title={`${n} ${s}`}>
      {n}
    </span>
  );
}

function Row({
  r,
  zebra,
  first,
  last,
  busy,
  locked,
  onFetch,
}: {
  r: UpstreamStatus;
  zebra: boolean;
  first: boolean;
  last: boolean;
  busy: boolean;
  locked: boolean;
  onFetch: (path: string) => void;
}) {
  const s = standing(r);
  // The default branch names say nothing; anything else is worth a glance.
  const showBranch = r.branch && r.branch !== "main" && r.branch !== "master";
  return (
    <div className={cn("group/row hover:bg-surfaceHover/50 transition-colors", zebra && "bg-surface/40")} title={r.path}>
      <div className="grid grid-cols-[6px_minmax(9rem,1fr)_minmax(0,1fr)] md:grid-cols-[6px_minmax(12rem,22rem)_6rem_minmax(0,1fr)] items-center gap-x-3 pr-2 max-w-[64rem] min-h-7">
        <div className={cn("h-6 w-1.5", TONE[s].bar)} style={{ clipPath: barClip(first, last) }} />

        <div className="min-w-0 flex items-baseline gap-1.5">
          <span className="text-sm text-fg truncate leading-snug" title={r.name}>
            {r.name}
          </span>
          {showBranch && <span className="text-[11px] font-mono text-fg/60 shrink-0">{r.branch}</span>}
          {r.detachedAt && <span className="text-[11px] font-mono text-fg/60 shrink-0">@{r.detachedAt}</span>}
          <span className="ml-auto self-center shrink-0 flex items-center">
            {r.remote && (
              <button
                onClick={() => onFetch(r.path)}
                disabled={locked}
                title="Fetch this clone only"
                aria-label={`Fetch ${r.name} only`}
                className={cn(
                  "self-center shrink-0 p-0.5 rounded text-muted hover:text-fg hover:bg-fg/10 transition-opacity disabled:cursor-default",
                  busy
                    ? "opacity-100"
                    : "opacity-[0.55] group-hover/row:opacity-100 focus-visible:opacity-100 disabled:!opacity-[0.55]",
                )}
              >
                <RefreshCw size={11} className={busy ? "animate-spin" : ""} />
              </button>
            )}
          </span>
        </div>

        {/* The project's last sign of life, read off the upstream. */}
        <div
          className="hidden md:block font-mono text-[11px] tabular-nums text-fg/60 leading-snug"
          title={r.idleDays != null ? `Newest upstream commit, ${r.idleDays} days ago` : "No upstream commit to date"}
        >
          {r.upstreamDate ?? <span className="text-muted/60">—</span>}
        </div>

        <div className="flex items-center gap-1.5 min-w-0 overflow-hidden">
          {r.flags.length === 0 ? (
            <span className="px-1.5 py-px rounded text-[11px] font-mono shrink-0 leading-snug bg-ok/10 text-ok/50" title={TONE.synced.hint}>
              in sync
            </span>
          ) : (
            r.flags.map((f) => {
              const c = chip(f, r);
              return (
                <span key={f} className={cn("px-1.5 py-px rounded text-[11px] font-mono shrink-0 leading-snug", c.tone)} title={c.hint}>
                  {f}
                </span>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

export interface UpstreamViewProps {
  /** Shown or hidden — the view stays mounted either way, so switching tabs
   *  keeps what the last fetch found. */
  active: boolean;
  /** The wordmark and tab switch, shared with the main tab's header. */
  brand: ReactNode;
  prefs: Prefs;
  update: (fn: (p: Prefs) => Prefs) => void;
}

export function UpstreamView({ active, brand, prefs, update }: UpstreamViewProps) {
  const [rows, setRows] = useState<UpstreamStatus[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scanned, setScanned] = useState(false);
  const [scannedAt, setScannedAt] = useState<Date | null>(null);
  const [wasFetched, setWasFetched] = useState(false);
  const [filter, setFilter] = useState<UpstreamFilter>("all");
  const [single, setSingle] = useState<Map<string, Date>>(new Map());
  const [rowBusy, setRowBusy] = useState<Set<string>>(new Set());

  const run = useCallback(async (fetch: boolean) => {
    setBusy(true);
    setError(null);
    try {
      setRows(await scanUpstream(fetch));
      setSingle(new Map());
      setScannedAt(new Date());
      setWasFetched(fetch);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
      setScanned(true);
    }
  }, []);

  const runOne = useCallback(async (path: string) => {
    setRowBusy((prev) => new Set(prev).add(path));
    setError(null);
    try {
      const row = await scanUpstreamRepo(path, true);
      setRows((prev) => prev.map((r) => (r.path === path ? row : r)));
      setSingle((prev) => new Map(prev).set(path, new Date()));
    } catch (e) {
      setError(String(e));
    } finally {
      setRowBusy((prev) => {
        const next = new Set(prev);
        next.delete(path);
        return next;
      });
    }
  }, []);

  // A local scan the first time the tab is shown, not on launch: the main tab
  // is what opens instantly, and forty-odd large clones should not slow it.
  useEffect(() => {
    if (active && !scanned && !busy) void run(false);
  }, [active, scanned, busy, run]);

  const anyBusy = busy || rowBusy.size > 0;
  const total = useMemo(() => upstreamCounts(rows), [rows]);
  const shown = useMemo(() => rows.filter((r) => upstreamMatches(r, filter)), [rows, filter]);
  const grouped = useMemo(() => {
    const by = new Map<string, UpstreamStatus[]>();
    for (const r of shown) {
      const list = by.get(r.group) ?? [];
      list.push(r);
      by.set(r.group, list);
    }
    return [...by.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [shown]);

  // First run collapses everything, as the main tab does.
  useEffect(() => {
    if (prefs.upstreamSeeded || rows.length === 0) return;
    const labels = [...new Set(rows.map((r) => r.group))];
    update((p) => ({ ...p, upstreamCollapsed: labels, upstreamSeeded: true }));
  }, [rows, prefs.upstreamSeeded, update]);

  const collapsed = useMemo(() => new Set(prefs.upstreamCollapsed), [prefs.upstreamCollapsed]);
  const toggle = (label: string) =>
    update((p) => ({
      ...p,
      upstreamCollapsed: p.upstreamCollapsed.includes(label)
        ? p.upstreamCollapsed.filter((l) => l !== label)
        : [...p.upstreamCollapsed, label],
    }));
  const allCollapsed = grouped.length > 0 && grouped.every(([l]) => collapsed.has(l));
  const toggleAll = () => update((p) => ({ ...p, upstreamCollapsed: allCollapsed ? [] : grouped.map(([l]) => l) }));

  const filters: [UpstreamFilter, number, string, string][] = [
    ["all", rows.length, "text-fg", "Every tracked clone"],
    ["synced", total.synced, TONE.synced.text, TONE.synced.hint],
    ["behind", total.behind, TONE.behind.text, TONE.behind.hint],
    ["stuck", total.stuck, TONE.stuck.text, TONE.stuck.hint],
    ["differs", total.differs, TONE.differs.text, TONE.differs.hint],
    ["pinned", rows.filter((r) => r.flags.includes("detached")).length, TONE.pinned.text, TONE.pinned.hint],
    ["inactive", rows.filter((r) => r.flags.includes("inactive")).length, TONE.inactive.text, TONE.inactive.hint],
  ];

  return (
    <div className={cn("min-h-full flex flex-col", !active && "hidden")}>
      <header className="flex items-center gap-2 px-2.5 py-1.5 border-b border-surface/60">
        {brand}
        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={toggleAll}
            title={allCollapsed ? "Expand every category" : "Collapse every category"}
            aria-label={allCollapsed ? "Expand every category" : "Collapse every category"}
            className="px-1.5 py-1 rounded text-muted hover:text-fg hover:bg-fg/5 transition-colors"
          >
            {allCollapsed ? <ChevronsUpDown size={13} /> : <ChevronsDownUp size={13} />}
          </button>
          <div className="flex items-center rounded overflow-hidden border border-surfaceHover">
            {filters.map(([key, n, tone, hint]) => (
              <button
                key={key}
                onClick={() => setFilter(key)}
                title={hint}
                className={cn(
                  "px-2 py-1 text-xs font-mono transition-colors",
                  filter === key ? "bg-surfaceHover text-fg" : "text-fg/70 hover:text-fg hover:bg-fg/5",
                )}
              >
                {key}
                <span className={cn("ml-1 tabular-nums", filter === key ? tone : "text-fg/55")}>{n}</span>
              </button>
            ))}
          </div>
          <button
            onClick={() => void run(false)}
            disabled={anyBusy}
            title="Re-read local state. No network."
            className="px-2.5 py-1 rounded text-xs font-mono text-fg bg-surfaceHover hover:bg-fg/10 disabled:opacity-40 transition-colors"
          >
            rescan
          </button>
          <button
            onClick={() => void run(true)}
            disabled={anyBusy}
            title="Fetch every tracked clone's remote, then rescan"
            className="flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-mono text-bg bg-fg hover:bg-fg/85 disabled:opacity-40 transition-colors"
          >
            <RefreshCw size={11} className={busy ? "animate-spin" : ""} />
            fetch
          </button>
        </div>
      </header>

      {/* Behind and inactive are only as current as the last fetch, and the
          banner says which it is — the main tab's rule, for the same reason. */}
      <div
        className={cn(
          "px-2.5 py-1 text-[11px] font-mono flex items-center gap-1.5 leading-snug",
          wasFetched ? "bg-ok/10 text-ok" : "bg-warn/10 text-warn",
        )}
      >
        {!wasFetched && <TriangleAlert size={10} className="shrink-0" />}
        {wasFetched
          ? `fetched ${scannedAt?.toLocaleTimeString() ?? ""} — behind and activity current`
          : "local refs only — behind and activity are as of each clone's last fetch"}
        {single.size > 0 && (
          <span className="opacity-70">
            · {single.size} {single.size === 1 ? "clone" : "clones"} fetched alone{wasFetched ? " since" : ""}
          </span>
        )}
      </div>

      {error && <div className="px-2.5 py-1 bg-alert/10 text-alert text-[11px] break-all">{error}</div>}

      <main className="flex-1 overflow-y-auto">
        {grouped.map(([label, list]) => {
          const isOpen = filter !== "all" || !collapsed.has(label);
          const c = upstreamCounts(list);
          return (
            <section key={label}>
              <button
                onClick={() => toggle(label)}
                className="w-full sticky top-0 z-10 bg-panel/95 backdrop-blur px-2 py-1.5 flex items-center gap-2 border-y border-surface/60 hover:bg-surface/60 transition-colors text-left"
              >
                <span className="flex items-center gap-1.5 shrink-0">
                  <Dot s={groupStanding(list)} />
                  {isOpen ? (
                    <ChevronDown size={14} className="text-muted shrink-0" />
                  ) : (
                    <ChevronRight size={14} className="text-muted shrink-0" />
                  )}
                </span>
                <span className="text-xs uppercase tracking-wider text-fg/80 font-medium">{label}</span>
                <span className="ml-auto flex items-center gap-1.5 text-[11px] font-mono tabular-nums">
                  <Count n={c.synced} s="synced" />
                  <Count n={c.behind} s="behind" />
                  <Count n={c.differs} s="differs" />
                  <Count n={c.pinned} s="pinned" />
                  <Count n={c.inactive} s="inactive" />
                  <Count n={c.stuck} s="stuck" />
                </span>
              </button>
              {isOpen &&
                list.map((r, i) => (
                  <Row
                    key={r.path}
                    r={r}
                    zebra={i % 2 === 1}
                    first={i === 0}
                    last={i === list.length - 1}
                    busy={rowBusy.has(r.path)}
                    locked={anyBusy}
                    onFetch={(p) => void runOne(p)}
                  />
                ))}
            </section>
          );
        })}
        {grouped.length === 0 && !busy && scanned && (
          <p className="px-3 py-8 text-[11px] text-muted text-center">
            {filter !== "all"
              ? `Nothing matches "${filter}".`
              : "No clones found — the upstream tab reads upstream.roots in gtrack.json (default ~/code)."}
          </p>
        )}
      </main>

      <footer className="px-2.5 py-1 border-t border-surface/60 text-[11px] text-fg/70 flex items-center gap-3 leading-snug">
        <span>{rows.length} clones</span>
        <span className="hidden sm:inline text-fg/55">read-only · tracked, not developed</span>
        <span className="ml-auto text-fg/55">ndisc suite</span>
      </footer>
    </div>
  );
}
