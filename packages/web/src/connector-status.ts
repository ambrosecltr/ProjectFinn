export function titleCaseStatus(value: string | undefined, connected: boolean): string {
  if (!connected) return "Not connected";
  const normalized = value?.replace(/\s+/g, " ").trim();
  if (!normalized) return "Connected";

  return normalized
    .toLowerCase()
    .replace(/[-_]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\p{L}/gu, (letter) => letter.toUpperCase());
}
