import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const webSrc = new URL("./", import.meta.url);

function readSource(path: string): string {
  return readFileSync(new URL(path, webSrc), "utf8");
}

function cssBlock(source: string, selector: string): string {
  const start = source.indexOf(`${selector} {`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = source.indexOf("\n}", start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end + 2);
}

describe("web surface style tokens", () => {
  test("keeps todo and pattern stacks on the compact white list surface", () => {
    const styles = readSource("styles.css");
    const myDaySheet = readSource("my-day-sheet.tsx");
    const patternsSheet = readSource("patterns-sheet.tsx");
    const todoStack = cssBlock(styles, ".my-day-todo-stack");
    const todoCard = cssBlock(styles, ".my-day-todo-card");
    const patternList = cssBlock(styles, ".pattern-list");
    const automationCard = cssBlock(styles, ".automation-card");

    expect(myDaySheet).toContain("const TODO_STACK_RADIUS = 15;");
    expect(patternsSheet).toContain("const PATTERN_STACK_RADIUS = 15;");
    expect(myDaySheet).toContain('return radius.topLeft === 0 && radius.topRight === 0 ? "transparent" : "#f7f7f7";');
    expect(patternsSheet).toContain('return radius.topLeft === 0 && radius.topRight === 0 ? "transparent" : "#f7f7f7";');
    expect(todoStack).toContain("border-radius: 15px;");
    expect(todoCard).toContain("border: 1px solid #f7f7f7;");
    expect(todoCard).toContain("border-top-color: #f7f7f7;");
    expect(todoCard).toContain("background: #ffffff;");
    expect(patternList).toContain("border-radius: 15px;");
    expect(automationCard).toContain("border: 1px solid #f7f7f7;");
    expect(automationCard).toContain("border-top-color: #f7f7f7;");
    expect(automationCard).toContain("background: #ffffff;");
  });

  test("keeps collapsed list inner padding intentionally roomier", () => {
    const myDaySheet = readSource("my-day-sheet.tsx");
    const patternsSheet = readSource("patterns-sheet.tsx");

    expect(myDaySheet).toContain("const TODO_ROW_PADDING_OUTER = 18;");
    expect(myDaySheet).toContain("const TODO_ROW_PADDING_COMPACT = 22;");
    expect(patternsSheet).toContain("const PATTERN_PADDING_FULL = 25;");
    expect(patternsSheet).toContain("const PATTERN_PADDING_COMPACT = 18;");
  });

  test("keeps pattern copy and trigger pills at requested weights and fills", () => {
    const styles = readSource("styles.css");
    const automationTitle = cssBlock(styles, ".automation-title");
    const automationSummary = cssBlock(styles, ".automation-summary");
    const addTodoPill = cssBlock(styles, ".my-day-add-pill");
    const handoffCard = cssBlock(styles, ".my-day-handoff-card");
    const pillBlock = cssBlock(styles, ".automation-trigger,\n.automation-kind,\n.automation-status");
    const sheetRail = cssBlock(styles, ".sheet-segmented-control");
    const segmentedSheetRail = cssBlock(styles, ".segmented-control.sheet-segmented-control");

    expect(automationTitle).toContain("font-weight: 500;");
    expect(automationSummary).toContain("font-weight: 500;");
    expect(pillBlock).toContain("background: #f7f7f7;");
    expect(addTodoPill).toContain("background: #f7f7f7;");
    expect(handoffCard).toContain("background: #f7f7f7;");
    expect(sheetRail).toContain("background: #f7f7f7;");
    expect(segmentedSheetRail).toContain("background: #f7f7f7;");
  });

  test("uses native text decoration for completed todo strike-through", () => {
    const styles = readSource("styles.css");
    const myDaySheet = readSource("my-day-sheet.tsx");
    const staticTitle = cssBlock(styles, ".my-day-todo-title-static");

    expect(staticTitle).toContain("text-decoration-line: line-through;");
    expect(staticTitle).toContain("text-decoration-thickness: 1.5px;");
    expect(styles).not.toContain(".my-day-todo-strikethrough");
    expect(myDaySheet).not.toContain("TODO_STRIKE_TRANSITION");
    expect(myDaySheet).not.toContain("my-day-todo-strikethrough");
  });

  test("does not recess pattern card content on press", () => {
    const styles = readSource("styles.css");
    const automationMain = cssBlock(styles, ".automation-card-main");

    expect(automationMain).not.toContain("transition: transform");
    expect(automationMain).not.toContain("will-change: transform");
    expect(styles).not.toContain(".automation-card-main:active");
  });

  test("keeps page-load utilities out of lazy chunks", () => {
    const mainSource = readSource("main.tsx");

    expect(mainSource).toContain('from "./haptics"');
    expect(mainSource).toContain('from "./app-shell"');
    expect(mainSource).toContain('from "./app-environment"');
    expect(mainSource).not.toContain('import("./haptics")');
    expect(mainSource).not.toContain('import("./app-shell")');
    expect(mainSource).not.toContain('import("./app-environment")');
  });

  test("keeps the native haptic switch overlay hittable but visually hidden", () => {
    const styles = readSource("styles.css");
    const target = cssBlock(styles, ".haptic-switch-target");
    const overlay = cssBlock(styles, ".haptic-switch-overlay");

    expect(target).toContain("position: relative;");
    expect(overlay).toContain("position: absolute;");
    expect(overlay).toContain("inset: 0;");
    expect(overlay).toContain("opacity: 0.001;");
    expect(overlay).toContain("touch-action: pan-y;");
    expect(overlay).toContain("z-index: 5;");
  });
});
