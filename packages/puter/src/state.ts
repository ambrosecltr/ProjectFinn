import type {
  AccessScope,
  AccessState,
  ConnectorConfig,
  PermissionCheck,
  PermissionTarget,
  SourceKey,
  SourceState,
} from "./types";

export const emptySources: Record<SourceKey, SourceState> = {
  imessage: { enabled: false, personalIntelligenceEnabled: false },
  notes: { enabled: false, personalIntelligenceEnabled: false },
};

export const emptyAccess: AccessState = {
  imessage: null,
  contacts: null,
  notes: null,
  accessibility: null,
};

export const allAccessScopes: AccessScope[] = ["imessage", "contacts", "notes", "accessibility"];
export const onboardingAccessScopes: AccessScope[] = ["imessage", "contacts", "notes"];

export function permissionGranted(permission: AccessState[AccessScope]): boolean {
  return permission?.granted ?? false;
}

export function sourceFromConnectorConfig(config: ConnectorConfig, source: SourceKey): SourceState {
  const puter = config.puter;
  if (source === "imessage") {
    return {
      enabled: puter?.imessageEnabled ?? false,
      personalIntelligenceEnabled: puter?.imessagePersonalIntelligenceEnabled ?? false,
    };
  }

  return {
    enabled: puter?.notesEnabled ?? false,
    personalIntelligenceEnabled: puter?.notesPersonalIntelligenceEnabled ?? false,
  };
}

export function sourcesFromConnectorConfig(config: ConnectorConfig): Record<SourceKey, SourceState> {
  return {
    imessage: sourceFromConnectorConfig(config, "imessage"),
    notes: sourceFromConnectorConfig(config, "notes"),
  };
}

export function missingPermissionTargetsForSource(source: SourceKey, access: AccessState): PermissionTarget[] {
  if (source === "imessage") {
    const missing: PermissionTarget[] = [];
    if (!permissionGranted(access.imessage)) {
      missing.push("full_disk");
    }
    if (!permissionGranted(access.contacts)) {
      missing.push("contacts");
    }
    return missing;
  }

  return permissionGranted(access.notes) ? [] : ["full_disk"];
}

export function accessStatusForSource(source: SourceKey, access: AccessState): { available: boolean; target: PermissionTarget | null } {
  const missing = missingPermissionTargetsForSource(source, access);
  return {
    available: missing.length === 0,
    target: missing[0] ?? null,
  };
}

export function canTogglePersonalIntelligence(
  source: SourceKey,
  sources: Record<SourceKey, SourceState>,
  access: AccessState,
): boolean {
  return sources[source].enabled && accessStatusForSource(source, access).available;
}

export function mergeAccess(access: AccessState, scope: AccessScope, result: PermissionCheck): AccessState {
  return {
    ...access,
    [scope]: result,
  };
}

export function greetingForDate(date: Date): string {
  const hour = date.getHours();
  if (hour >= 5 && hour < 12) {
    return "Good morning";
  }
  if (hour >= 12 && hour < 17) {
    return "Good afternoon";
  }
  return "Good evening";
}
