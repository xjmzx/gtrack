import { describe, expect, it } from "vitest";
import type { RepoStatus } from "./tauri";
import { accountMemory as acct, visibilityMemory as vis } from "./memory";

function repo(over: Partial<RepoStatus> = {}): RepoStatus {
  return {
    name: "r", path: "/code/r", group: "g", branch: "main", upstream: "origin/main",
    remote: "gh:o/r.git", remoteKind: "ssh-alias", ahead: 0, behind: 0, dirty: 0,
    fetched: false, fetchError: null, visibility: null, account: null,
    versions: { package: null, cargo: null, tauri: null, lock: null, agree: true },
    latestTag: null, tagDate: null, commitsSinceTag: null, locks: [], unpushedTags: [],
    authenticatesAs: null, flags: [],
    ...over,
  };
}

describe("visibility memory", () => {
  it("prefers this session's measurement, drawn as confirmed", () => {
    const cache = vis.remember({}, [repo({ visibility: "public" })]);
    expect(vis.shown(repo({ visibility: "private" }), cache)).toEqual({ value: "private", confirmed: true });
  });

  it("falls back to the memory on a launch with no fetch, drawn as unconfirmed", () => {
    const cache = vis.remember({}, [repo({ visibility: "private", fetched: true })]);
    expect(vis.shown(repo(), cache)).toEqual({ value: "private", confirmed: false });
  });

  it("does not hand one remote's answer to another", () => {
    const cache = vis.remember({}, [repo({ visibility: "private" })]);
    expect(vis.shown(repo({ remote: "gh:someone-else/r.git" }), cache)).toBeNull();
  });

  it("draws nothing for a repo never measured", () => {
    expect(vis.shown(repo(), {})).toBeNull();
  });

  it("keeps the last answer when a scan could not tell", () => {
    const cache = vis.remember({}, [repo({ visibility: "private" })]);
    expect(vis.remember(cache, [repo()])).toEqual(cache);
  });

  it("lets a measurement overwrite the memory", () => {
    const cache = vis.remember({}, [repo({ visibility: "private" })]);
    expect(vis.shown(repo(), vis.remember(cache, [repo({ visibility: "public" })]))?.value).toBe("public");
  });

  it("drops trees that are no longer on disk after a full scan", () => {
    const cache = vis.remember({}, [repo({ visibility: "private" }), repo({ path: "/code/gone", visibility: "private" })]);
    expect(Object.keys(vis.remember(cache, [repo()]))).toHaveLength(1);
  });
});

describe("single-repo scans", () => {
  it("record the one row and leave every other entry alone", () => {
    // The regression this guards: running a one-row list through the full
    // `remember` would prune the other sixty entries.
    const cache = vis.remember({}, [repo({ visibility: "private" }), repo({ path: "/code/b", visibility: "public" })]);
    const next = vis.rememberOne(cache, repo({ path: "/code/b", visibility: "private" }));
    expect(Object.keys(next)).toHaveLength(2);
    expect(vis.shown(repo(), next)?.value).toBe("private");
    expect(vis.shown(repo({ path: "/code/b" }), next)?.value).toBe("private");
  });

  it("keep an answer the single scan could not measure", () => {
    const cache = vis.remember({}, [repo({ visibility: "private" })]);
    expect(vis.rememberOne(cache, repo())).toEqual(cache);
  });
});

describe("account memory", () => {
  it("remembers a pass as the account it pushes as", () => {
    const cache = acct.remember({}, [repo({ account: "owner", authenticatesAs: "xjmzx" })]);
    expect(acct.shown(repo(), cache)).toEqual({ value: "xjmzx", confirmed: false });
  });

  it("lets a mismatch erase a remembered pass, and draws no pass beside it", () => {
    const cache = acct.remember({}, [repo({ account: "owner", authenticatesAs: "xjmzx" })]);
    const wrong = repo({ account: "other", authenticatesAs: "adjmx" });
    expect(acct.shown(wrong, cache)).toBeNull();
    expect(acct.remember(cache, [wrong])).toEqual({});
    expect(acct.rememberOne(cache, wrong)).toEqual({});
  });

  it("keeps a pass through a launch that did not fetch", () => {
    const cache = acct.remember({}, [repo({ account: "owner", authenticatesAs: "xjmzx" })]);
    expect(acct.remember(cache, [repo()])).toEqual(cache);
  });
});
