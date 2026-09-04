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
  | Linux x86_64 | 5m04s | — |
  | macOS arm64 | 3m50s | — |
  | Windows x86_64 | 7m00s | — |

  First run (`33884023384`, all green): **~7m wall-clock**, the three in
  parallel, against 14m52s for the v0.1.10 release. Windows is the long pole
  and sets the number; it is slower at everything (checkout 11s vs 1s, Rust
  setup 23s vs 13s, npm deps 12s vs 3s) on top of slower compilation.

- ~~**The duplicated `npm run build`.**~~ **Answered: leave it.** It costs
  **5s, 5s and 7s** on the three platforms — around 1.5% of each run. A fourth
  job and an artifact hand-off to reclaim that would be a clear loss.

- **New, and worth more: `cargo check` and `cargo test` pay for compilation
  twice.** They are the whole runtime — 195s of Linux's 304s, 155s of macOS's
  230s, 270s of Windows' 420s, about 64% everywhere — and they do not share
  artifacts, because `check` skips codegen and `test` needs it.

  | platform | cargo check | cargo test |
  |---|---|---|
  | Linux | 89s | 106s |
  | macOS | 79s | 76s |
  | Windows | 134s | 136s |

  `cargo test` already compiles the bin targets, so the separate `check` may be
  buying little beyond a faster failure on a syntax error. Collapsing to a
  single `cargo test --locked --all-targets` looks like it could take roughly a
  third off every platform. **Worth trying once there are warm-cache numbers to
  compare against** — measure it, do not assume it.

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
