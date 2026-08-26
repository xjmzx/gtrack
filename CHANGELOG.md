# Changelog

## Unreleased

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
