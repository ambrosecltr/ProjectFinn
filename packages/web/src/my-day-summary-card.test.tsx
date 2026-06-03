import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { MyDaySummaryCard } from "./my-day-summary-card";

describe("MyDaySummaryCard", () => {
  test("uses singular task copy", () => {
    const html = renderToStaticMarkup(
      <MyDaySummaryCard taskCount={1} summary="One thing is waiting." lastRefreshedAt={null} />,
    );

    expect(html).toContain("You have 1 task that needs your attention today.");
  });

  test("uses plural task copy", () => {
    const html = renderToStaticMarkup(
      <MyDaySummaryCard taskCount={3} summary="A few things are waiting." lastRefreshedAt={null} />,
    );

    expect(html).toContain("You have 3 tasks that need your attention today.");
  });
});
