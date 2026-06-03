import { describe, expect, it } from "bun:test";
import { titleCaseStatus } from "./connector-status";

describe("titleCaseStatus", () => {
  it("formats uppercase provider statuses as normal title case", () => {
    expect(titleCaseStatus("ACTIVE", true)).toBe("Active");
  });

  it("formats separator-delimited statuses for display", () => {
    expect(titleCaseStatus("needs_reconnect", true)).toBe("Needs Reconnect");
    expect(titleCaseStatus("pending-auth", true)).toBe("Pending Auth");
  });

  it("uses stable fallback labels for missing connection state", () => {
    expect(titleCaseStatus(undefined, true)).toBe("Connected");
    expect(titleCaseStatus("   ", true)).toBe("Connected");
    expect(titleCaseStatus("ACTIVE", false)).toBe("Not connected");
  });
});
