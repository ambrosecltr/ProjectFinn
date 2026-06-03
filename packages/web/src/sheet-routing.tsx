import type { ActiveSheet } from "./web-types";

export function normalizePathSheet(): ActiveSheet {
  if (window.location.pathname === "/my-day") return "my-day";
  if (window.location.pathname === "/patterns") return "patterns";
  if (window.location.pathname === "/library") return "library";
  if (window.location.pathname === "/connectors") return "connectors";
  if (window.location.pathname === "/onboarding") return "onboarding";
  return null;
}

export function appPathForSheet(sheet: ActiveSheet): string {
  if (sheet === "my-day") return "/my-day";
  if (sheet === "patterns") return "/patterns";
  if (sheet === "library") return "/library";
  if (sheet === "connectors") return "/connectors";
  if (sheet === "onboarding") return "/onboarding";
  return "/";
}
