import { cn } from "../lib/cn";
import { severity, type RepoStatus } from "../lib/tauri";

/** A version cell that shows disagreement rather than picking a winner.
 *  A release needs package.json, Cargo.toml and tauri.conf.json bumped
 *  together; showing only one of three hides exactly the bug worth catching. */
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

const FLAG_TONE: Record<string, string> = {
  "stale lock": "bg-alert/15 text-alert",
  "no upstream": "bg-alert/15 text-alert",
  unreachable: "bg-alert/15 text-alert",
  "https remote": "bg-alert/15 text-alert",
  "version mismatch": "bg-alert/15 text-alert",
};

function Flag({ text }: { text: string }) {
  const tone = FLAG_TONE[text] ?? "bg-surface text-muted";
  return <span className={cn("px-1.5 py-0.5 rounded text-[10px] font-mono shrink-0", tone)}>{text}</span>;
}

export function RepoRow({ r }: { r: RepoStatus }) {
  const sev = severity(r);
  return (
    <div
      className={cn(
        "grid grid-cols-[minmax(0,1.4fr)_auto_auto_minmax(0,2fr)] items-center gap-3 px-3 py-1.5",
        "border-l-2 hover:bg-surface/40 transition-colors",
        sev === "alert" ? "border-alert" : sev === "warn" ? "border-warn" : "border-ok/40",
      )}
      title={r.path}
    >
      <div className="min-w-0 flex items-baseline gap-2">
        <span className="text-sm text-fg truncate">{r.name}</span>
        {r.branch && r.branch !== "main" && (
          <span className="text-[10px] font-mono text-digital shrink-0">{r.branch}</span>
        )}
      </div>

      <div className="font-mono text-xs tabular-nums w-24 text-right">
        <Version r={r} />
      </div>

      {/* Release position: the tag, and how far past it HEAD has drifted. */}
      <div className="font-mono text-[11px] text-muted w-40 text-right truncate">
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

      <div className="flex items-center gap-1 flex-wrap min-w-0">
        {r.flags.length === 0 ? (
          <span className="text-[10px] font-mono text-ok/60">clean</span>
        ) : (
          r.flags.map((f) => <Flag key={f} text={f} />)
        )}
      </div>
    </div>
  );
}
