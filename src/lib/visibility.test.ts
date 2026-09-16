import { describe, expect, it } from "vitest";
import type { RepoStatus } from "./tauri";
import { remember, shownVisibility, type VisibilityCache } from "./visibility";

function repo(over: Partial<RepoStatus> = {}): RepoStatus {
  return {
    name: "r", path: "/code/r", group: "g", branch: "main", upstream: "origin/main",
    remote: "gh:o/r.git", remoteKind: "ssh-alias", ahead: 0, behind: 0, dirty: 0,
    fetched: false, fetchError: null, visibility: null,
    versions: { package: null, cargo: null, tauri: null, lock: null, agree: true },
    latestTag: null, tagDate: null, commitsSinceTag: null, locks: [], flags: [],
    ...over,
  };
}

describe("shownVisibility", () => {
  it("prefers this session's measurement, drawn as confirmed", () => {
    const cache = remember({}, [repo({ visibility: "public" })]);
    expect(shownVisibility(repo({ visibility: "private" }), cache)).toEqual({ value: "private", confirmed: true });
  });

  it("falls back to the memory on a launch with no fetch, drawn as unconfirmed", () => {
    const cache = remember({}, [repo({ visibility: "private", fetched: true })]);
    expect(shownVisibility(repo(), cache)).toEqual({ value: "private", confirmed: false });
  });

  it("does not hand one remote's answer to another", () => {
    const cache = remember({}, [repo({ visibility: "private" })]);
    expect(shownVisibility(repo({ remote: "gh:someone-else/r.git" }), cache)).toBeNull();
  });

  it("draws nothing for a repo never measured", () => {
    expect(shownVisibility(repo(), {})).toBeNull();
  });
});

describe("remember", () => {
  it("keeps the last answer when a scan could not tell", () => {
    const cache = remember({}, [repo({ visibility: "private" })]);
    // A local scan, or a fetch whose probe failed: visibility null.
    expect(remember(cache, [repo()])).toEqual(cache);
  });

  it("lets a measurement overwrite the memory", () => {
    const cache = remember({}, [repo({ visibility: "private" })]);
    const next = remember(cache, [repo({ visibility: "public" })]);
    expect(shownVisibility(repo(), next)?.value).toBe("public");
  });

  it("drops trees that are no longer on disk", () => {
    const cache: VisibilityCache = remember({}, [repo({ visibility: "private" }), repo({ path: "/code/gone", visibility: "private" })]);
    expect(Object.keys(remember(cache, [repo()]))).toHaveLength(1);
  });
});
