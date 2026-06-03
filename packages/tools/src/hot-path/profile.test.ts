import { describe, expect, it, mock } from "bun:test";

import { createUpdateUserProfileTool } from "./profile.js";

const user = {
  tenantId: "tenant_test",
  userId: "usr_test",
  phoneNumber: "+15555555555",
  displayName: null,
  timezone: "UTC",
  timezoneSource: "server" as const,
  location: null,
  kidsMode: false,
};

describe("createUpdateUserProfileTool", () => {
  it("updates missing name and durable location", async () => {
    const updateProfile = mock(async () => ({
      ...user,
      displayName: "Max",
      location: "Brisbane, Australia",
    }));
    const profileTool = createUpdateUserProfileTool({ user: { ...user }, updateProfile });
    const execute = profileTool.execute as unknown as (input: {
      displayName?: string;
      location?: string;
      confidence: "explicit" | "high_confidence_inference";
    }, options: never) => Promise<unknown>;

    const result = await execute({ displayName: "Max", location: "Brisbane, Australia", confidence: "explicit" }, {} as never);

    expect(updateProfile).toHaveBeenCalledWith({ displayName: "Max", location: "Brisbane, Australia" });
    expect(result).toEqual({
      updated: true,
      fields: { displayName: true, location: true },
      skipped: [],
    });
  });

  it("does not overwrite an existing display name", async () => {
    const updateProfile = mock(async () => ({ ...user, displayName: "Existing", location: "Melbourne" }));
    const profileTool = createUpdateUserProfileTool({ user: { ...user, displayName: "Existing" }, updateProfile });
    const execute = profileTool.execute as unknown as (input: {
      displayName?: string;
      location?: string;
      confidence: "explicit" | "high_confidence_inference";
    }, options: never) => Promise<unknown>;

    const result = await execute({ displayName: "Max", confidence: "explicit" }, {} as never);

    expect(updateProfile).not.toHaveBeenCalled();
    expect(result).toEqual({ updated: false, skipped: ["displayName already set"] });
  });
});
