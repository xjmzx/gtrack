# gtrack

A read-only tracker for the git checkouts on this machine — part of the
**ndisc** suite, though it is a development tool rather than a music one.

It answers a single question at a glance: *what state is everything actually
in?* Versions declared, releases tagged, work unpushed, remotes that will fail
when you try to push them, and locks that have been silently blocking writes
for weeks.

## Why

Every problem it surfaces is one that was found by hand, late, after it had
already cost something:

- A version lives in **three files** — `package.json`, `Cargo.toml` and
  `tauri.conf.json` — which must be bumped together. When they drift, the app
  reports a version it isn't. Three suite apps were doing exactly this on
  gtrack's first run.
- **`https://` remotes without credentials** look healthy until a push returns
  403. Two repos sat like that for a month.
- **Stale `.git/*.lock` files** leave refs valid and ahead/behind sane while
  every write fails. Sixteen of them, fifteen from a single interrupted day,
  had been blocking pulls for six weeks.
- **Un-fetched refs report pushed commits as unpushed.** Two people
  independently investigated phantom work in the same afternoon.
- **A checkout whose remote had been deleted read as `1 behind`** — on a local
  scan, indistinguishable from a repo that simply owed a pull. It took reading
  two repositories' histories to establish what it had been and whether
  anything in it lived nowhere else.

None of those were hard to fix. They were hard to *notice*.

## What it shows

Repositories grouped by suite — grouping is configurable, not hardcoded — with
per repo: the declared version (and a loud marker when the three files
disagree), the latest tag with its date and how far `HEAD` has drifted past it,
ahead/behind/dirty counts, and any findings worth acting on.

**Staleness is stated, never implied.** A scan on open reads local state only
and says so. Ahead/behind become authoritative only after an explicit **Fetch**,
which fetches each repo's *tracked* remote — never `--all`, which fails outright
if any auxiliary remote is broken and turns healthy repos into false alarms.

**A failed fetch says which kind it was.** `unreachable` is a condition of the
moment — DNS, a refused connection, a key not loaded. `orphan` is a remote
answering *no such repository*: deleted, renamed, or owned by an account this
machine does not authenticate as. The split is conservative, promoting only on
a positive match, because a blip mislabelled `orphan` would be exactly the
confident wrong answer this tool exists to prevent. An `orphan` has two exits,
and stays red until one is taken: drop the remote and it becomes an `archive`
kept on purpose, or delete the tree and leave a tombstone.

**Retired repositories are remembered without being kept.** `gtrack.json` holds
a `retired` list — a name, an optional date, and one line saying what the repo
was and where anything worth keeping survives. It is the only thing gtrack
describes that it cannot scan, and it is there because deleting a dead end is
cheaper to store but no easier to identify later, when its name still turns up
in a deploy note with nothing behind it. A name recorded as deleted that turns
up on disk anyway is flagged rather than quietly resolved.

## Read-only, by design

gtrack never writes to a repository. There is no command that can. The only
side effect anywhere in the app is `git fetch` updating remote-tracking refs,
and only when asked. That is what makes it safe to point at fifty working trees
without thinking about it.

## Configuration

`gtrack.json` in the app config directory holds the roots to scan and the group
labels. Debug builds use `gtrack.dev.json`, so a dev run never rewrites the
installed app's configuration.

## Develop

```sh
make deps     # npm install + cargo fetch
make dev      # tauri dev (hot reload)
make check    # typecheck + cargo check
make test     # unit tests
make build    # release binary
```

There is also a headless version of the scanner, useful over ssh where no GUI
exists:

```sh
cd src-tauri
cargo run --release --example scan            # local refs only
cargo run --release --example scan -- --fetch # fetch tracked remotes first
```

`--release` matters: a debug build reads `gtrack.dev.json` while the installed
app reads `gtrack.json`, so without it the scanner reports on a different
configuration than the window shows.

## Status

v0.1.1 — the scan, the grouping, and the version/release/health view, built
and installed on macOS, Windows and Linux from the same tree.

Findings are graded rather than lumped together: red is a fault (`stale lock`,
`unreachable`, `no upstream`, `version mismatch`), amber is work in progress,
mauve is an `https remote` — a preference, since it fetches and usually pushes
— and grey is an `archive`, a repository with no remote kept deliberately as
the only copy of what is in it.

Not yet: per-repo tag history and distance to a stable 1.0; the second pinning
axis, tracking which consumers have re-vendored which frozen contract SHA. The
app icon is a placeholder pending a proper export.
