export type PuterSourceKey = "imessage" | "notes";

export const puterToolkitSlug = "puter";
export const puterToolkitName = "Puter";
export const puterPersonalIntelligenceAccountScopeId = "puter:local";
export const puterSourceTools = {
  imessage: "puter.imessage",
  notes: "puter.notes",
} as const satisfies Record<PuterSourceKey, string>;

export const puterPersonalIntelligenceTools = {
  imessage: "puter.imessage.personal_intelligence",
  notes: "puter.notes.personal_intelligence",
} as const satisfies Record<PuterSourceKey, string>;

export const puterEnabledToolsetSlugs = new Set<string>(Object.values(puterSourceTools));
export const puterPersonalIntelligenceToolSlugs = new Set<string>(Object.values(puterPersonalIntelligenceTools));

export interface PuterPermissionStatus {
  granted: boolean;
  message: string;
}

export interface PuterLocalAccessStatus {
  imessage?: PuterPermissionStatus;
  contacts?: PuterPermissionStatus;
  notes?: PuterPermissionStatus;
  updatedAt?: string;
}

export interface PuterSourceAvailability {
  available: boolean;
  message: string;
  missingAccess: Array<keyof Omit<PuterLocalAccessStatus, "updatedAt">>;
}

export function puterToolsetForPersonalIntelligenceMarker(marker: string): string | null {
  if (marker === puterPersonalIntelligenceTools.imessage) {
    return puterSourceTools.imessage;
  }
  if (marker === puterPersonalIntelligenceTools.notes) {
    return puterSourceTools.notes;
  }
  return null;
}

export function puterDeviceIdFromConnectedAccount(connectedAccountId: string | null | undefined): string | null {
  const prefix = `${puterToolkitSlug}:`;
  return connectedAccountId?.startsWith(prefix) ? connectedAccountId.slice(prefix.length) : null;
}

export function puterSourceForToolset(toolset: string): PuterSourceKey | null {
  if (toolset === puterSourceTools.imessage) {
    return "imessage";
  }
  if (toolset === puterSourceTools.notes) {
    return "notes";
  }
  return null;
}

export function puterPersonalIntelligenceMarkerForToolset(toolset: string): string | null {
  if (toolset === puterSourceTools.imessage) {
    return puterPersonalIntelligenceTools.imessage;
  }
  if (toolset === puterSourceTools.notes) {
    return puterPersonalIntelligenceTools.notes;
  }
  return null;
}

export function getPuterSourceAvailability(access: PuterLocalAccessStatus | undefined, source: PuterSourceKey): PuterSourceAvailability {
  const missingAccess: PuterSourceAvailability["missingAccess"] = [];
  if (source === "imessage") {
    if (access?.imessage?.granted !== true) {
      missingAccess.push("imessage");
    }
    if (access?.contacts?.granted !== true) {
      missingAccess.push("contacts");
    }
  } else if (access?.notes?.granted !== true) {
    missingAccess.push("notes");
  }

  if (missingAccess.length === 0) {
    return {
      available: true,
      message: `${source === "imessage" ? "iMessage" : "Notes"} access is ready.`,
      missingAccess,
    };
  }

  return {
    available: false,
    message: formatPuterMissingAccessMessage(missingAccess),
    missingAccess,
  };
}

function formatPuterMissingAccessMessage(missingAccess: PuterSourceAvailability["missingAccess"]): string {
  const labels = missingAccess.map((scope) => {
    if (scope === "contacts") {
      return "Contacts access";
    }
    return "Full Disk Access";
  });
  const uniqueLabels = [...new Set(labels)];
  if (uniqueLabels.length === 0) {
    return "Local access needs attention in Finn Puter.";
  }
  return `${uniqueLabels.join(" and ")} ${uniqueLabels.length === 1 ? "is" : "are"} required in Finn Puter.`;
}

export function filterAvailablePuterToolsets(toolsets: Iterable<string>, access: PuterLocalAccessStatus | undefined): Set<string> {
  const available = new Set<string>();
  for (const toolset of toolsets) {
    const source = puterSourceForToolset(toolset);
    if (source && getPuterSourceAvailability(access, source).available) {
      available.add(toolset);
    }
  }
  return available;
}

export function getUnavailablePuterToolsetMessage(toolset: string, access: PuterLocalAccessStatus | undefined): string | null {
  const source = puterSourceForToolset(toolset);
  if (!source) {
    return null;
  }

  const availability = getPuterSourceAvailability(access, source);
  return availability.available ? null : availability.message;
}

export function puterPersonalIntelligenceMarkersForToolsets(toolsets: Iterable<string>): string[] {
  const markers = new Set<string>();
  for (const toolset of toolsets) {
    const marker = puterPersonalIntelligenceMarkerForToolset(toolset);
    if (marker) {
      markers.add(marker);
    }
  }
  return [...markers];
}
