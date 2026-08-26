import { useCallback, useEffect, useMemo, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { GitBranch, RefreshCw, TriangleAlert } from "lucide-react";
import { cn } from "./lib/cn";
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

  useEffect(() => {
    getVersion().then(setAppVersion).catch(() => setAppVersion(null));
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

  // Local scan on open: cheap, touches no network, and it is what makes this
  // a glanceable tool rather than something you wait for.
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
    // Named groups first, then whatever fell back to a root directory name.
    return [...by.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [shown]);

  const problems = useMemo(() => repos.filter((r) => severity(r) !== "ok").length, [repos]);

  return (
    <div className="min-h-full flex flex-col">
      <header className="flex items-center gap-3 px-4 py-3 border-b border-surface/60">
        <GitBranch size={18} className="text-accent shrink-0" />
        <span className="text-lg font-bold tracking-tight select-none">
          <span className="text-accent">g</span>
          <span className="text-mauve">track</span>
        </span>
        {appVersion && (
          <span
            className="hidden md:inline-flex items-center px-2 py-1 rounded-md bg-surface text-mauve font-mono text-[11px] shrink-0"
            title={`v${appVersion}`}
          >
            v{shortVersion(appVersion)}
          </span>
        )}

        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={() => setOnlyProblems((v) => !v)}
            className={cn(
              "px-2 py-1.5 rounded-md text-[11px] font-mono transition-colors",
              onlyProblems ? "bg-warn/15 text-warn" : "text-muted hover:text-fg hover:bg-fg/5",
            )}
            title="Show only repos with something worth looking at"
          >
            {problems} to look at
          </button>
          <button
            onClick={() => void run(false)}
            disabled={busy}
            title="Re-read local state. No network."
            className="px-3 py-2 rounded-md text-sm text-muted hover:text-fg hover:bg-fg/5 disabled:opacity-40 transition-colors"
          >
            Rescan
          </button>
          <button
            onClick={() => void run(true)}
            disabled={busy}
            title="Fetch every tracked remote, then rescan"
            className="flex items-center gap-1.5 px-3 py-2 rounded-md text-sm font-medium text-bg bg-accent hover:bg-accent/90 disabled:opacity-40 transition-colors"
          >
            <RefreshCw size={14} className={busy ? "animate-spin" : ""} />
            Fetch
          </button>
        </div>
      </header>

      {/* Staleness is stated, never implied. Ahead/behind computed against
          un-fetched refs can report pushed commits as unpushed — a confident
          wrong answer, and the single most misleading thing this tool could do. */}
      <div
        className={cn(
          "px-4 py-1.5 text-[11px] font-mono flex items-center gap-2",
          wasFetched ? "bg-ok/10 text-ok" : "bg-warn/10 text-warn",
        )}
      >
        {!wasFetched && <TriangleAlert size={12} className="shrink-0" />}
        {wasFetched
          ? `remote state fetched ${scannedAt?.toLocaleTimeString() ?? ""} — ahead/behind are current`
          : "local refs only — ahead/behind may be stale. Fetch to be sure."}
      </div>

      {error && <div className="px-4 py-2 bg-alert/10 text-alert text-xs break-all">{error}</div>}

      <main className="flex-1 overflow-y-auto">
        {grouped.length === 0 && !busy && (
          <p className="px-4 py-10 text-sm text-muted text-center">
            No checkouts found. Roots are configured in <code>gtrack.json</code>.
          </p>
        )}
        {grouped.map(([label, rows]) => (
          <section key={label}>
            <div className="sticky top-0 z-10 bg-panel/95 backdrop-blur px-3 py-1.5 flex items-center gap-2 border-y border-surface/60">
              <span className="text-[11px] uppercase tracking-wide text-muted">{label}</span>
              <span className="text-[10px] font-mono text-muted/50">{rows.length}</span>
            </div>
            {rows.map((r) => (
              <RepoRow key={r.path} r={r} />
            ))}
          </section>
        ))}
      </main>

      <footer className="px-4 py-2 border-t border-surface/60 text-[11px] text-muted flex items-center gap-4">
        <span>{repos.length} repos</span>
        <span className="text-muted/60">read-only — gtrack never writes to a checkout</span>
        <span className="ml-auto opacity-60">ndisc suite</span>
      </footer>
    </div>
  );
}
