import { useCallback, useEffect, useMemo, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, GitBranch, RefreshCw, TriangleAlert } from "lucide-react";
import { cn } from "./lib/cn";
import { loadPrefs, savePrefs, type Prefs } from "./lib/prefs";
import { accountMemory, visibilityMemory, type Cache } from "./lib/memory";
import {
  counts,
  groupSeverity,
  loadConfig,
  matches,
  scanRepo,
  scanRepos,
  type Filter,
  type RepoStatus,
  type Severity,
  type Tombstone,
  type Visibility,
} from "./lib/tauri";
import { barClip, RepoRow } from "./components/RepoRow";

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
    hint: "Something here is broken — a stale lock, a missing upstream, an unreachable or orphaned remote, a key on the wrong account, or version files that disagree",
  },
  warn: { tone: "bg-warn", hint: "Local work here — uncommitted, unpushed or behind" },
  unpinned: {
    tone: "bg-mauve",
    hint: "A remote here does not name the account it authenticates as",
  },
  hold: {
    tone: "bg-mauve",
    hint: "A repo here is declared no-push — pushing it signs and publishes, so it is done deliberately or not at all",
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

/** One number in a group header's breakdown.
 *
 *  Boxed in a faint fill of its own tone, with the number at full strength —
 *  the form the `config` count always had. Bare numbers at 60–70% alpha were
 *  hard to find at the far edge of a wide window, and only the alarming count
 *  had a shape, so the header read as one boxed number and some noise. The
 *  alert box stays the strongest by its fill, not by being the only box. */
function Count({ n, tone, title }: { n: number; tone: string; title: string }) {
  if (n === 0) return null;
  return (
    <span className={cn("px-1.5 rounded min-w-[1.5rem] text-center", tone)} title={title}>
      {n}
    </span>
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
  const [visibility, setVisibility] = useState<Cache<Visibility>>(visibilityMemory.load);
  const [accounts, setAccounts] = useState<Cache<string>>(accountMemory.load);
  /** Rows fetched one at a time since the last full scan, and when. */
  const [single, setSingle] = useState<Map<string, Date>>(new Map());
  const [rowBusy, setRowBusy] = useState<Set<string>>(new Set());

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
      // Every scan, not only fetches: a local scan measures nothing, so it
      // keeps each answer, but it is what prunes trees no longer on disk.
      setVisibility((prev) => {
        const next = visibilityMemory.remember(prev, rows);
        visibilityMemory.save(next);
        return next;
      });
      setAccounts((prev) => {
        const next = accountMemory.remember(prev, rows);
        accountMemory.save(next);
        return next;
      });
      // A full scan supersedes every single-row fetch before it: the banner's
      // claim is about this scan now.
      setSingle(new Map());
      setScannedAt(new Date());
      setWasFetched(fetch);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  /** Fetch and rescan one repository, replacing its row in place. */
  const runOne = useCallback(async (path: string) => {
    setRowBusy((prev) => new Set(prev).add(path));
    setError(null);
    try {
      const row = await scanRepo(path, true);
      setRepos((prev) => prev.map((r) => (r.path === path ? row : r)));
      setVisibility((prev) => {
        const next = visibilityMemory.rememberOne(prev, row);
        visibilityMemory.save(next);
        return next;
      });
      setAccounts((prev) => {
        const next = accountMemory.rememberOne(prev, row);
        accountMemory.save(next);
        return next;
      });
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

  // Local scan on open: cheap, no network, and what makes this glanceable
  // rather than something you wait for.
  useEffect(() => {
    void run(false);
  }, [run]);

  const shown = useMemo(() => repos.filter((r) => matches(r, filter)), [repos, filter]);
  // Anything scanning at all. Full scans and single rows are kept from
  // overlapping, so a slow row cannot land on top of a newer full scan.
  const anyBusy = busy || rowBusy.size > 0;
  // Verified this session, not remembered: the banner reports what was
  // measured, and the dimmed keys already speak for the memory.
  const verified = useMemo(() => repos.filter((r) => r.account === "owner").length, [repos]);
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
        {/* Two-tone in grey: the wordmark keeps its g / track split, but
            mauve means a state in the rows below and cannot also be a logo. */}
        <GitBranch size={16} className="text-fg shrink-0" />
        <span className="text-base font-bold tracking-tight select-none">
          <span className="text-fg">g</span>
          <span className="text-muted">track</span>
        </span>
        {appVersion && (
          <span
            className="hidden lg:inline-flex items-center px-1.5 py-0.5 rounded bg-surfaceHover text-fg/80 font-mono text-[10px] shrink-0"
            title={`v${appVersion}`}
          >
            v{shortVersion(appVersion)}
          </span>
        )}

        <div className="ml-auto flex items-center gap-1">
          {/* Icon-only: the label cost more width than it earned next to the
              filter chips, and the chevrons say the same thing. The accessible
              name moves to aria-label so it is not lost with the text. */}
          <button
            onClick={toggleAll}
            title={allCollapsed ? "Expand every group" : "Collapse every group"}
            aria-label={allCollapsed ? "Expand every group" : "Collapse every group"}
            className="px-1.5 py-1 rounded text-muted hover:text-fg hover:bg-fg/5 transition-colors"
          >
            {allCollapsed ? <ChevronsUpDown size={13} /> : <ChevronsDownUp size={13} />}
          </button>
          <div className="flex items-center rounded overflow-hidden border border-surfaceHover">
            {(
              [
                ["all", repos.length, "text-fg", "Everything"],
                ["clean", total.clean, "text-ok", "Nothing to do"],
                ["dirty", total.dirty, "text-warn", "Work in progress — uncommitted, unpushed commits or tags, or behind"],
                ["unpinned", repos.filter((r) => r.flags.includes("unpinned")).length, "text-mauve", "Remote does not name the account it authenticates as — https, or a bare git@github.com. Use a host alias so pushes land on the right identity"],
                ["hold", repos.filter((r) => r.flags.includes("no push")).length, "text-mauve", "Declared no-push in gtrack.json — unpushed commits here are expected, not owed. A nostr:// push signs the commit into an event and publishes it to relays"],
                ["archive", total.archive, "text-muted", "No remote — kept deliberately as a local-only archive"],
              ] as const
            ).map(([key, n, tone, hint]) => (
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
            title="Fetch every tracked remote, then rescan"
            className="flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-mono text-bg bg-fg hover:bg-fg/85 disabled:opacity-40 transition-colors"
          >
            <RefreshCw size={11} className={busy ? "animate-spin" : ""} />
            fetch
          </button>
        </div>
      </header>

      {/* Staleness is stated, never implied. Ahead/behind against un-fetched
          refs report pushed commits as unpushed — a confident wrong answer,
          and the most misleading thing this tool could do.

          Single-row fetches are counted rather than folded in. They make some
          rows fresher than the time shown, which is harmless to say; they do
          not make an unfetched list current, which the amber must keep
          saying — so a single fetch never turns the banner green. */}
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
        {single.size > 0 && (
          <span className="opacity-70">
            · {single.size} {single.size === 1 ? "repo" : "repos"} fetched alone{wasFetched ? " since" : ""}
          </span>
        )}
        {verified > 0 && (
          <span className="opacity-70" title="Pinned remotes whose one key is among the keys the owning account publishes on GitHub, checked this session">
            · {verified} {verified === 1 ? "key" : "keys"} verified
          </span>
        )}
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
                  <Count n={c.clean} tone="bg-ok/15 text-ok" title={`${c.clean} clean`} />
                  <Count n={c.dirty} tone="bg-warn/15 text-warn" title={`${c.dirty} with local work`} />
                  <Count n={c.unpinned} tone="bg-mauve/15 text-mauve" title={`${c.unpinned} on an unpinned remote`} />
                  <Count n={c.archive} tone="bg-muted/15 text-muted" title={`${c.archive} local-only archive`} />
                  {/* `bucket` puts a held repo here and nowhere else, so without
                      this the ngit group — three repos, all declared no-push —
                      showed no count at all, closed or open. The one group that
                      says nothing about itself was the one whose whole point is
                      that its unpushed commits are expected. Counted, never
                      alarming: mauve like the chip, boxed like the rest. */}
                  <Count n={c.hold} tone="bg-mauve/15 text-mauve" title={`${c.hold} declared no-push`} />
                  <Count n={c.config} tone="bg-alert/25 text-alert font-semibold" title={`${c.config} needing a fix`} />
                </span>
              </button>
              {isOpen && rows.map((r, i) => (
                  <RepoRow
                    key={r.path}
                    r={r}
                    zebra={i % 2 === 1}
                    first={i === 0}
                    last={i === rows.length - 1}
                    visibility={visibility}
                    accounts={accounts}
                    fetchedAt={single.get(r.path)}
                    busy={rowBusy.has(r.path)}
                    locked={anyBusy}
                    onFetch={(p) => void runOne(p)}
                  />
                ))}
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
                <Count n={tombstones.length} tone="bg-muted/15 text-muted" title={`${tombstones.length} deleted on purpose`} />
                <Count
                  n={contradicted}
                  tone="bg-alert/25 text-alert font-semibold"
                  title="Recorded as deleted, but found on disk"
                />
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
                      i % 2 === 1 && "bg-surface/40",
                    )}
                  >
                    <div className="grid grid-cols-[6px_minmax(7rem,13rem)_minmax(0,1fr)] md:grid-cols-[6px_minmax(9rem,15rem)_8.5rem_minmax(0,1fr)] items-center gap-x-3 pr-2 max-w-[64rem] min-h-7">
                      {/* Inset like a repo row's bar — see RepoRow. */}
                      <div
                        className={cn("h-6 w-1.5", here ? "bg-alert" : "bg-muted/25")}
                        style={{ clipPath: barClip(i === 0, i === tombstones.length - 1) }}
                      />
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

      <footer className="px-2.5 py-1 border-t border-surface/60 text-[11px] text-fg/70 flex items-center gap-3 leading-snug">
        <span>{repos.length} repos</span>
        {tombstones.length > 0 && (
          <span className="text-fg/55">{tombstones.length} retired</span>
        )}
        <span className="hidden sm:inline text-fg/55">read-only</span>
        <span className="ml-auto text-fg/55">ndisc suite</span>
      </footer>
    </div>
  );
}
