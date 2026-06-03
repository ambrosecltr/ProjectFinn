function getIntlSupportedTimeZones(): string[] {
  const supportedValuesOf = Intl.supportedValuesOf as ((key: "timeZone") => string[]) | undefined;
  if (typeof supportedValuesOf !== "function") {
    return ["UTC"];
  }

  try {
    const values = supportedValuesOf.call(Intl, "timeZone");
    return values.length ? values : ["UTC"];
  } catch {
    return ["UTC"];
  }
}

const supportedTimeZones = getIntlSupportedTimeZones().sort((left, right) => left.localeCompare(right));
const supportedTimeZoneSet = new Set(supportedTimeZones);

export function listSupportedTimeZones(): string[] {
  return supportedTimeZones;
}

export function isSupportedTimeZone(timeZone: string | null | undefined): boolean {
  if (!timeZone?.trim()) {
    return false;
  }

  return supportedTimeZoneSet.has(timeZone.trim());
}

export function resolveBrowserTimeZone(timeZone: string | undefined): string {
  const browserTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  if (isSupportedTimeZone(timeZone)) {
    return timeZone!.trim();
  }

  if (isSupportedTimeZone(browserTimeZone)) {
    return browserTimeZone;
  }

  return "UTC";
}

export function formatTimeZoneLabel(timeZone: string): string {
  return timeZone
    .split("/")
    .map((part) => part.replace(/_/g, " "))
    .join(" / ");
}

export function getTimeZoneKeywords(timeZone: string): string[] {
  return [
    timeZone,
    timeZone.replace(/\//g, " "),
    timeZone.replace(/_/g, " "),
    timeZone.replace(/[\/_]/g, " "),
    formatTimeZoneLabel(timeZone),
  ];
}
