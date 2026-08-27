# Changelog

## v0.1.6

- **One root convention, and the defaults now hold it.** The built-in roots
  carried a single machine's layout — `~/code_upleb` and `~/code_vibe` beside
  the `~/code_gh` trees — so a fresh install was right on exactly one box and
  silently scanned nothing on the others. An empty window is the one failure a
  scanner cannot report, because it looks identical to a clean sweep. The
  defaults are now the three identity roots under `~/code_gh`, the same path on
  every platform, relative to that platform's home directory. A machine that
  keeps its checkouts elsewhere costs a symlink; a machine that follows the
  convention costs no configuration at all.
- **The website trees moved from roots to groups.** `fizx.uk` and `upleb.uk`
  were root headings back when they were their own directories. They cannot be
  roots any more and should not have been: `adjmx` holds the fizx.uk sites
  *and* the ledger apps, and a root heading cannot say both. As groups they say
  the true thing — a domain is a set of repositories, not a place on disk — and
  a root heading is left naming what it actually is, a GitHub identity.

## v0.1.5

- **A deleted remote is no longer a dropped connection.** `unreachable`
  carried both, and only one of them can be waited out: a remote answering *no
  such repository* is a durable fact — deleted, renamed, or belonging to an
  account this machine does not authenticate as — where DNS, a refused
  connection or an unloaded key is a condition of the moment. Sharing one flag
  between them hid a real case. The one checkout here whose remote had been
  deleted read as `1 behind`: indistinguishable, on a local scan, from a repo
  that simply owed a pull. It now reads `orphan`. The classification is
  conservative by construction — `unreachable` stays the default and a failure
  is promoted only on a positive match, because a blip mislabelled `orphan` is
  the confident wrong answer this tool exists not to give. The generic
  `could not read from remote repository` that git appends is deliberately not
  a signal: it follows a refused key as readily as a missing repo.
- **`orphan` is unsettled on purpose,** and has exactly two exits. Drop the
  remote and it becomes a derived `archive` — kept deliberately, contents
  living nowhere else. Or delete the tree and leave a tombstone. It stays red
  until one of those is chosen, because what is missing is the decision, not a
  fix.
- **Tombstones: a `retired` list in `gtrack.json`,** beside `archived`. Name,
  optional date, and one line saying what the repo was and where anything worth
  keeping survives. This is the only thing gtrack describes that it cannot
  scan, and the reason it exists is that deletion alone does not answer the
  question the tool was built for — a dead end removed is cheaper to store but
  no easier to identify six months later, when its name still turns up in a
  deploy note with nothing behind it. A few hundred bytes against a repository.
  The date is optional so an already-deleted backlog can still be recorded;
  a tombstone written from memory beats none.
- **A tombstone whose tree is on disk is shown, not resolved.** Either it was
  re-cloned or the note was written ahead of the deletion, and only the person
  who wrote it knows which. The section sits outside the filter row, which
  partitions the scanned set — a category that is by definition not in that set
  would break the arithmetic those counts promise. The headless scanner prints
  the same list, which on a sweep over ssh is the half of the picture no amount
  of looking at the filesystem could give.

## v0.1.4

- **Archives can be declared, not only derived.** A repository with no remote
  is *derived* to be an archive — the evidence is on disk. A repository whose
  remote still exists but has been retired leaves no local evidence at all, so
  it is now declared: an `archived` list of repo names in `gtrack.json`. Asking
  GitHub instead would mean a network call per repository on every scan, for a
  fact that changes perhaps twice a year and is a decision rather than a
  measurement. A declared archive outranks the derived reading; other flags on
  the row are untouched, so a retired repo with uncommitted work still says so.
- **The headless scanner reads the real config.** It built `Config::default()`
  and so reported on configuration the app was not using — a second tool
  wearing the first one's name. It now resolves the same path Tauri does.
  **Run it with `--release`**: a debug build reads `gtrack.dev.json` while the
  installed app reads `gtrack.json`, which is the dev/release split working and
  a good way to confuse yourself.

## v0.1.3

- **Release workflow.** A `v*` tag now builds all three platforms gtrack is
  actually used on: `.deb` + `.AppImage` for Linux x86_64, `.dmg` for macOS
  arm64, `.exe` (NSIS) for Windows x86_64. Three jobs because a Tauri app has
  no cross-compile path between them — each needs its own platform's WebView.
  Linux runs first and owns the release; macOS and Windows depend on it and
  only append their asset, so no two jobs race to create the same release or
  overwrite its notes. The Linux job runs `cargo test` first: a release that
  reported the wrong version for every repository would be worse than none.
  NSIS rather than MSI deliberately — WiX rejects a non-numeric version, so a
  pre-release tag would fail to bundle at all.

## v0.1.2

- **`make version V=x.y.z` bumps all five places at once.** Two in
  `package-lock.json`, one each in `package.json`, `Cargo.toml` and
  `tauri.conf.json`, plus the entry `Cargo.lock` keeps for this crate. Editing
  a subset by hand is the entire failure mode the version check exists to
  catch, so the fix is to stop making it possible rather than only to detect
  it. Also gives `package.json` and `tauri.conf.json` the trailing newline they
  never had.

- **`package-lock.json` joins the version check.** It is a fourth file in the
  same invariant and it drifts more quietly than the others, because `npm
  version` maintains it and a hand-edit does not — v0.1.1 shipped that way, and
  six repositories across the suite turned out to be carrying the same drift,
  one of them four releases behind. The lockfile states its version **twice**,
  at the top level and under `packages[""]`, so both are read: a lockfile
  disagreeing with itself is caught by the same comparison as one disagreeing
  with `package.json`, with no special case. A mismatch now shows the distinct
  values rather than one entry per file, so the two that differ are the two you
  see.

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
