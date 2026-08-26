# Changelog

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
