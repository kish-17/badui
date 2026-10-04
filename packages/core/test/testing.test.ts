import { describe, expect, it } from "vitest";
import { makeCandidate, makeObservation } from "@brake/core/testing";

describe("test builders", () => {
  it("build valid defaults", () => {
    expect(makeObservation({ minor: 500 }).amount?.value.minor).toBe(500);
    expect(makeCandidate({ minor: 85_000 }).amount?.value.minor).toBe(85_000);
    expect(makeObservation().id).not.toBe(makeObservation().id);
  });
});
