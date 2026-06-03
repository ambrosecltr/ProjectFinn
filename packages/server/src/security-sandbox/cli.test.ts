import { describe, expect, it } from "bun:test";

import { parseIsolationSandboxArgs } from "./cli.js";

describe("isolation sandbox CLI", () => {
  it("parses interactive defaults and explicit corpus options", () => {
    expect(parseIsolationSandboxArgs([])).toEqual({
      mode: "interactive",
      profile: "worker-write",
      allProfiles: false,
      keep: false,
      help: false,
      listProfiles: false,
    });

    expect(parseIsolationSandboxArgs(["--profile", "pattern-management-read", "--corpus", "--keep"])).toEqual({
      mode: "corpus",
      profile: "pattern-management-read",
      allProfiles: false,
      keep: true,
      help: false,
      listProfiles: false,
    });

    expect(parseIsolationSandboxArgs(["--corpus", "--all-profiles"])).toEqual({
      mode: "corpus",
      profile: "worker-write",
      allProfiles: true,
      keep: false,
      help: false,
      listProfiles: false,
    });
  });

  it("rejects unknown profiles and flags", () => {
    expect(() => parseIsolationSandboxArgs(["--profile", "nope"])).toThrow("Unknown profile");
    expect(() => parseIsolationSandboxArgs(["--wat"])).toThrow("Unknown option");
  });
});
