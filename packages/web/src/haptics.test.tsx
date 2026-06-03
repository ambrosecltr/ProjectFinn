import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";

import { HapticSwitchOverlay } from "./haptics";

const webSrc = new URL("./", import.meta.url);

function readSource(path: string): string {
  return readFileSync(new URL(path, webSrc), "utf8");
}

describe("HapticSwitchOverlay", () => {
  test("renders a native switch overlay that can receive the real tap", () => {
    const html = renderToStaticMarkup(<HapticSwitchOverlay disabled />);

    expect(html).toContain('class="haptic-switch-overlay"');
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("switch");
    expect(html).toContain('tabindex="-1"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("disabled");
  });

  test("keeps native switch overlays out of Silk sheet content", () => {
    const sheetSources = [
      "components/ui/button.tsx",
      "connectors-sheet.tsx",
      "my-day-sheet.tsx",
      "patterns-sheet.tsx",
      "segmented-control.tsx",
      "settings-sheet.tsx",
      "sheet-shell.tsx",
    ];

    for (const path of sheetSources) {
      expect(readSource(path)).not.toContain("HapticSwitchOverlay");
    }
  });
});
