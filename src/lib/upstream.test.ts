import { describe, expect, it } from "vitest";
import {
  groupStanding,
  kind,
  standing,
  upstreamCounts,
  upstreamMatches,
  type Standing,
  type UpstreamFilter,
  type UpstreamStatus,
} from "./upstream";

function row(flags: string[], over: Partial<UpstreamStatus> = {}): UpstreamStatus {
  return {
    name: "r",
    path: "/x/r",
    group: "g",
    branch: "main",
    detachedAt: null,
    upstream: "origin/main",
    remote: "https://example.com/r.git",
    ahead: 0,
    behind: 0,
    edited: 0,
    untracked: 0,
    upstreamDate: "2026-11-01",
    idleDays: 4,
    fetched: true,
    fetchError: null,
    locks: [],
    flags,
    ...over,
  };
}

// One example row per standing. A `Record`, so a standing added later without
// an example here fails to compile rather than going untested.
const EXAMPLE: Record<Standing, string[]> = {
  stuck: ["diverged"],
  behind: ["633 behind"],
  differs: ["2 edited", "3 untracked"],
  pinned: ["detached"],
  inactive: ["inactive"],
  synced: [],
};

describe("upstream standing", () => {
  it("reads every standing from its flags", () => {
    for (const [s, flags] of Object.entries(EXAMPLE) as [Standing, string[]][]) {
      expect(standing(row(flags))).toBe(s);
    }
  });

  it("strips the count from a flag", () => {
    expect(kind("633 behind")).toBe("behind");
    expect(kind("2 local")).toBe("local");
    expect(kind("diverged")).toBe("diverged");
  });

  it("treats every broken-remote flag as stuck", () => {
    for (const f of ["stale lock", "no remote", "no upstream", "orphan", "unreachable", "2 local"]) {
      expect(standing(row([f]))).toBe("stuck");
    }
  });

  it("lets the worse standing win on one row", () => {
    expect(standing(row(["3 behind", "inactive"]))).toBe("behind");
    expect(standing(row(["no upstream", "orphan"]))).toBe("stuck");
    expect(standing(row(["1 edited", "detached"]))).toBe("differs");
  });

  it("rolls a group up to its worst row, with inactive below synced", () => {
    expect(groupStanding([row([]), row(["inactive"])])).toBe("synced");
    expect(groupStanding([row(["inactive"]), row(["inactive"])])).toBe("inactive");
    expect(groupStanding([row([]), row(["5 behind"]), row(["diverged"])])).toBe("stuck");
    // Every standing has a rank: none rolls up to undefined.
    for (const flags of Object.values(EXAMPLE)) {
      expect(groupStanding([row(flags)])).toBeDefined();
    }
  });

  it("counts every row exactly once", () => {
    const rows = Object.values(EXAMPLE).map((f) => row(f));
    const c = upstreamCounts(rows);
    expect(Object.values(c).reduce((a, b) => a + b, 0)).toBe(rows.length);
    for (const s of Object.keys(EXAMPLE) as Standing[]) expect(c[s]).toBe(1);
  });

  it("finds an inactive project under its filter even when it is also behind", () => {
    const r = row(["3 behind", "inactive"]);
    expect(upstreamMatches(r, "inactive")).toBe(true);
    expect(upstreamMatches(r, "behind")).toBe(true);
    expect(upstreamMatches(r, "synced")).toBe(false);
    const filters: UpstreamFilter[] = ["all", "stuck", "behind", "differs", "pinned", "inactive", "synced"];
    for (const f of filters) expect(typeof upstreamMatches(r, f)).toBe("boolean");
  });
});
