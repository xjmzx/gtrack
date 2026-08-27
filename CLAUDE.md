# gtrack — notes for Claude

Read-only tracker for the git checkouts on this machine: versions, releases and
repo health. Tauri 2 · React. A development tool, not a music one.

## Read SUITE.md first

[`../ndisc/SUITE.md`](https://github.com/xjmzx/ndisc/blob/main/SUITE.md) is
authoritative for shared conventions — the palette, the top-bar grammar, the
dev/release split. Read it **before making a platform-sensitive choice**; it
records constraints invisible on the machine you are working on.

## Build and verify

```
make dev      # hot reload
make check    # npm run build (tsc + vite) + cargo check
make test     # unit tests
make build    # release
```

The scanner also runs headless, which is how to check it without a window:

```
cd src-tauri && cargo run --example scan            # local refs only
cd src-tauri && cargo run --example scan -- --fetch # fetch first
```

## The one rule

**gtrack never writes to a repository.** No command may. The only side effect
in the entire app is `git fetch` updating remote-tracking refs, and only when
explicitly requested. This is what makes it safe to point at fifty working
trees, and it is not negotiable — a tool that might modify a repo is a tool you
hesitate to run, which defeats the point of it.

## Traps specific to this repo

- **Never fetch implicitly.** Ahead/behind computed against un-fetched refs
  report already-pushed commits as unpushed. That is a *confident wrong answer*
  and it has cost two people a real investigation. Every row carries `fetched`;
  the UI must always say which it is. Adding a convenient auto-fetch on open
  would undo the tool's main correctness property.
- **Fetch the tracked remote, never `--all`.** One broken auxiliary remote
  fails the whole fetch and marks healthy repos unreachable — a mistake made
  for real before this app existed.
- **Only zero-byte `.git/*.lock` files are reported.** A lock with content may
  belong to a live operation; advising deletion there could break a running
  git. The check also skips `.git/objects` and `.git/modules`, which are large
  and hold nothing worth finding.
- **Cargo versions are read with a line scan that stops at the next table.** A
  `version = ` under `[dependencies]` must never be mistaken for the crate's
  own; there is a test for exactly that.
- **Versions "agree" when files are absent.** Only two files that both declare
  a version can disagree — most repos here have just one, and flagging those
  would make the signal useless.
- **Shelling out to `git` is deliberate**, not laziness. Fetching uses the
  machine's own SSH config including per-account host aliases; libgit2 would
  need separate credential plumbing and would get it subtly wrong.
- **SSH alias names are per-machine.** `github-xjmzx` on one box is `xjmzx` on
  another, so remote classification checks the *shape* of a URL, never a
  specific alias name.
- **A failed fetch is promoted to `orphan` only on a positive match.**
  `unreachable` is the default and stays the default. Never match the generic
  `could not read from remote repository` line git appends — it follows a
  refused key exactly as it follows a missing repo, and matching it would turn
  every unloaded ssh-agent into a deleted remote. The conservative direction is
  load-bearing: an orphan left as `unreachable` is only the status quo, where a
  blip mislabelled `orphan` is the confident wrong answer this tool exists not
  to give.
- **Tombstones match on directory name and nothing else.** A `retired` entry
  whose name is also found in the roots raises the on-disk contradiction. That
  is right when it is the same tree re-cloned, and a false alarm when it is a
  *different* repo that merely shares the name — several accounts scanned here
  hold same-named repos, separated only by their owner directory. Never
  tombstone a name that is not unique across the roots.
- **A root that does not exist is skipped silently, and it cuts both ways.**
  It is what lets one set of roots be true on every machine — whether that is
  the built-in defaults or a config copied between boxes. It is equally why a
  wrong root is invisible: nothing scanned looks exactly like nothing to find,
  and an empty result is the one failure a scanner cannot report. The answer is
  to keep the defaults correct everywhere, not to start warning on missing
  roots — a warning would fire on every machine that legitimately lacks one.
- **Nothing removes a tombstone, deliberately.** The list is append-only: the
  value of an entry is entirely in its age, since the confusion it prevents
  arrives late. The only signal that one should go is the on-disk
  contradiction, and gtrack shows it rather than resolving it — only the person
  who wrote the note knows whether the tree was re-cloned or the note was
  written early. Removal is a hand-edit, consistent with roots, groups and
  `archived`, none of which have an editing UI either. `save_config` exists on
  the Rust side but is called from nowhere.
- **Do not add a "delete this repo" action.** It is the most natural feature
  request the `orphan` flag will produce and the clearest possible violation of
  the one rule above. Emitting a path to act on elsewhere is fine; executing
  the removal is not.

## Retirement has three states and they are not interchangeable

Two of them are measured, one is declared, and conflating them is the mistake
this part of the code has already had to undo once.

- **`archive`** — no remote at all, or the name is listed in `archived`. Kept
  on purpose; the contents live nowhere else. A settled state: grey, never red,
  and not counted as a finding by the headless scanner.
- **`orphan`** — a remote exists and answers *no such repository*. Unsettled on
  purpose, and red until a decision is made. It has exactly two exits: drop the
  remote, and it becomes a derived `archive`; or delete the tree and leave a
  tombstone. What is missing is a decision, not a fix, which is why waiting
  does not clear it.
- **`retired`** — a tombstone in `gtrack.json`: a name, an optional ISO date,
  and a note saying what the repo was and where anything worth keeping
  survives. This is the only thing gtrack describes that it cannot scan; every
  other row measures something on disk. The date is optional so a backlog of
  already-deleted repos can still be written down — a tombstone from memory
  beats none.

`archived` and `retired` are *decisions* and hold on every machine; `roots` and
`groups` describe where things sit. Because the defaults now put one root per
GitHub identity under `~/code_gh` at the same relative path everywhere, a
machine following the convention needs no config file at all, and one that
diverges only needs to state the part that differs — every field falls back to
its own default independently. What remains is that a decision still has to be
replicated per box, which is the residual cost of keeping both kinds in one
file.

## Planned

[`BACKLOG.md`](BACKLOG.md) holds the open design question: a CI-status or
release-artifacts column, either of which would be gtrack's **first network
call beyond git**. Read it before adding one — the constraints there (explicit
not implicit, staleness stated, no tokens in the process) are the reasons the
tool is worth using, not preferences.

Also parked, not yet in the backlog: the `retired` list grows without bound by
design, and a flat render stops being scannable somewhere past ~25 entries. The
fix is a rendering change — search for lookup-by-name, grouping by year of
`removed` for browsing — never pruning the data to fit the screen. Every entry
already carries `removed`, so either can be added later with no migration.

## Not here

Machine-local paths, server addresses, credentials and per-box ops belong in a
machine-local `CLAUDE.md`, never in this file. **This repo is public.**
