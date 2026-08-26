import { useCallback, useEffect, useMemo, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { ChevronDown, ChevronRight, GitBranch, RefreshCw, TriangleAlert } from "lucide-react";
import { cn } from "./lib/cn";
import { loadPrefs, savePrefs, type Prefs } from "./lib/prefs";
import { scanRepos, severity, type RepoStatus } from "./lib/tauri";
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
  const [onlyProblems, setOnlyProblems] = useState(false);
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

  const shown = useMemo(
    () => (onlyProblems ? repos.filter((r) => severity(r) !== "ok") : repos),
    [repos, onlyProblems],
  );

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

  const problems = useMemo(() => repos.filter((r) => severity(r) !== "ok").length, [repos]);
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
        <GitBranch size={15} className="text-accent shrink-0" />
        <span className="text-sm font-bold tracking-tight select-none">
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
            className="px-1.5 py-1 rounded text-[11px] font-mono text-muted hover:text-fg hover:bg-fg/5 transition-colors"
          >
            {allCollapsed ? "expand" : "collapse"}
          </button>
          <button
            onClick={() => setOnlyProblems((v) => !v)}
            className={cn(
              "px-1.5 py-1 rounded text-[11px] font-mono transition-colors",
              onlyProblems ? "bg-warn/15 text-warn" : "text-muted hover:text-fg hover:bg-fg/5",
            )}
            title="Show only repos with something worth looking at"
          >
            {problems}▲
          </button>
          <button
            onClick={() => void run(false)}
            disabled={busy}
            title="Re-read local state. No network."
            className="px-1.5 py-1 rounded text-[11px] font-mono text-muted hover:text-fg hover:bg-fg/5 disabled:opacity-40 transition-colors"
          >
            rescan
          </button>
          <button
            onClick={() => void run(true)}
            disabled={busy}
            title="Fetch every tracked remote, then rescan"
            className="flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium text-bg bg-accent hover:bg-accent/90 disabled:opacity-40 transition-colors"
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
          "px-2.5 py-0.5 text-[10px] font-mono flex items-center gap-1.5 leading-tight",
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
          const isOpen = onlyProblems || !collapsed.has(label);
          const bad = rows.filter((r) => severity(r) !== "ok").length;
          return (
            <section key={label}>
              <button
                onClick={() => toggle(label)}
                className="w-full sticky top-0 z-10 bg-panel/95 backdrop-blur px-1.5 py-1 flex items-center gap-1.5 border-y border-surface/60 hover:bg-surface/60 transition-colors text-left"
              >
                {isOpen ? (
                  <ChevronDown size={12} className="text-muted shrink-0" />
                ) : (
                  <ChevronRight size={12} className="text-muted shrink-0" />
                )}
                <span className="text-[11px] uppercase tracking-wide text-muted">{label}</span>
                {/* Collapsing hides detail, never signal: a closed group still
                    says how much inside it needs looking at. */}
                <span className="text-[10px] font-mono text-muted/50">{rows.length}</span>
                {bad > 0 && (
                  <span className="text-[10px] font-mono px-1 rounded bg-alert/15 text-alert">{bad}</span>
                )}
              </button>
              {isOpen && rows.map((r) => <RepoRow key={r.path} r={r} />)}
            </section>
          );
        })}
        {grouped.length === 0 && !busy && (
          <p className="px-3 py-8 text-[11px] text-muted text-center">
            {onlyProblems ? "Nothing to look at." : "No checkouts found — roots live in gtrack.json."}
          </p>
        )}
      </main>

      <footer className="px-2.5 py-1 border-t border-surface/60 text-[10px] text-muted flex items-center gap-3 leading-tight">
        <span>{repos.length} repos</span>
        <span className="hidden sm:inline text-muted/60">read-only</span>
        <span className="ml-auto opacity-60">ndisc suite</span>
      </footer>
    </div>
  );
}
