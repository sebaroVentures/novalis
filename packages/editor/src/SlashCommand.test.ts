import { describe, expect, it } from "vitest";

import { matchSlashToken } from "./SlashCommand";

describe("matchSlashToken", () => {
  it("matches a /query at the start of a line", () => {
    expect(matchSlashToken("/head")).toEqual({ token: "/head", query: "head" });
  });

  it("matches after whitespace only", () => {
    expect(matchSlashToken("text /code")).toEqual({ token: "/code", query: "code" });
    expect(matchSlashToken("a/b")).toBeNull();
  });

  it("matches non-ASCII letters instead of closing mid-word", () => {
    expect(matchSlashToken("/überschrift")).toEqual({
      token: "/überschrift",
      query: "überschrift",
    });
    expect(matchSlashToken("/matemáticas")).toEqual({
      token: "/matemáticas",
      query: "matemáticas",
    });
  });

  it("matches a bare / (empty query) so the menu opens on the trigger", () => {
    expect(matchSlashToken("x /")).toEqual({ token: "/", query: "" });
  });

  it("does not match once the token is broken by a space", () => {
    expect(matchSlashToken("/über ")).toBeNull();
  });
});
