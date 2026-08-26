import { cn } from "../lib/cn";
import { severity, type RepoStatus } from "../lib/tauri";

/** A version cell that shows disagreement rather than picking a winner.
 *  A release needs package.json, Cargo.toml and tauri.conf.json bumped
 *  together; showing one of three hides exactly the bug worth catching. */
function Version({ r }: { r: RepoStatus }) {
  const { versions: v } = r;
  const all = [v.package, v.cargo, v.tauri].filter(Boolean) as string[];
  if (all.length === 0) return <span className="text-muted/30">—</span>;
  if (v.agree) return <span className="text-fg">{all[0]}</span>;
  return (
    <span
      className="text-alert font-semibold"
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
        "px-1.5 py-px rounded text-[11px] font-mono shrink-0 leading-snug",
        ALERT_FLAGS.has(text) ? "bg-alert/20 text-alert" : "bg-surfaceHover/70 text-fg/70",
      )}
    >
      {text}
    </span>
  );
}

export function RepoRow({ r, zebra }: { r: RepoStatus; zebra: boolean }) {
  const sev = severity(r);
  return (
    <div
      className={cn(
        // Fixed columns rather than fractions: repo names and semver strings
        // both sit in a narrow, predictable width range, so letting them
        // stretch only pushes the eye across empty space.
        "grid grid-cols-[6px_minmax(7rem,13rem)_minmax(0,1fr)] md:grid-cols-[6px_minmax(9rem,15rem)_8.5rem_11rem_minmax(0,1fr)]",
        "items-center gap-x-3 pr-2 hover:bg-surfaceHover/50 transition-colors",
        // The status reads as a block of colour, and a row that needs
        // attention tints whole rather than hinting at one edge.
        sev === "alert" ? "bg-alert/[0.07]" : sev === "warn" ? "bg-warn/[0.05]" : zebra ? "bg-surface/25" : "",
      )}
      title={r.path}
    >
      <div
        className={cn(
          "h-7 w-1.5",
          sev === "alert" ? "bg-alert" : sev === "warn" ? "bg-warn" : "bg-ok/50",
        )}
      />

      <div className="min-w-0 flex items-baseline gap-1.5">
        <span className="text-sm text-fg truncate leading-snug">{r.name}</span>
        {r.branch && r.branch !== "main" && (
          <span className="text-[11px] font-mono text-digital shrink-0">{r.branch}</span>
        )}
      </div>

      <div className="font-mono text-xs tabular-nums text-right leading-snug">
        <Version r={r} />
      </div>

      {/* Release position. First to go as the window narrows — it is
          reference, where the flags are the reason to look. */}
      <div className="hidden md:block font-mono text-[11px] text-muted truncate leading-snug">
        {r.latestTag ? (
          <>
            {r.latestTag}
            {r.commitsSinceTag ? <span className="text-warn font-semibold"> +{r.commitsSinceTag}</span> : null}
          </>
        ) : (
          <span className="text-muted/30">untagged</span>
        )}
      </div>

      <div className="hidden md:flex items-center gap-1.5 min-w-0 overflow-hidden">
        {r.flags.length === 0 ? (
          <span className="text-[11px] font-mono text-ok/40">clean</span>
        ) : (
          r.flags.map((f) => <Flag key={f} text={f} />)
        )}
      </div>
    </div>
  );
}
