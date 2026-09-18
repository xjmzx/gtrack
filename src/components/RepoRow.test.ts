import { describe, expect, it } from "vitest";
import { barClip } from "./RepoRow";

describe("barClip", () => {
  it("leaves a middle row's bar square", () => {
    expect(barClip(false, false)).toBeUndefined();
  });

  it("cuts only the top of a group's first bar and only the bottom of its last", () => {
    expect(barClip(true, false)).toBe("polygon(0 6px, 100% 0, 100% 100%, 0 100%)");
    expect(barClip(false, true)).toBe("polygon(0 0, 100% 0, 100% 100%, 0 calc(100% - 6px))");
  });

  it("cuts both ends of a lone repo's bar", () => {
    expect(barClip(true, true)).toBe("polygon(0 6px, 100% 0, 100% 100%, 0 calc(100% - 6px))");
  });
});
