import { cn } from "../lib/cn";
import { severity, type RepoStatus } from "../lib/tauri";

/** A version cell that shows disagreement rather than picking a winner.
 *  A release needs package.json, Cargo.toml and tauri.conf.json bumped
 *  together; showing one of three hides exactly the bug worth catching. */
function Version({ r }: { r: RepoStatus }) {
  const { versions: v } = r;
  const all = [v.package, v.cargo, v.tauri].filter(Boolean) as string[];
  if (all.length === 0) return <span className="text-muted/40">—</span>;
  if (v.agree) return <span className="text-fg">{all[0]}</span>;
  return (
    <span
      className="text-alert"
      title={`package.json ${v.package ?? "—"} · Cargo.toml ${v.cargo ?? "—"} · tauri.conf.json ${v.tauri ?? "—"}`}
    >
      {all.join(" / ")}
    </span>
  );
}

const ALERT_FLAGS = new Set([
  "stale lock",
  "no upstream",
  "unreachable",
  "https remote",
  "version mismatch",
]);

function Flag({ text }: { text: string }) {
  return (
    <span
      className={cn(
        "px-1 py-px rounded text-[10px] font-mono shrink-0 leading-tight",
        ALERT_FLAGS.has(text) ? "bg-alert/15 text-alert" : "bg-surface text-muted",
      )}
    >
      {text}
    </span>
  );
}

export function RepoRow({ r }: { r: RepoStatus }) {
  const sev = severity(r);
  return (
    <div
      className={cn(
        "grid grid-cols-[minmax(0,1fr)_auto_auto] sm:grid-cols-[minmax(0,1fr)_auto_auto_minmax(0,1.4fr)]",
        "items-center gap-2 pl-2 pr-2 py-0.5 border-l-2 hover:bg-surface/40 transition-colors",
        sev === "alert" ? "border-alert" : sev === "warn" ? "border-warn" : "border-ok/30",
      )}
      title={r.path}
    >
      <div className="min-w-0 flex items-baseline gap-1.5">
        <span className="text-[13px] text-fg truncate leading-tight">{r.name}</span>
        {r.branch && r.branch !== "main" && (
          <span className="text-[10px] font-mono text-digital shrink-0">{r.branch}</span>
        )}
      </div>

      <div className="font-mono text-[11px] tabular-nums text-right leading-tight">
        <Version r={r} />
      </div>

      {/* Release position. First thing to go when the window is narrow — it is
          reference, where the flags are the reason to look. */}
      <div className="hidden md:block font-mono text-[10px] text-muted text-right truncate max-w-[13rem] leading-tight">
        {r.latestTag ? (
          <>
            {r.latestTag}
            {r.commitsSinceTag ? <span className="text-warn"> +{r.commitsSinceTag}</span> : null}
            {r.tagDate && <span className="text-muted/50"> {r.tagDate}</span>}
          </>
        ) : (
          <span className="text-muted/40">untagged</span>
        )}
      </div>

      <div className="hidden sm:flex items-center gap-1 min-w-0 overflow-hidden">
        {r.flags.length === 0 ? (
          <span className="text-[10px] font-mono text-ok/50">clean</span>
        ) : (
          r.flags.map((f) => <Flag key={f} text={f} />)
        )}
      </div>
    </div>
  );
}
