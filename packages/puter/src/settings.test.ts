import { describe, expect, test } from "bun:test";
import { greetingForDate } from "./state";

describe("Puter settings greeting", () => {
  test("uses the local morning greeting", () => {
    expect(greetingForDate(new Date(2026, 4, 30, 9))).toBe("Good morning");
  });

  test("uses the local afternoon greeting", () => {
    expect(greetingForDate(new Date(2026, 4, 30, 15))).toBe("Good afternoon");
  });

  test("uses the local evening greeting", () => {
    expect(greetingForDate(new Date(2026, 4, 30, 21))).toBe("Good evening");
  });
});
