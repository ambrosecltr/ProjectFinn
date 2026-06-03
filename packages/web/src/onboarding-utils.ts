import type { Connector, UserProfile } from "./web-types";
import { capitalizeFirst } from "./web-utils";

export type OnboardingStep = "welcome" | "name" | "location" | "connect" | "finish";

export const onboardingSteps = ["welcome", "name", "location", "connect", "finish"] as const satisfies readonly OnboardingStep[];

export function connectorNameForSlug(slug: string): string {
  if (slug === "gmail") return "Gmail";
  if (slug === "outlook") return "Outlook";
  return capitalizeFirst(slug.replace(/[-_]/g, " "));
}

export function getOnboardingConnectorSlugs(user: UserProfile): string[] {
  return user.onboarding.requiredConnectorSlugs.length > 0
    ? user.onboarding.requiredConnectorSlugs
    : ["gmail", "outlook"];
}

function getOnboardingMailConnectors(user: UserProfile, connectors: Connector[]): Connector[] {
  const requiredSlugs = new Set(getOnboardingConnectorSlugs(user));
  return connectors.filter((connector) => requiredSlugs.has(connector.slug));
}

function hasOnboardingMailConnection(user: UserProfile, connectors: Connector[]): boolean {
  return getOnboardingMailConnectors(user, connectors).some((connector) => connector.connected);
}

export function getInitialOnboardingStep(user: UserProfile, connectors: Connector[], pendingConnectorAuth: boolean): OnboardingStep {
  if (pendingConnectorAuth) return "connect";
  if (!user.displayName.trim()) return "welcome";
  if (!user.location.trim()) return "location";
  if (connectors.length === 0) return "connect";
  const mailConnectors = getOnboardingMailConnectors(user, connectors);
  if (mailConnectors.length > 0 && !hasOnboardingMailConnection(user, connectors)) return "connect";
  return "finish";
}
