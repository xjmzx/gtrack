# CI proposal — trial on gtrack, then the suite

**Status: proposal.** Trialled on gtrack. Confirm or revise it over the next
few releases, then decide whether the other seven adopt it as-is or via a
reusable workflow.

## The problem

There is no CI anywhere in the suite. Every repo has exactly one workflow,
`release.yml`, and its `push` trigger is scoped to `tags: ["v*"]` — no
`branches:` key. Nothing runs on a push to `main`.

Two consequences:

1. **`make check` and the Rust tests exist but nothing runs them.** Six of
   seven crates have `#[test]` blocks. They only ever run when someone runs
   them locally.
2. **The first thing that compiles a commit is the release build itself.** A
   break is discovered *after* a tag exists — and the release is then half
   published, because the Linux job creates the release and owns its notes
   while macOS and Windows append to it. A Windows failure leaves a public
   release standing with fewer artifacts than it should have.

ntree is the worked example: it does not compile on Windows at all, and that
was found by trying to add a Windows target, not by any check.

## What is proposed

`.github/workflows/ci.yml` — on push to `main` and on PRs, a three-platform
matrix running the same two commands `make check` runs, plus `cargo test`.

**Three platforms is the load-bearing choice.** The failure class this exists
to catch is platform-specific compilation. A Linux-only CI would have passed
ntree's Windows break — reporting green on precisely the fault it was added to
find, which is worse than having no CI at all.

**`cargo check`, not a bundle.** The release workflow owns bundling and should
keep owning it. CI proves the thing compiles on all three and the tests pass.

**Free.** All eight repos are public, so Actions minutes are unmetered — the
usual objection to a 3-OS matrix (macOS bills 10x, Windows 2x) does not apply.

## Deliberate details

- **`fail-fast: false`** — every platform reports. "Windows only" versus "all
  three" separates a portability bug from a plain mistake.
- **`concurrency` with `cancel-in-progress`** — CI only. Release runs are never
  cancelled by it.
- **Commands spelled out, not `make check`** — GNU make is not dependably on
  PATH on `windows-latest`, and a CI that cannot run on the platform it exists
  to test is no use. **If these drift, the Makefile is the source of truth.**
- **`npm run build` before cargo** — not just ordering taste: `tauri-build`
  resolves `frontendDist` (`../dist`) at build-script time and fails if it is
  absent, so cargo cannot run first.
- **`--locked`** — CI should fail on an out-of-date lockfile rather than
  quietly resolving something the developer never had.

## Open questions — to answer with evidence, not now

- **Timings.** Fill in after the first few runs. The release workflow takes
  12–14 min for three platforms *with* bundling; this should be well under
  that. If Windows dominates, that is worth knowing before rolling out to
  seven more repos.

  | platform | cold cache | warm cache |
  |---|---|---|
  | Linux x86_64 | — | — |
  | macOS arm64 | — | — |
  | Windows x86_64 | — | — |

- **The duplicated `npm run build`.** It runs on all three platforms, but
  TypeScript is platform-independent — only the `dist/` output is needed by
  `tauri-build`. Building once and passing `dist/` to the other two as an
  artifact would cut it, at the cost of a fourth job and more moving parts.
  **Measure first**; if the frontend build is a small fraction of each run,
  this is not worth the complexity.

- **One file or eight.** Eight copies is the coordinated-wave problem the suite
  already pays repeatedly. A reusable workflow (`workflow_call`) in one repo,
  called by the rest, is one file to change instead of eight. Settle the shape
  here first — factoring a design that is still moving is premature.

## Rolling out to the other seven

Not uniform. What each app needs:

| app | notes |
|---|---|
| ndisc, nplay, nsmpl | as-is. `make check` present; `make test` target missing though the crates have tests |
| nchat | as-is, **plus `libsecret-1-dev`** in the Linux dep step — it holds keys |
| nping | as-is, but it has **no Rust tests**; the compile check is the whole value |
| ntree | **expected to fail on Windows, correctly.** Either drop Windows from its matrix with a comment pointing at the CHANGELOG entry, or let it fail visibly as a standing reminder. A decision, not an oversight |
| nview | **different shape.** Capacitor: one Ubuntu job, web bundle + Android APK, no desktop target and no `check`/`test` targets in its Makefile |

Also worth doing alongside, and independent of CI: **`make test` is only in
nchat and gtrack.** Five other Makefiles need the target so CI can call one
uniform command.

## Separate, and arguably worth more

The release is **non-atomic**: Linux creates the release, the other two append.
A failure after the first job leaves a public release holding an incomplete set
of artifacts. Restructuring so all three builds finish *before* anything
publishes would mean a failed release simply does not appear. CI lowers the
odds of that; this removes the outcome.
