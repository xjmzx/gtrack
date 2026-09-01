import { useCallback, useEffect, useMemo, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { ChevronDown, ChevronRight, GitBranch, RefreshCw, TriangleAlert } from "lucide-react";
import { cn } from "./lib/cn";
import { loadPrefs, savePrefs, type Prefs } from "./lib/prefs";
import {
  counts,
  groupSeverity,
  loadConfig,
  matches,
  scanRepos,
  type Filter,
  type RepoStatus,
  type Severity,
  type Tombstone,
} from "./lib/tauri";
import { RepoRow } from "./components/RepoRow";

// Suite rule: the version chip shows only major.minor.patch; any pre-release
// suffix drops to the tooltip so the chip keeps a fixed width.
const shortVersion = (v: string) => v.split(/[-+]/)[0];

/** Tones and hints for the group indicator.
 *
 *  Fuller alphas than the row's severity bar, which is 28px tall and can
 *  afford to sit at half opacity. At 7px the same alpha reads as grey on a
 *  dark panel — and grey is the one tone here that already means something
 *  else, so the colours have to hold their own at this size. */
const DOT: Record<Severity, { tone: string; hint: string }> = {
  alert: {
    tone: "bg-alert",
    hint: "Something here is broken — a stale lock, a missing upstream, an unreachable or orphaned remote, or version files that disagree",
  },
  warn: { tone: "bg-warn", hint: "Local work here — uncommitted, unpushed or behind" },
  unpinned: {
    tone: "bg-mauve",
    hint: "A remote here does not name the account it authenticates as",
  },
  archive: { tone: "bg-muted/50", hint: "Nothing to do — but this group holds a local-only archive" },
  ok: { tone: "bg-ok", hint: "Everything here is clean" },
};

/** The state of a group, readable while it is closed.
 *
 *  Sits before the chevron rather than beside the counts, so the answer to
 *  "does this need opening?" is next to the control that opens it. The counts
 *  to the right still carry the breakdown; this is only the worst of them,
 *  which is what a collapsed list can be scanned for. */
function GroupDot({ sev, hint }: { sev: Severity; hint?: string }) {
  const label = hint ?? DOT[sev].hint;
  return (
    <span
      className={cn("h-[7px] w-[7px] rounded-full shrink-0", DOT[sev].tone)}
      title={label}
      aria-label={label}
      role="img"
    />
  );
}

export default function App() {
  const [repos, setRepos] = useState<RepoStatus[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [scannedAt, setScannedAt] = useState<Date | null>(null);
  const [wasFetched, setWasFetched] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  const [retired, setRetired] = useState<Tombstone[]>([]);

  useEffect(() => {
    getVersion().then(setAppVersion).catch(() => setAppVersion(null));
  }, []);

  // Tombstones come from the config, not the scan — there is nothing on disk
  // to scan. A failure here is not worth an error banner: the repo list is the
  // app, and notes about deleted trees are the footnote.
  useEffect(() => {
    loadConfig()
      .then((c) => setRetired(c.retired ?? []))
      .catch(() => setRetired([]));
  }, []);

  const update = useCallback((fn: (p: Prefs) => Prefs) => {
    setPrefs((prev) => {
      const next = fn(prev);
      savePrefs(next);
      return next;
    });
  }, []);

  const run = useCallback(async (fetch: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const rows = await scanRepos(fetch);
      setRepos(rows);
      setScannedAt(new Date());
      setWasFetched(fetch);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  // Local scan on open: cheap, no network, and what makes this glanceable
  // rather than something you wait for.
  useEffect(() => {
    void run(false);
  }, [run]);

  const shown = useMemo(() => repos.filter((r) => matches(r, filter)), [repos, filter]);
  const total = useMemo(() => counts(repos), [repos]);

  const grouped = useMemo(() => {
    const by = new Map<string, RepoStatus[]>();
    for (const r of shown) {
      const list = by.get(r.group) ?? [];
      list.push(r);
      by.set(r.group, list);
    }
    return [...by.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [shown]);

  // First run collapses everything: with fifty-odd checkouts an expanded list
  // is a wall, and the per-group counts below carry enough to choose from.
  useEffect(() => {
    if (prefs.seeded || repos.length === 0) return;
    const labels = [...new Set(repos.map((r) => r.group))];
    update((p) => ({ ...p, collapsed: labels, seeded: true }));
  }, [repos, prefs.seeded, update]);

  const collapsed = useMemo(() => new Set(prefs.collapsed), [prefs.collapsed]);

  // Newest decision first: the reason to open this section is usually to
  // remember what was just cleared out, not to browse the whole history.
  const tombstones = useMemo(
    () => [...retired].sort((a, b) => (b.removed ?? "").localeCompare(a.removed ?? "") || a.name.localeCompare(b.name)),
    [retired],
  );
  // A tombstone whose tree is on disk after all. Shown rather than resolved:
  // either it was re-cloned or the note was written before the deletion, and
  // which of those it is only the person who wrote it knows.
  const onDisk = useMemo(() => new Set(repos.map((r) => r.name)), [repos]);
  const contradicted = useMemo(() => tombstones.filter((t) => onDisk.has(t.name)).length, [tombstones, onDisk]);

  const toggle = (label: string) =>
    update((p) => ({
      ...p,
      collapsed: p.collapsed.includes(label)
        ? p.collapsed.filter((l) => l !== label)
        : [...p.collapsed, label],
    }));

  const allCollapsed = grouped.length > 0 && grouped.every(([l]) => collapsed.has(l));
  const toggleAll = () =>
    update((p) => ({ ...p, collapsed: allCollapsed ? [] : grouped.map(([l]) => l) }));

  return (
    <div className="min-h-full flex flex-col">
      <header className="flex items-center gap-2 px-2.5 py-1.5 border-b border-surface/60">
        <GitBranch size={16} className="text-accent shrink-0" />
        <span className="text-base font-bold tracking-tight select-none">
          <span className="text-accent">g</span>
          <span className="text-mauve">track</span>
        </span>
        {appVersion && (
          <span
            className="hidden lg:inline-flex items-center px-1.5 py-0.5 rounded bg-surface text-mauve font-mono text-[10px] shrink-0"
            title={`v${appVersion}`}
          >
            v{shortVersion(appVersion)}
          </span>
        )}

        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={toggleAll}
            title={allCollapsed ? "Expand every group" : "Collapse every group"}
            className="px-2 py-1 rounded text-xs font-mono text-muted hover:text-fg hover:bg-fg/5 transition-colors"
          >
            {allCollapsed ? "expand" : "collapse"}
          </button>
          <div className="flex items-center rounded overflow-hidden border border-surfaceHover">
            {(
              [
                ["all", repos.length, "text-fg", "Everything"],
                ["clean", total.clean, "text-ok", "Nothing to do"],
                ["dirty", total.dirty, "text-warn", "Work in progress — uncommitted, unpushed or behind"],
                ["unpinned", repos.filter((r) => r.flags.includes("unpinned")).length, "text-mauve", "Remote does not name the account it authenticates as — https, or a bare git@github.com. Use a host alias so pushes land on the right identity"],
                ["archive", total.archive, "text-muted", "No remote — kept deliberately as a local-only archive"],
              ] as const
            ).map(([key, n, tone, hint]) => (
              <button
                key={key}
                onClick={() => setFilter(key)}
                title={hint}
                className={cn(
                  "px-2 py-1 text-xs font-mono transition-colors",
                  filter === key ? "bg-surfaceHover text-fg" : "text-muted hover:text-fg hover:bg-fg/5",
                )}
              >
                {key}
                <span className={cn("ml-1 tabular-nums", filter === key ? tone : "text-muted/50")}>{n}</span>
              </button>
            ))}
          </div>
          <button
            onClick={() => void run(false)}
            disabled={busy}
            title="Re-read local state. No network."
            className="px-2 py-1 rounded text-xs font-mono text-muted hover:text-fg hover:bg-fg/5 disabled:opacity-40 transition-colors"
          >
            rescan
          </button>
          <button
            onClick={() => void run(true)}
            disabled={busy}
            title="Fetch every tracked remote, then rescan"
            className="flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium text-bg bg-accent hover:bg-accent/90 disabled:opacity-40 transition-colors"
          >
            <RefreshCw size={11} className={busy ? "animate-spin" : ""} />
            fetch
          </button>
        </div>
      </header>

      {/* Staleness is stated, never implied. Ahead/behind against un-fetched
          refs report pushed commits as unpushed — a confident wrong answer,
          and the most misleading thing this tool could do. */}
      <div
        className={cn(
          "px-2.5 py-1 text-[11px] font-mono flex items-center gap-1.5 leading-snug",
          wasFetched ? "bg-ok/10 text-ok" : "bg-warn/10 text-warn",
        )}
      >
        {!wasFetched && <TriangleAlert size={10} className="shrink-0" />}
        {wasFetched
          ? `fetched ${scannedAt?.toLocaleTimeString() ?? ""} — ahead/behind current`
          : "local refs only — ahead/behind may be stale"}
      </div>

      {error && <div className="px-2.5 py-1 bg-alert/10 text-alert text-[11px] break-all">{error}</div>}

      <main className="flex-1 overflow-y-auto">
        {grouped.map(([label, rows]) => {
          // A filter is itself a request to see what matched, so it overrides
          // the collapse state rather than hiding the results behind it.
          const isOpen = filter !== "all" || !collapsed.has(label);
          const c = counts(rows);
          return (
            <section key={label}>
              <button
                onClick={() => toggle(label)}
                className="w-full sticky top-0 z-10 bg-panel/95 backdrop-blur px-2 py-1.5 flex items-center gap-2 border-y border-surface/60 hover:bg-surface/60 transition-colors text-left"
              >
                <span className="flex items-center gap-1.5 shrink-0">
                  <GroupDot sev={groupSeverity(rows)} />
                  {isOpen ? (
                    <ChevronDown size={14} className="text-muted shrink-0" />
                  ) : (
                    <ChevronRight size={14} className="text-muted shrink-0" />
                  )}
                </span>
                <span className="text-xs uppercase tracking-wider text-fg/80 font-medium">{label}</span>
                {/* Collapsing hides detail, never signal: a closed group still
                    says how much inside it needs looking at. */}
                {/* A breakdown, not an alarm: a group of ten with one bad
                    remote should not look the same as one that is all bad. */}
                <span className="ml-auto flex items-center gap-1.5 text-[11px] font-mono tabular-nums">
                  {c.clean > 0 && <span className="text-ok/70" title={`${c.clean} clean`}>{c.clean}</span>}
                  {c.dirty > 0 && <span className="text-warn" title={`${c.dirty} with local work`}>{c.dirty}</span>}
                  {c.unpinned > 0 && (
                    <span className="text-mauve/80" title={`${c.unpinned} on an unpinned remote`}>{c.unpinned}</span>
                  )}
                  {c.archive > 0 && (
                    <span className="text-muted/60" title={`${c.archive} local-only archive`}>{c.archive}</span>
                  )}
                  {c.config > 0 && (
                    <span className="px-1.5 rounded bg-alert/25 text-alert font-semibold" title={`${c.config} needing a fix`}>
                      {c.config}
                    </span>
                  )}
                </span>
              </button>
              {isOpen && rows.map((r, i) => <RepoRow key={r.path} r={r} zebra={i % 2 === 1} />)}
            </section>
          );
        })}
        {/* Retired: the only section describing repos gtrack cannot scan.
            Deliberately outside the filter row above, which partitions the
            scanned set — a category that is by definition not in that set
            would break the arithmetic those counts promise. It shows under
            "all" only, since a filter is a request to see what matched. */}
        {filter === "all" && tombstones.length > 0 && (
          <section>
            <button
              onClick={() => update((p) => ({ ...p, retiredOpen: !p.retiredOpen }))}
              className="w-full sticky top-0 z-10 bg-panel/95 backdrop-blur px-2 py-1.5 flex items-center gap-2 border-y border-surface/60 hover:bg-surface/60 transition-colors text-left"
            >
              {/* Not a scanned group, but it carries the same control, so it
                  takes the same indicator — without one the chevrons below
                  would sit a dot's width off the column above. Grey by
                  default: a tombstone is the settled end of a decision. Red
                  only for the contradiction, which is the one thing here that
                  wants looking at. */}
              <span className="flex items-center gap-1.5 shrink-0">
                <GroupDot
                  sev={contradicted > 0 ? "alert" : "archive"}
                  hint={
                    contradicted > 0
                      ? "Recorded as deleted, but found on disk"
                      : "Deleted on purpose — notes, not trees"
                  }
                />
                {prefs.retiredOpen ? (
                  <ChevronDown size={14} className="text-muted shrink-0" />
                ) : (
                  <ChevronRight size={14} className="text-muted shrink-0" />
                )}
              </span>
              <span className="text-xs uppercase tracking-wider text-muted font-medium">retired</span>
              <span className="ml-auto flex items-center gap-1.5 text-[11px] font-mono tabular-nums">
                <span className="text-muted/60" title={`${tombstones.length} deleted on purpose`}>
                  {tombstones.length}
                </span>
                {contradicted > 0 && (
                  <span
                    className="px-1.5 rounded bg-alert/25 text-alert font-semibold"
                    title="Recorded as deleted, but found on disk"
                  >
                    {contradicted}
                  </span>
                )}
              </span>
            </button>
            {prefs.retiredOpen &&
              tombstones.map((t, i) => {
                const here = onDisk.has(t.name);
                return (
                  <div
                    key={t.name}
                    className={cn(
                      "group/row hover:bg-surfaceHover/50 transition-colors",
                      here ? "bg-alert/[0.07]" : i % 2 === 1 ? "bg-surface/25" : "",
                    )}
                  >
                    <div className="grid grid-cols-[6px_minmax(7rem,13rem)_minmax(0,1fr)] md:grid-cols-[6px_minmax(9rem,15rem)_8.5rem_minmax(0,1fr)] items-center gap-x-3 pr-2 max-w-[64rem]">
                      <div className={cn("h-7 w-1.5", here ? "bg-alert" : "bg-muted/25")} />
                      <span className="text-sm text-muted truncate leading-snug">{t.name}</span>
                      <span className="hidden md:block font-mono text-[11px] text-muted/60 tabular-nums leading-snug">
                        {t.removed ?? <span className="text-muted/30">—</span>}
                      </span>
                      <span className="text-[11px] text-muted/70 truncate leading-snug" title={t.note ?? undefined}>
                        {here && (
                          <span className="mr-1.5 px-1.5 py-px rounded bg-alert/20 text-alert font-mono">on disk</span>
                        )}
                        {t.note ?? <span className="text-muted/30">no note</span>}
                      </span>
                    </div>
                  </div>
                );
              })}
          </section>
        )}

        {grouped.length === 0 && !busy && (
          <p className="px-3 py-8 text-[11px] text-muted text-center">
            {filter !== "all" ? `Nothing matches "${filter}".` : "No checkouts found — roots live in gtrack.json."}
          </p>
        )}
      </main>

      <footer className="px-2.5 py-1 border-t border-surface/60 text-[11px] text-muted flex items-center gap-3 leading-snug">
        <span>{repos.length} repos</span>
        {tombstones.length > 0 && (
          <span className="text-muted/60">{tombstones.length} retired</span>
        )}
        <span className="hidden sm:inline text-muted/60">read-only</span>
        <span className="ml-auto opacity-60">ndisc suite</span>
      </footer>
    </div>
  );
}
