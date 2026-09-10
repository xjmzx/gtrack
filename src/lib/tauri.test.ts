// The judgement layer's tests.
//
// `bucket`, `severity` and `groupSeverity` are where the Rust flags become a
// colour, a count and a filter, and until this file existed they were the only
// part of gtrack with no tests at all. That gap shipped a crash: `hold` was
// added to `Severity` and not to the rank it is looked up in, `groupSeverity`
// returned `undefined`, and the group dot threw and took React with it —
// through `make check`, a release build and an install, twice, because 26
// green Rust tests say nothing about any of this.
//
// So the emphasis here is exhaustiveness over cases. Anything keyed by a union
// gets walked over every member of that union, because the bug was never a
// wrong answer — it was a missing key that typechecked.

import { describe, expect, it } from "vitest";
import {
  bucket,
  counts,
  groupSeverity,
  matches,
  severity,
  type Bucket,
  type Filter,
  type RemoteKind,
  type RepoStatus,
  type Severity,
} from "./tauri";

/** A clean repo. Tests name only the fields they are about. */
function repo(over: Partial<RepoStatus> = {}): RepoStatus {
  return {
    name: "r",
    path: "/tmp/r",
    group: "g",
    branch: "main",
    upstream: "origin/main",
    remote: "git@alias:o/r.git",
    remoteKind: "ssh-alias" as RemoteKind,
    ahead: 0,
    behind: 0,
    dirty: 0,
    fetched: false,
    fetchError: null,
    versions: { package: null, cargo: null, tauri: null, lock: null, agree: true },
    latestTag: null,
    tagDate: null,
    commitsSinceTag: null,
    locks: [],
    flags: [],
    ...over,
  };
}

const ALL_SEVERITIES: Severity[] = ["alert", "warn", "ok", "archive", "unpinned", "hold"];
const ALL_BUCKETS: Bucket[] = ["clean", "dirty", "config", "archive", "unpinned", "hold"];

/** One repo per severity, so a test can walk the whole union. */
const BY_SEVERITY: Record<Severity, RepoStatus> = {
  alert: repo({ flags: ["stale lock"] }),
  warn: repo({ flags: ["2 dirty"] }),
  unpinned: repo({ flags: ["unpinned"] }),
  archive: repo({ flags: ["archive"] }),
  hold: repo({ flags: ["no push"] }),
  ok: repo({ flags: [] }),
};

describe("bucket", () => {
  it("puts a repo with nothing to say in clean", () => {
    expect(bucket(repo())).toBe("clean");
  });

  it("lets a fault outrank every settled state", () => {
    // A held repo with a stale lock is still a broken repo. Not pushing it
    // does nothing about the lock.
    expect(bucket(repo({ flags: ["no push", "stale lock"] }))).toBe("config");
    expect(bucket(repo({ flags: ["archive", "version mismatch"] }))).toBe("config");
    expect(bucket(repo({ flags: ["unpinned", "orphan"] }))).toBe("config");
  });

  it("keeps a held repo out of dirty, which is the point of the flag", () => {
    // The regression the declaration exists to prevent: unpushed commits on a
    // held repo are expected, and amber would put the row back among chores.
    expect(bucket(repo({ flags: ["no push", "unpinned", "1 unpushed"] }))).toBe("hold");
    expect(bucket(repo({ flags: ["no push", "3 dirty"] }))).toBe("hold");
    expect(bucket(repo({ flags: ["no push", "archive"] }))).toBe("hold");
  });

  it("ranks the remaining settled states below hold and above dirty", () => {
    expect(bucket(repo({ flags: ["archive"] }))).toBe("archive");
    expect(bucket(repo({ flags: ["unpinned"] }))).toBe("unpinned");
    expect(bucket(repo({ flags: ["unpinned", "2 behind"] }))).toBe("unpinned");
    expect(bucket(repo({ flags: ["2 behind"] }))).toBe("dirty");
  });
});

describe("severity", () => {
  it("gives every bucket a severity", () => {
    // Not a value check — a totality check. A bucket with no case would fall
    // to the default and read as `ok`, colouring a fault green.
    for (const b of ALL_BUCKETS) {
      const rows: Record<Bucket, RepoStatus> = {
        clean: BY_SEVERITY.ok,
        dirty: BY_SEVERITY.warn,
        config: BY_SEVERITY.alert,
        archive: BY_SEVERITY.archive,
        unpinned: BY_SEVERITY.unpinned,
        hold: BY_SEVERITY.hold,
      };
      expect(bucket(rows[b])).toBe(b);
      expect(ALL_SEVERITIES).toContain(severity(rows[b]));
    }
  });

  it("does not colour a held repo as ok", () => {
    expect(severity(BY_SEVERITY.hold)).toBe("hold");
  });
});

