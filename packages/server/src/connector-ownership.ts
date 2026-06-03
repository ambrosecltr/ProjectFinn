import type { UserConnectorConfig } from "@finn/db";
import { puterToolkitSlug } from "./puter-connector.js";

const projectOwnedConnectorSlugs = new Set<string>([puterToolkitSlug]);

export function isProjectOwnedConnectorSlug(slug: string): boolean {
  return projectOwnedConnectorSlugs.has(slug);
}

export function isComposioManagedConnectorSlug(slug: string): boolean {
  return !isProjectOwnedConnectorSlug(slug);
}

export function filterComposioConnectorConfigs(configs: UserConnectorConfig[]): UserConnectorConfig[] {
  return configs.filter((config) => isComposioManagedConnectorSlug(config.toolkitSlug));
}
