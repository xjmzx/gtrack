import { KeyRound, Lock, RefreshCw } from "lucide-react";
import { cn } from "../lib/cn";
import { severity, type RemoteKind, type RepoStatus } from "../lib/tauri";
import { accountMemory, visibilityMemory, type Cache, type Shown } from "../lib/memory";
import type { Visibility } from "../lib/tauri";

/** A version cell that shows disagreement rather than picking a winner.
 *  A release needs package.json, Cargo.toml and tauri.conf.json bumped
 *  together; showing one of three hides exactly the bug worth catching. */
function Version({ r }: { r: RepoStatus }) {
  const { versions: v } = r;
  const all = [v.package, v.cargo, v.tauri, v.lock].filter(Boolean) as string[];
  if (all.length === 0) return <span className="text-muted/60">—</span>;
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

const ALERT_FLAGS = new Set(["stale lock", "no upstream", "orphan", "unreachable", "version mismatch", "other account"]);

/** Hints for the flags that are faults. `STATE_FLAGS` below carries its own;
 *  these are red either way and only need to say what was actually seen —
 *  particularly `orphan`, which reports an observation, not a conclusion. */
const ALERT_HINTS: Record<string, string> = {
  orphan:
    "The remote answered: no such repository — deleted, renamed, or not visible to the account this machine authenticates as. Drop the remote to keep it as an archive, or delete the tree and leave a tombstone in gtrack.json",
  "other account":
    "The one key this remote's host alias uses is not among the keys the repository's owner publishes on GitHub — every push lands on another account's profile, or is refused. Point the alias at the owner's key",
  unreachable:
    "Fetch failed on network, DNS or credentials — a condition of the moment, not a fact about the remote. On an unpinned remote this includes \"repository not found\": a private repo is hidden from whichever account happened to authenticate, so that answer cannot mean deleted",
};

/** Flags that describe how a repository is set up rather than reporting a
 *  fault, each with its own tone and none of them red.
 *
 *  `archive` is grey: where the repo lives, nothing wrong with it. `unpinned`
 *  takes mauve in its faint-fill form — visible but not shouted, since
 *  such a remote fetches and usually pushes perfectly well. */
const STATE_FLAGS: Record<string, { tone: string; hint: string }> = {
  archive: {
    tone: "bg-muted/15 text-muted",
    hint: "No remote — kept deliberately as a local-only archive",
  },
  // `clean` is the absence of findings, not a finding, so it takes the chip's
  // geometry but the quietest tone in the set. Same shape as its neighbours —
  // the column no longer shifts between chip rows and text rows — while still
  // receding, because 46 of 59 rows say this and the eye needs to skip them to
  // land on the 13 that do not.
  clean: {
    tone: "bg-ok/10 text-ok/50",
    hint: "Nothing to do — no findings on this repo",
  },
  // The one chip that is an instruction rather than an observation, and the
  // only solid block in the set — the suite's filled-block form, spent here
  // because it has to out-read every other chip on the row.
  //
  // Mauve rather than a warm tone, and the distinction is the point: no-push
  // states a property of the remote, exactly as `unpinned` does, and nothing
  // about it is broken or owed. Auburn said otherwise for a release — the one
  // group behaving exactly as declared was also the only one wearing a colour
  // the eye reads as a fault. The emphasis lives in the form instead: solid
  // against `unpinned`'s `bg-mauve/15`, so the two read as one family at two
  // weights where they sit side by side on every ngit row.
  "no push": {
    tone: "bg-mauve text-bg font-semibold",
    hint: "Declared no-push in gtrack.json. Unpushed commits here are expected rather than owed — pushing a nostr:// remote signs the commit into an event with nostr.nsec and publishes it to relays, where it cannot be recalled",
  },
  // `digital` blue, in `unpinned`'s faint-fill form: a property of the remote,
  // like it, and just as far from a fault. Blue rather than grey so it cannot
  // be mistaken for `archive` at a glance, which is what it was confused with.
  // Drawn beside the flags, never among them — see `visibility` in lib/tauri.ts.
  private: {
    tone: "bg-digital/15 text-digital",
    hint: "Private on GitHub — the fetch succeeded, and the same repository refused a read without credentials. Checked on each fetch",
  },
  unpinned: {
    tone: "bg-mauve/15 text-mauve",
    hint: "Remote does not name the account it authenticates as — https resolves through the credential helper, bare git@github.com through whichever key ssh-agent offers first. Use a host alias so pushes land on the right identity",
  },
};

/** Why a remote fails to pin its account, where that differs by remote form.
 *
 *  The flag is one property — nothing in the URL names the identity a push
 *  authenticates as — but the machinery behind it is not shared, and neither
 *  is the way out. The hint above names ssh-agent and the credential helper
 *  and ends at "use a host alias", none of which a `nostr://` remote has: its
 *  signing key comes from git config, and there is no alias to reach for. A
 *  hint that confidently sends someone to a fix that does not exist for their
 *  remote is worse than the chip carrying no explanation at all, so a form
 *  that differs says its own thing and the rest fall back. */
const UNPINNED_HINTS: Partial<Record<RemoteKind, string>> = {
  nostr:
    "Remote does not name the account it authenticates as — the npub names the repository being announced, while the key that signs the push comes from nostr.nsec in git config, which is global by default and shared by every repo on the machine. Set nostr.nsec locally to pin this one",
};

/** Hint for a visibility the app remembers rather than measured just now. */
const REMEMBERED_HINT =
  "Private at the last fetch — remembered, not yet confirmed this session. Fetch to check again";

/** Hints computed from the row, for flags whose useful detail is data. */
function rowHint(text: string, r: RepoStatus): string | undefined {
  if (text === "other account" && r.authenticatesAs) {
    return `The one key this remote's host alias uses belongs to ${r.authenticatesAs}, not the repository's owner — every push lands on ${r.authenticatesAs}'s profile, or is refused. Point the alias at the owner's key`;
  }
  if (/^\d+ unpushed tags?$/.test(text)) {
    return `Tags here that the remote does not have: ${r.unpushedTags.join(", ")}. A release tag that was never pushed never builds`;
  }
  return undefined;
}

function Flag({
  text,
  remoteKind,
  hintOverride,
  dim = false,
  held = false,
}: {
  text: string;
  remoteKind: RemoteKind;
  hintOverride?: string;
  /** Remembered rather than measured this session. */
  dim?: boolean;
  /** The repo is declared no-push. */
  held?: boolean;
}) {
  const state = STATE_FLAGS[text];
  // Anything not an alert and not a named state is local work — dirty,
  // unpushed, behind — and wears the amber of the `dirty` state, faint fill
  // and full text, the way `clean` wears its green. The chip carries the
  // state now that the row no longer does. On a held repo the same work is
  // expected rather than owed, so it takes the hold mauve instead: amber
  // there would read as a chore, which the declaration exists to undo.
  const tone = ALERT_FLAGS.has(text)
    ? "bg-alert/20 text-alert"
    : (state?.tone ?? (held ? "bg-mauve/15 text-mauve" : "bg-warn/15 text-warn"));
  // A per-remote override first, then the flag's own hint, then the alert
  // table — a chip with nothing to say still renders, it just has no title.
  const hint =
    hintOverride ??
    (text === "unpinned" ? UNPINNED_HINTS[remoteKind] : undefined) ??
    state?.hint ??
    ALERT_HINTS[text];
  return (
    <span
      className={cn("px-1.5 py-px rounded text-[11px] font-mono shrink-0 leading-snug", tone, dim && "opacity-50")}
      title={hint}
    >
      {text}
    </span>
  );
}

/** The glance-level marker, beside the name.
 *
 *  The chip carries the detail but lives in a column that is hidden below the
 *  `md` breakpoint; the name never is. Visibility stays out of the margin bar
 *  on purpose: that bar is status and nothing else, and the group dot rolls it
 *  up — a second meaning in the same strip would break both. */
function PrivateLock({ v }: { v: Shown<Visibility> }) {
  const label = v.confirmed ? "Private on GitHub" : "Private at the last fetch — not yet confirmed this session";
  return (
    <Lock
      size={11}
      strokeWidth={2.25}
      className={cn("shrink-0 self-center text-digital", !v.confirmed && "opacity-40")}
      aria-label={label}
      role="img"
    >
      <title>{label}</title>
    </Lock>
  );
}

/** A passed account check, beside the lock.
 *
 *  Muted green and small: a pass is reassurance, not news, and it sits on
 *  almost every row. Its absence is the information — a pinned GitHub row with
 *  no key has not been verified, which is not the same as being fine. */
function VerifiedKey({ a }: { a: Shown<string> }) {
  const label = a.confirmed
    ? `Pushes as ${a.value} — this remote's one key is among the keys ${a.value} publishes on GitHub`
    : `Pushed as ${a.value} at the last fetch — remembered, not yet confirmed this session`;
  return (
    <KeyRound
      size={11}
      strokeWidth={2.25}
      className={cn("shrink-0 self-center text-ok/70", !a.confirmed && "opacity-40")}
      aria-label={label}
      role="img"
    >
      <title>{label}</title>
    </KeyRound>
  );
}

/** The margin bar's ends, cut at 45° where a group starts and stops.
 *
 *  Inset bars (below) made every row distinct and, with it, made a group's
 *  edges indistinct: the first bar of a group looked like any other, and so
 *  did the last. Cutting the outer corner of the first and last bar brackets
 *  the group without adding a mark — a lone repo gets both cuts. The cut is
 *  the bar's own width, which is what makes it 45°. SUITE.md's square-corner
 *  rule does not bind here: gtrack took the n-suite as a starting reference
 *  and is not strictly part of it. */
export function barClip(first: boolean, last: boolean): string | undefined {
  if (!first && !last) return undefined;
  const cut = "6px";
  const top = first ? `0 ${cut}, 100% 0` : "0 0, 100% 0";
  const bottom = last ? `100% 100%, 0 calc(100% - ${cut})` : "100% 100%, 0 100%";
  return `polygon(${top}, ${bottom})`;
}

export interface RowProps {
  r: RepoStatus;
  zebra: boolean;
  /** First and last row of its group — see `barClip`. */
  first: boolean;
  last: boolean;
  visibility: Cache<Visibility>;
  accounts: Cache<string>;
  /** When this row alone was last fetched, this session. */
  fetchedAt?: Date;
  /** A single-repo fetch of this row is running. */
  busy: boolean;
  /** Any scan is running — the whole list, or another row. */
  locked: boolean;
  onFetch: (path: string) => void;
}

export function RepoRow({ r, zebra, first, last, visibility, accounts, fetchedAt, busy, locked, onFetch }: RowProps) {
  const sev = severity(r);
  const vis = visibilityMemory.shown(r, visibility);
  const priv = vis?.value === "private" ? vis : null;
  const verified = accountMemory.shown(r, accounts);
  return (
    <div
      className={cn(
        // The tint spans the full window while the columns stop at the cap —
        // banding that stopped mid-screen read as a rendering fault.
        "group/row hover:bg-surfaceHover/50 transition-colors",
        // Zebra only. Rows were tinted by state until 2026-09-19; on the grey
        // chrome a 5% amber over near-black read as mud rather than a colour,
        // and the state is already said twice — the margin bar and the chip,
        // which now carries its state's tone. Stronger banding than before,
        // since it is the only thing separating rows now.
        zebra && "bg-surface/40",
      )}
      title={fetchedAt ? `${r.path}\nfetched alone at ${fetchedAt.toLocaleTimeString()}` : r.path}
    >
      <div
        className={cn(
          // Fixed columns rather than fractions: repo names and semver strings
          // both sit in a narrow, predictable width range, so letting them
          // stretch only pushes the eye across empty space.
          "grid grid-cols-[6px_minmax(7rem,13rem)_minmax(0,1fr)] md:grid-cols-[6px_minmax(9rem,15rem)_8.5rem_11rem_minmax(0,1fr)]",
          // `min-h-7` holds the row at the height the bar used to fill, so the
          // bar below can be shorter than its row.
          "items-center gap-x-3 pr-2 max-w-[64rem] min-h-7",
        )}
      >
      {/* Inset a pixel-pair top and bottom rather than filling the row. A
          full-height bar met its neighbour's, so a run of same-status rows
          drew one unbroken stripe and no row could be told from the next.
          The gap is in the bar, not between rows, so the list keeps its
          density; the corners stay square, per the suite's form rule. */}
      <div
        className={cn(
          "h-6 w-1.5",
          sev === "alert"
            ? "bg-alert"
            : sev === "hold"
              ? "bg-mauve"
              : sev === "warn"
                ? "bg-warn"
                : sev === "archive"
                  ? "bg-muted/40"
                  : sev === "unpinned"
                    ? "bg-mauve/60"
                    : "bg-ok/50",
        )}
        style={{ clipPath: barClip(first, last) }}
      />

      <div className="min-w-0 flex items-baseline gap-1.5">
        <span className="text-sm text-fg truncate leading-snug">{r.name}</span>
        {priv && <PrivateLock v={priv} />}
        {verified && <VerifiedKey a={verified} />}
        {r.branch && r.branch !== "main" && (
          // Grey, not `digital`: that blue means *private*, and a branch name
          // is information, not a state. The mono face sets it apart.
          <span className="text-[11px] font-mono text-fg/60 shrink-0">{r.branch}</span>
        )}
        {/* Fetch this row alone. Faint at rest — present enough to be
            discovered without hovering (0.18 and 0.35 were not), quiet enough that fifty-odd rows do
            not read as fifty-odd buttons — full on hover or focus, and held
            full while it spins. While another scan runs it stays at the faint
            level rather than vanishing, so the column does not flicker. */}
        {r.upstream && (
          <button
            onClick={() => onFetch(r.path)}
            disabled={locked}
            title={fetchedAt ? `Fetch this repo only — last fetched alone at ${fetchedAt.toLocaleTimeString()}` : "Fetch this repo only"}
            aria-label={`Fetch ${r.name} only`}
            className={cn(
              "ml-auto self-center shrink-0 p-0.5 rounded text-muted hover:text-fg hover:bg-fg/10 transition-opacity disabled:cursor-default",
              busy
                ? "opacity-100"
                : "opacity-[0.55] group-hover/row:opacity-100 focus-visible:opacity-100 disabled:!opacity-[0.55]",
            )}
          >
            <RefreshCw size={11} className={busy ? "animate-spin" : ""} />
          </button>
        )}
      </div>

      <div className="font-mono text-xs tabular-nums text-right leading-snug">
        <Version r={r} />
      </div>

      {/* Release position. First to go as the window narrows — it is
          reference, where the flags are the reason to look. */}
      <div className="hidden md:block font-mono text-[11px] text-fg/60 truncate leading-snug">
        {r.latestTag ? (
          <>
            {r.latestTag}
            {r.commitsSinceTag ? <span className="text-warn font-semibold"> +{r.commitsSinceTag}</span> : null}
          </>
        ) : (
          <span className="text-muted/60">untagged</span>
        )}
      </div>

      <div className="hidden md:flex items-center gap-1.5 min-w-0 overflow-hidden">
        {r.flags.length === 0 ? (
          <Flag text="clean" remoteKind={r.remoteKind} />
        ) : (
          r.flags.map((f) => (
            <Flag key={f} text={f} remoteKind={r.remoteKind} hintOverride={rowHint(f, r)} held={sev === "hold"} />
          ))
        )}
        {priv && (
          <Flag
            text="private"
            remoteKind={r.remoteKind}
            dim={!priv.confirmed}
            hintOverride={priv.confirmed ? undefined : REMEMBERED_HINT}
          />
        )}
      </div>
    </div>
    </div>
  );
}