describe("groupSeverity", () => {
  it("returns a real severity for every single-row group", () => {
    // THE regression test. `hold` was missing from the rank, `indexOf` gave
    // -1, and `SEVERITY_RANK[-1]` was `undefined` — which the group dot then
    // dereferenced. Walking the union is what makes a missing key fail here
    // rather than in front of someone.
    for (const s of ALL_SEVERITIES) {
      const got = groupSeverity([BY_SEVERITY[s]]);
      expect(got, `severity ${s} rolled up to ${String(got)}`).toBeDefined();
      expect(ALL_SEVERITIES).toContain(got);
    }
  });

  it("never lets one row poison a group", () => {
    // The shape of the crash: a held row among clean ones took the whole
    // group's dot to undefined, not just its own.
    for (const s of ALL_SEVERITIES) {
      const got = groupSeverity([BY_SEVERITY.ok, BY_SEVERITY[s], BY_SEVERITY.ok]);
      expect(ALL_SEVERITIES).toContain(got);
    }
  });

  it("rolls up to the worst present, in rank order", () => {
    expect(groupSeverity([BY_SEVERITY.ok, BY_SEVERITY.archive])).toBe("archive");
    expect(groupSeverity([BY_SEVERITY.archive, BY_SEVERITY.unpinned])).toBe("unpinned");
    expect(groupSeverity([BY_SEVERITY.unpinned, BY_SEVERITY.warn])).toBe("warn");
    // `hold` outranks the amber: a caution that sorts under routine work gets
    // masked by it in exactly the mixed group where it needed saying.
    expect(groupSeverity([BY_SEVERITY.warn, BY_SEVERITY.hold])).toBe("hold");
    // And a fault still outranks the caution.
    expect(groupSeverity([BY_SEVERITY.hold, BY_SEVERITY.alert])).toBe("alert");
  });

  it("is order-independent", () => {
    const rows = [BY_SEVERITY.ok, BY_SEVERITY.hold, BY_SEVERITY.warn, BY_SEVERITY.alert];
    expect(groupSeverity(rows)).toBe("alert");
    expect(groupSeverity([...rows].reverse())).toBe("alert");
  });

  it("rolls an empty set up to ok", () => {
    expect(groupSeverity([])).toBe("ok");
  });
});

describe("counts", () => {
  it("accounts for every row exactly once", () => {
    // The invariant the toolbar promises. A bucket missing from `Counts`
    // would increment `undefined` and quietly lose rows from the total.
    const rows = ALL_SEVERITIES.map((s) => BY_SEVERITY[s]);
    const c = counts(rows);
    const total = Object.values(c).reduce((a, b) => a + b, 0);
    expect(total).toBe(rows.length);
    for (const b of ALL_BUCKETS) expect(c[b]).toBeGreaterThanOrEqual(0);
  });

  it("counts a held repo under hold and nowhere else", () => {
    const c = counts([BY_SEVERITY.hold]);
    expect(c.hold).toBe(1);
    expect(c.dirty).toBe(0);
    expect(c.clean).toBe(0);
  });
});

describe("matches", () => {
  it("finds a repo under its own lens even when a fault outranks it", () => {
    // Flag-based, not bucket-based, on purpose: a held repo with a stale lock
    // belongs in `config`, and hiding it from the `hold` filter would make the
    // filter lie about how many repos must not be pushed.
    const held = repo({ flags: ["no push", "stale lock"] });
    expect(bucket(held)).toBe("config");
    expect(matches(held, "hold")).toBe(true);

    const archived = repo({ flags: ["archive", "stale lock"] });
    expect(matches(archived, "archive")).toBe(true);

    const unpinned = repo({ flags: ["unpinned", "orphan"] });
    expect(matches(unpinned, "unpinned")).toBe(true);
  });

  it("passes everything under all, and matches the plain buckets", () => {
    const filters: Filter[] = ["all", "clean", "dirty", "unpinned", "archive", "hold"];
    for (const f of filters) {
      for (const s of ALL_SEVERITIES) {
        expect(typeof matches(BY_SEVERITY[s], f)).toBe("boolean");
      }
    }
    expect(matches(BY_SEVERITY.ok, "all")).toBe(true);
    expect(matches(BY_SEVERITY.ok, "clean")).toBe(true);
    expect(matches(BY_SEVERITY.hold, "clean")).toBe(false);
  });
});
