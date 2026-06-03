import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

const webSrc = new URL("./", import.meta.url);

function readSource(path: string): string {
  return readFileSync(new URL(path, webSrc), "utf8");
}

describe("web module structure", () => {
  test("keeps dashboard and sheet views in focused modules", () => {
    expect(existsSync(new URL("dashboard.tsx", webSrc))).toBe(true);
    expect(existsSync(new URL("settings-sheet.tsx", webSrc))).toBe(true);
    expect(existsSync(new URL("library-sheet.tsx", webSrc))).toBe(true);
    expect(existsSync(new URL("patterns-sheet.tsx", webSrc))).toBe(true);
    expect(existsSync(new URL("connectors-sheet.tsx", webSrc))).toBe(true);
    expect(existsSync(new URL("onboarding-sheet.tsx", webSrc))).toBe(true);
    expect(existsSync(new URL("auth-screens.tsx", webSrc))).toBe(true);
    expect(existsSync(new URL("phone-utils.ts", webSrc))).toBe(true);
    expect(existsSync(new URL("demo-data.ts", webSrc))).toBe(true);
    expect(existsSync(new URL("sheet-shell.tsx", webSrc))).toBe(true);
    expect(existsSync(new URL("app-environment.tsx", webSrc))).toBe(true);
    expect(existsSync(new URL("timezone-sheet.tsx", webSrc))).toBe(true);
    expect(existsSync(new URL("haptics.tsx", webSrc))).toBe(true);
    expect(existsSync(new URL("sheet-routing.tsx", webSrc))).toBe(true);
    expect(existsSync(new URL("pattern-run-utils.ts", webSrc))).toBe(true);
    expect(existsSync(new URL("connector-disconnect-impact-card.tsx", webSrc))).toBe(true);
    expect(existsSync(new URL("app-shell.tsx", webSrc))).toBe(true);
    expect(existsSync(new URL("connector-config-utils.ts", webSrc))).toBe(true);
    expect(existsSync(new URL("web-api.tsx", webSrc))).toBe(true);

    const mainSource = readSource("main.tsx");
    expect(mainSource).toContain('from "./dashboard"');
    expect(mainSource).toContain('import("./settings-sheet")');
    expect(mainSource).toContain('import("./library-sheet")');
    expect(mainSource).toContain('import("./patterns-sheet")');
    expect(mainSource).toContain('import("./connectors-sheet")');
    expect(mainSource).toContain('import("./onboarding-sheet")');
    expect(mainSource).toContain('from "./auth-screens"');
    expect(mainSource).toContain('from "./demo-data"');
    expect(mainSource).toContain('from "./sheet-shell"');
    expect(mainSource).toContain('from "./app-environment"');
    expect(mainSource).toContain('import("./timezone-sheet")');
    expect(mainSource).toContain('from "./haptics"');
    expect(mainSource).toContain('from "./sheet-routing"');
    expect(mainSource).toContain('from "./pattern-run-utils"');
    expect(mainSource).toContain('from "./connector-disconnect-impact-card"');
    expect(mainSource).toContain('from "./app-shell"');
    expect(mainSource).toContain('from "./connector-config-utils"');
    expect(mainSource).toContain('from "./web-api"');

    const dashboardSource = readSource("dashboard.tsx");
    expect(dashboardSource).toContain("export function Dashboard");

    const settingsSource = readSource("settings-sheet.tsx");
    expect(settingsSource).toContain("export function SettingsSheet");

    const librarySource = readSource("library-sheet.tsx");
    expect(librarySource).toContain("export function LibrarySheet");

    const patternsSource = readSource("patterns-sheet.tsx");
    expect(patternsSource).toContain("export function PatternsSheet");

    const connectorsSource = readSource("connectors-sheet.tsx");
    expect(connectorsSource).toContain("export function ConnectorsSheet");

    const onboardingSource = readSource("onboarding-sheet.tsx");
    expect(onboardingSource).toContain("export function OnboardingSheet");

    const authSource = readSource("auth-screens.tsx");
    expect(authSource).toContain("export function LoginScreen");
    expect(authSource).toContain("export function VerifyScreen");
    expect(authSource).toContain("export function SignupHandoffScreen");

    const timeZoneSource = readSource("timezone-sheet.tsx");
    expect(timeZoneSource).toContain("export function TimeZoneSheet");

    const impactSource = readSource("connector-disconnect-impact-card.tsx");
    expect(impactSource).toContain("export function ConnectorDisconnectImpactCard");

    const appShellSource = readSource("app-shell.tsx");
    expect(appShellSource).toContain("export function AppBackground");
    expect(appShellSource).toContain("export function AuthTopBar");
  });
});
