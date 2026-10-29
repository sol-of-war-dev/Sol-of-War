import { expect, it } from "vitest";
import { assertWagerAccess } from "../../src/frontpot/MatchAccess";
it("never allows guest wagers even when the wager allowlist is unrestricted", () => {
  expect(() => assertWagerAccess("", true, null, true)).toThrow("Free Play");
  expect(() => assertWagerAccess("", false, null, true)).not.toThrow();
  expect(() => assertWagerAccess("", false, new Set(), true)).not.toThrow();
});
