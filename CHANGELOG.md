# Changelog

## v0.1.1

Verified on all three platforms: built and installed on macOS, Windows and
Linux from the same tree.

- **An archive is its own state, in grey, and no longer reads as a fault.**
  `no upstream` covered two different things and only one of them is a
  problem. A repository with *no remote at all* is a deliberate local archive —
  a tree kept on purpose after its remote went away, holding the only copy of
  what is in it. A branch that tracks nothing *while a remote exists* is the
  alarming case: work with somewhere to go and no route to it. The first now
  flags as `archive`, greys its own row and takes its own lens and count; the
  second keeps `no upstream` and stays red. Prompted by a real one — a
  276-file channel-backup archive whose GitHub repo had been deleted, which
  the old flag painted as rot.
- **`https remote` is a preference, not an emergency.** It now carries the
  mauve of `track` in the wordmark rather than the red of a fault, with its own
  bucket and a tint faint enough to find but not to alarm. An https remote
  fetches perfectly well and usually pushes; wanting every remote on an SSH
  alias — so GitHub actions run as the right account — is a house rule, and
  red made a tidy machine look like an emergency over a naming choice. The
  things that are genuinely broken keep the red to themselves: `stale lock`,
  `unreachable`, `no upstream` and `version mismatch`.
- **The headless scanner counts archives separately** rather than reporting a
  machine with nothing wrong as having something wrong on every run.
- **Fixed: the desktop entry described nping.** `gtrack.desktop.in` was that
  file with the name and paths swapped, so gtrack installed itself as a "Nostr
  Relay Tester" filed under Network, and searching a launcher for "git" or
  "repo" found nothing. Now `Development;RevisionControl;` with its own
  keywords. Linux-only, and written at install time, so neither of the other
  two platforms could see it.
- **Fixed: `make test` did not exist**, though both the README and CLAUDE.md
  documented it.
- **Windows: git no longer flashes a console window per call**, and `~`
  expands from `USERPROFILE`. A scan is roughly ten git invocations per
  repository, so fifteen checkouts flashed some hundred and fifty windows over
  the app and took focus with every one. `expand()` read `HOME`, which Windows
  does not set for a process launched from Explorer, so the default roots
  resolved to nothing and the window came up empty with nothing to explain
  why. Both are `cfg`-guarded; macOS and Linux are unchanged.

- **Roots carry an explicit label.** A group heading derived from a directory
  name changes per machine — `~/code_upleb` is somewhere else on another box —
  so the same collection of repositories would head up under a different name
  on each install. Labels are now configured; the website trees default to
  reading as their domains (`upleb.uk`, `fizx.uk`) rather than their checkout
  paths. A root written as a bare string, the shape before labels existed,
  still parses and falls back to the directory name.

- **Three lenses instead of one alarm.** The single "show problems" toggle is
  now a segmented filter — `all` / `clean` / `dirty` / `https` — each carrying
  its own count. The split is meaningful, not cosmetic: `dirty` is work you did
  and can finish (uncommitted, unpushed, behind), `config` is the setup being
  wrong in a way that bites later (a remote that 403s, a lock blocking writes,
  three version files disagreeing).
- **Per-group counts are a breakdown, not a warning.** A group of ten with one
  bad remote no longer looks like a group that is entirely broken: clean, local
  work and needs-a-fix are three separate figures in three tones, with only the
  last in red.
- **Fixed: banding stopped mid-screen.** Row tint and zebra now span the full
  window while the columns stay capped, instead of ending at the column cap
  while group headers ran full width — which read as a rendering fault at
  fullscreen.
- **Severity now derives from the flags Rust computed** rather than being
  recomputed in TypeScript from raw fields. Duplicating that judgement across
  the IPC boundary is what let a serialisation bug colour broken repos green
  while their own flags said otherwise.

- **Fixed: every repo reported itself untagged.** `RepoStatus` serialised as
  snake_case while the webview read camelCase, so `latestTag`, `tagDate`,
  `commitsSinceTag`, `remoteKind` and `fetchError` all arrived as `undefined`.
  The rows rendered perfectly well and quietly dropped five fields — and two of
  them feed `severity()`, so https-remote and unreachable repositories were
  being coloured as if they were fine. A test now asserts the wire names
  directly, because nothing else about this fails: it compiles, it serialises,
  it does not error.
- **The status reads as a block of colour.** A 2px border at the window edge
  was easy to miss; rows now carry a solid marker and a whole-row tint when
  they need attention, with zebra striping on the rest.
- **Larger type and columns that sit together.** Repo names and semver strings
  both occupy a narrow, predictable width range, so the columns are fixed
  rather than fractional — letting them stretch only pushed the eye across
  empty space. The list stops widening at 64rem for the same reason.

- **Collapsible groups, collapsed by default.** With fifty-odd checkouts an
  expanded list is a wall, and the tool is used one project at a time. Click a
  group header to open it; the state persists per machine.
- **Collapsing hides detail, never signal.** A closed group still shows how
  many repos it holds and, in alert colour, how many of them need looking at —
  so you never have to open all of them to find out where the problem is.
- **A filter overrides collapse.** Turning on the problems-only view is itself
  a request to see what matched, so it opens what it filters to rather than
  leaving results hidden behind a closed section.
- **Compact throughout.** Default window 760×560 (from 1080×720), minimum
  460×320, tighter rows and a denser header, so it can sit beside something
  else rather than needing a screen of its own. The release column is the
  first thing dropped as the window narrows — it is reference, where the flags
  are the reason to look.

## v0.1.0

First release. A read-only tracker for the git checkouts on this machine.

- **Scans configured roots** and reports, per repository: declared version,
  latest tag with date and commits since, ahead/behind/dirty, and findings.
- **Version agreement across three files.** `package.json`, `Cargo.toml` and
  `tauri.conf.json` must be bumped together; when they disagree the row shows
  every value rather than picking one, because the disagreement *is* the
  finding. Three suite apps were caught on the first run with a stale
  `tauri.conf.json` — the file the running app reports its version from.
- **Staleness is stated, never implied.** Opening scans local refs only and
  labels itself as such. Ahead/behind become authoritative only after an
  explicit Fetch. Un-fetched refs report already-pushed commits as unpushed,
  which is a confident wrong answer and the worst thing this tool could do.
- **Fetches the tracked remote only**, never `--all` — one broken auxiliary
  remote would otherwise fail the whole fetch and mark healthy repos
  unreachable.
- **Detects stale `.git/*.lock` files.** Only zero-byte locks are reported: one
  with content may belong to a live operation, and telling someone to delete a
  file a running git is using would be worse than staying quiet.
- **Flags credential-less `https://` remotes**, which look healthy until a push
  returns 403.
- Grouping is configurable; anything unclaimed falls back to its root directory
  name, so a new checkout appears somewhere sensible with no configuration.
- Debug builds use `gtrack.dev.json`, per the suite convention.
- A headless `cargo run --example scan` runs the same scanner as text, for use
  over ssh.

Read-only throughout: no command writes to a working tree, and the only side
effect in the app is an explicit fetch updating remote-tracking refs.

The app icon is a placeholder — visually distinct so it does not share nping's
mark in a launcher, but pending a proper export.

Tauri 2 + React + Vite + Tailwind. No database, no network beyond git itself.
