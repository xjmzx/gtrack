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

## Not here

Machine-local paths, server addresses, credentials and per-box ops belong in a
machine-local `CLAUDE.md`, never in this file. **This repo is public.**
