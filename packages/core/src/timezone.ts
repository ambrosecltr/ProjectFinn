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

const supportedTimeZones = new Set(getIntlSupportedTimeZones());

export function listSupportedTimeZones(): string[] {
  return [...supportedTimeZones].sort((left, right) => left.localeCompare(right));
}

export function isValidTimeZone(timeZone: string | null | undefined): boolean {
  if (!timeZone?.trim()) {
    return false;
  }

  return supportedTimeZones.has(timeZone.trim());
}

export function resolveTimeZone(timeZone: string | null | undefined, fallback = "UTC"): string {
  if (isValidTimeZone(timeZone)) {
    return timeZone!.trim();
  }

  if (isValidTimeZone(fallback)) {
    return fallback.trim();
  }

  return "UTC";
}

export function formatShortTimeZoneName(date: Date, timeZone: string, fallback: string): string {
  if (!fallback.startsWith("GMT")) {
    return fallback;
  }

  const longName = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    timeZoneName: "long",
  }).formatToParts(date).find((part) => part.type === "timeZoneName")?.value;
  const acronym = longName?.match(/\b[A-Z]/g)?.join("");
  return acronym && acronym !== "GMT" ? acronym : fallback;
}
