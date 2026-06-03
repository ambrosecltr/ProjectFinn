import { describe, expect, test } from "bun:test";
import {
  accessStatusForSource,
  canTogglePersonalIntelligence,
  missingPermissionTargetsForSource,
  sourcesFromConnectorConfig,
} from "./state";
import type { AccessState, ConnectorConfig } from "./types";

const granted = { granted: true, message: "ready" };
const denied = { granted: false, message: "missing" };

describe("Puter settings state", () => {
  test("requires Messages and Contacts before iMessage can be toggled", () => {
    const access: AccessState = { imessage: granted, contacts: denied, notes: granted, accessibility: denied };

    expect(accessStatusForSource("imessage", access)).toEqual({ available: false, target: "contacts" });
    expect(missingPermissionTargetsForSource("imessage", access)).toEqual(["contacts"]);
  });

  test("allows Notes access when Notes permission is granted", () => {
    const access: AccessState = { imessage: denied, contacts: denied, notes: granted, accessibility: denied };

    expect(accessStatusForSource("notes", access)).toEqual({ available: true, target: null });
    expect(missingPermissionTargetsForSource("notes", access)).toEqual([]);
  });

  test("disables Personal Intelligence unless the source is enabled and authorized", () => {
    const access: AccessState = { imessage: granted, contacts: granted, notes: denied, accessibility: denied };
    const config: ConnectorConfig = {
      puter: {
        imessageEnabled: true,
        imessagePersonalIntelligenceEnabled: false,
        notesEnabled: false,
        notesPersonalIntelligenceEnabled: false,
      },
    };
    const sources = sourcesFromConnectorConfig(config);

    expect(canTogglePersonalIntelligence("imessage", sources, access)).toBe(true);
    expect(canTogglePersonalIntelligence("notes", sources, access)).toBe(false);
  });

  test("reflects live Puter source config updates", () => {
    const config: ConnectorConfig = {
      puter: {
        imessageEnabled: true,
        imessagePersonalIntelligenceEnabled: true,
        notesEnabled: false,
        notesPersonalIntelligenceEnabled: false,
      },
    };

    expect(sourcesFromConnectorConfig(config)).toEqual({
      imessage: { enabled: true, personalIntelligenceEnabled: true },
      notes: { enabled: false, personalIntelligenceEnabled: false },
    });
  });

  test("settings tabs expose stable route ids", async () => {
    const settings = await import("./settings-tabs");

    expect(settings.settingsTabs.map((tab) => tab.id)).toEqual(["access", "personal_intelligence", "permissions"]);
  });
});
