import type { ConnectorConfig } from "./web-types";

export function puterPatchMatchesConfig(
  patch: Partial<NonNullable<ConnectorConfig["puter"]>> | undefined,
  config: ConnectorConfig,
): boolean {
  if (!patch) {
    return true;
  }

  const puter = config.puter;
  if (!puter) {
    return false;
  }

  return Object.entries(patch)
    .filter((entry): entry is [keyof NonNullable<ConnectorConfig["puter"]>, boolean] => typeof entry[1] === "boolean")
    .every(([key, value]) => puter[key] === value);
}
