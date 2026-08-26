# gtrack — backlog

## Remote state: CI status, or release artifacts

Two candidate columns, noted 2026-08-27. **Either would be gtrack's first
network call beyond git**, which is the decision to make before the feature.

### The prompt

A CI failure in `macos-node/radio-scan` sat unread in the GitHub notifications
inbox for a week and was then misattributed to a different repository. A red X
in that inbox looks the same whether it is live or long since fixed — the run
that failed on 19 Aug had been green again since 25 Aug. gtrack already knows
every repository on the machine; it does not know which of them is red *now*.

### Option 1 — CI status column

Latest workflow-run conclusion per repository.

- Source: `gh run list --repo <slug> --limit 1`, shelling out exactly as the
  git calls do. That keeps gtrack free of token handling: `gh` owns the
  credential, gtrack never sees one, and the no-secrets property holds.
- Covers **all** CI, not just releases — the failure that prompted this was a
  per-push CI run, and `radio-scan` is the only repo here running CI on every
  push rather than only on tags, so it is the only one with real exposure.
- Cost: one call per repository. Unauthenticated public reads are 60/hour,
  which 58 repos would exhaust in a single sweep; via `gh` it is 5000/hour.

### Option 2 — release artifacts

What is actually published against the latest tag.

- Source: `gh release view <tag> --json assets`.
- Answers a question gtrack raises but cannot close: it shows the latest tag
  and how far `HEAD` has drifted past it, but not whether that tag produced
  anything. Two live examples — `gtrack v0.1.2` was tagged before this repo had
  a release workflow, so it has no artifacts at all; `nchat v0.1.0-beta.1` was
  never tagged, so its release exists only as a local build.
- Also catches a tag whose release run failed: the release exists, the assets
  do not.

### The shared question, and it is the real one

gtrack is local-only today — git and the filesystem, nothing else. That is why
it opens instantly, works offline, and has no auth story to get wrong. Adding
either column means:

1. **Explicit, never implicit.** A network call per repository belongs behind a
   button like Fetch, not on open. Fifty-eight calls on launch would make a
   glanceable tool something you wait for.
2. **Staleness stated, as everywhere else.** A CI column silently showing
   week-old data is the same class of fault as ahead/behind computed against
   un-fetched refs — a confident wrong answer, which this tool exists not to
   give. Whatever lands must carry its own freshness the way `fetched` does.
3. **No tokens in gtrack.** Shelling out to `gh` keeps the credential outside
   the process. A token in `gtrack.json` would make this the first component of
   the suite holding a secret it does not need.

**Leaning toward option 1.** It fixes the failure actually observed; option 2
closes a rarer gap that is already visible indirectly, and a missing artifact is
usually the *consequence* of a failed run that option 1 would have shown first.
