import { describe, expect, test } from "bun:test";
import { applyActivityEvent, shouldHideActivity, type ActivityViewState } from "./activity";

describe("Puter command activity notification state", () => {
  test("keeps notification visible during the hide grace period", () => {
    const started = applyActivityEvent(emptyState(), { active: true, message: "Finn is reading your iMessages..." }, 1_000);
    const stopped = applyActivityEvent(started, { active: false, message: "" }, 2_000);

    expect(stopped.visible).toBe(true);
    expect(shouldHideActivity(stopped, 9_999)).toBe(false);
    expect(shouldHideActivity(stopped, 10_000)).toBe(true);
  });

  test("updates text without hiding when a new command starts during grace period", () => {
    const first = applyActivityEvent(emptyState(), { active: true, message: "Finn is reading your iMessages..." }, 1_000);
    const grace = applyActivityEvent(first, { active: false, message: "" }, 2_000);
    const second = applyActivityEvent(grace, { active: true, message: "Finn is reading your Notes..." }, 4_000);

    expect(second.visible).toBe(true);
    expect(second.message).toBe("Finn is reading your Notes...");
    expect(second.hideAfter).toBeNull();
  });

  test("shows grace state when the active event was missed", () => {
    const stopped = applyActivityEvent(emptyState(), {
      active: false,
      message: "Finn is reading your iMessages...",
      generation: 2,
    }, 2_000);

    expect(stopped.visible).toBe(true);
    expect(stopped.active).toBe(false);
    expect(stopped.message).toBe("Finn is reading your iMessages...");
    expect(shouldHideActivity(stopped, 9_999)).toBe(false);
    expect(shouldHideActivity(stopped, 10_000)).toBe(true);
  });

  test("ignores stale retried activity events", () => {
    const started = applyActivityEvent(emptyState(), {
      active: true,
      message: "Finn is reading your iMessages...",
      generation: 2,
    }, 1_000);
    const stopped = applyActivityEvent(started, {
      active: false,
      message: "Finn is reading your iMessages...",
      generation: 3,
    }, 2_000);
    const stale = applyActivityEvent(stopped, {
      active: true,
      message: "Finn is reading your iMessages...",
      generation: 2,
    }, 2_100);

    expect(stale).toEqual(stopped);
  });
});

function emptyState(): ActivityViewState {
  return {
    visible: false,
    active: false,
    message: "",
    hideAfter: null,
    lastChangedAt: 0,
    generation: 0,
  };
}
