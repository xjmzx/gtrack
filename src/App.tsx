import { useCallback, useEffect, useMemo, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { ChevronDown, ChevronRight, GitBranch, RefreshCw, TriangleAlert } from "lucide-react";
import { cn } from "./lib/cn";
import { loadPrefs, savePrefs, type Prefs } from "./lib/prefs";
import { counts, matches, scanRepos, type Filter, type RepoStatus } from "./lib/tauri";
import { RepoRow } from "./components/RepoRow";

// Suite rule: the version chip shows only major.minor.patch; any pre-release
// suffix drops to the tooltip so the chip keeps a fixed width.
const shortVersion = (v: string) => v.split(/[-+]/)[0];

export default function App() {
  const [repos, setRepos] = useState<RepoStatus[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [scannedAt, setScannedAt] = useState<Date | null>(null);
  const [wasFetched, setWasFetched] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);

  useEffect(() => {
    getVersion().then(setAppVersion).catch(() => setAppVersion(null));
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
                ["https", repos.filter((r) => r.remoteKind === "https").length, "text-alert", "Credential-less https remotes — these 403 on push"],
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
                {isOpen ? (
                  <ChevronDown size={14} className="text-muted shrink-0" />
                ) : (
                  <ChevronRight size={14} className="text-muted shrink-0" />
                )}
                <span className="text-xs uppercase tracking-wider text-fg/80 font-medium">{label}</span>
                {/* Collapsing hides detail, never signal: a closed group still
                    says how much inside it needs looking at. */}
                {/* A breakdown, not an alarm: a group of ten with one bad
                    remote should not look the same as one that is all bad. */}
                <span className="ml-auto flex items-center gap-1.5 text-[11px] font-mono tabular-nums">
                  {c.clean > 0 && <span className="text-ok/70" title={`${c.clean} clean`}>{c.clean}</span>}
                  {c.dirty > 0 && <span className="text-warn" title={`${c.dirty} with local work`}>{c.dirty}</span>}
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
        {grouped.length === 0 && !busy && (
          <p className="px-3 py-8 text-[11px] text-muted text-center">
            {filter !== "all" ? `Nothing matches "${filter}".` : "No checkouts found — roots live in gtrack.json."}
          </p>
        )}
      </main>

      <footer className="px-2.5 py-1 border-t border-surface/60 text-[11px] text-muted flex items-center gap-3 leading-snug">
        <span>{repos.length} repos</span>
        <span className="hidden sm:inline text-muted/60">read-only</span>
        <span className="ml-auto opacity-60">ndisc suite</span>
      </footer>
    </div>
  );
}
