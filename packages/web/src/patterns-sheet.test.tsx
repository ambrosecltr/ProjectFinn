import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { PatternActivitySheet } from "./patterns-sheet";
import type { Pattern, PatternRun } from "./web-types";

const pattern: Pattern = {
  id: "pat_123",
  name: "Morning brief",
  description: null,
  userDescription: "Summarize the morning",
  triggerType: "schedule",
  triggerConfig: { type: "schedule", schedule: { kind: "daily", time: "08:00" }, timezoneSource: "user" },
  connectorScope: { composio: [], mcpServerIds: [] },
  triggerFilters: [],
  notifyCondition: { type: "always" },
  taskPrompt: "Summarize the morning.",
  reminderContext: null,
  workerType: "general",
  timezone: "UTC",
  active: true,
  failureCount: 0,
  lastRunAt: "2026-05-28T08:00:00.000Z",
  nextRunAt: "2026-05-29T08:00:00.000Z",
  createdAt: "2026-05-01T08:00:00.000Z",
  updatedAt: "2026-05-28T08:00:00.000Z",
};

const run: PatternRun = {
  id: "run_123",
  patternId: pattern.id,
  triggeredBy: "schedule",
  state: "done",
  result: { summary: "Sent the brief." },
  error: null,
  skipReason: null,
  notifyOutcome: { notify: true, summary: "Brief sent." },
  surfacedAt: "2026-05-28T08:01:00.000Z",
  createdAt: "2026-05-28T08:00:00.000Z",
  completedAt: "2026-05-28T08:01:00.000Z",
};

describe("PatternActivitySheet", () => {
  test("renders run details open by default", () => {
    const html = renderToStaticMarkup(
      <PatternActivitySheet
        pattern={pattern}
        runs={[run]}
        loading={false}
        onClose={() => {}}
        StandaloneSheetComponent={({ children }) => <section>{children}</section>}
      />,
    );

    expect(html).toContain("pattern-run-frame open");
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('aria-hidden="false"');
  });
});
