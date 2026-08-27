import { cn } from "../lib/cn";
import { severity, type RepoStatus } from "../lib/tauri";

/** A version cell that shows disagreement rather than picking a winner.
 *  A release needs package.json, Cargo.toml and tauri.conf.json bumped
 *  together; showing one of three hides exactly the bug worth catching. */
function Version({ r }: { r: RepoStatus }) {
  const { versions: v } = r;
  const all = [v.package, v.cargo, v.tauri, v.lock].filter(Boolean) as string[];
  if (all.length === 0) return <span className="text-muted/30">—</span>;
  if (v.agree) return <span className="text-fg">{all[0]}</span>;
  // Four sources now, so show the distinct values rather than one per file —
  // "0.1.1 / 0.1.0" is the finding; repeating the agreeing value three times
  // buries it.
  const distinct = [...new Set(all)];
  return (
    <span
      className="text-alert font-semibold"
      title={`package.json ${v.package ?? "—"} · Cargo.toml ${v.cargo ?? "—"} · tauri.conf.json ${v.tauri ?? "—"} · package-lock.json ${v.lock ?? "—"}`}
    >
      {distinct.join(" / ")}
    </span>
  );
}

const ALERT_FLAGS = new Set(["stale lock", "no upstream", "orphan", "unreachable", "version mismatch"]);

/** Hints for the flags that are faults. `STATE_FLAGS` below carries its own;
 *  these are red either way and only need to say what was actually seen —
 *  particularly `orphan`, which reports an observation, not a conclusion. */
const ALERT_HINTS: Record<string, string> = {
  orphan:
    "The remote answered: no such repository — deleted, renamed, or not visible to the account this machine authenticates as. Drop the remote to keep it as an archive, or delete the tree and leave a tombstone in gtrack.json",
  unreachable:
    "Fetch failed on network, DNS or credentials — a condition of the moment, not a fact about the remote",
};

/** Flags that describe how a repository is set up rather than reporting a
 *  fault, each with its own tone and none of them red.
 *
 *  `archive` is grey: where the repo lives, nothing wrong with it. `https
 *  remote` takes the mauve of `track` in the wordmark — a house preference,
 *  visible but not shouted, since an https remote fetches and usually pushes
 *  perfectly well. */
const STATE_FLAGS: Record<string, { tone: string; hint: string }> = {
  archive: {
    tone: "bg-muted/15 text-muted",
    hint: "No remote — kept deliberately as a local-only archive",
  },
  "https remote": {
    tone: "bg-mauve/15 text-mauve",
    hint: "Remote is https — prefer an SSH alias so GitHub actions run as the right account",
  },
};

function Flag({ text }: { text: string }) {
  const state = STATE_FLAGS[text];
  const tone = ALERT_FLAGS.has(text)
    ? "bg-alert/20 text-alert"
    : (state?.tone ?? "bg-surfaceHover/70 text-fg/70");
  return (
    <span
      className={cn("px-1.5 py-px rounded text-[11px] font-mono shrink-0 leading-snug", tone)}
      title={state?.hint ?? ALERT_HINTS[text]}
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
        // The tint spans the full window while the columns stop at the cap —
        // banding that stopped mid-screen read as a rendering fault.
        "group/row hover:bg-surfaceHover/50 transition-colors",
        // An archive takes the plain zebra: it is a settled state, and tinting
        // it would put it back among the rows that want doing something about.
        // https gets a tint faint enough to find but not to alarm.
        sev === "alert"
          ? "bg-alert/[0.07]"
          : sev === "warn"
            ? "bg-warn/[0.05]"
            : sev === "https"
              ? "bg-mauve/[0.05]"
              : zebra
                ? "bg-surface/25"
                : "",
      )}
      title={r.path}
    >
      <div
        className={cn(
          // Fixed columns rather than fractions: repo names and semver strings
          // both sit in a narrow, predictable width range, so letting them
          // stretch only pushes the eye across empty space.
          "grid grid-cols-[6px_minmax(7rem,13rem)_minmax(0,1fr)] md:grid-cols-[6px_minmax(9rem,15rem)_8.5rem_11rem_minmax(0,1fr)]",
          "items-center gap-x-3 pr-2 max-w-[64rem]",
        )}
      >
      <div
        className={cn(
          "h-7 w-1.5",
          sev === "alert"
            ? "bg-alert"
            : sev === "warn"
              ? "bg-warn"
              : sev === "archive"
                ? "bg-muted/40"
                : sev === "https"
                  ? "bg-mauve/60"
                  : "bg-ok/50",
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
    </div>
  );
}
