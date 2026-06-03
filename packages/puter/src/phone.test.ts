import { describe, expect, test } from "bun:test";
import { formatPhoneForCountry, normalizePhoneForCountry } from "./phone";

describe("Puter phone input", () => {
  test("formats Australian mobile numbers as local input", () => {
    expect(formatPhoneForCountry("0412999234", "AU")).toBe("0412 999 234");
    expect(formatPhoneForCountry("+61412999234", "AU")).toBe("0412 999 234");
  });

  test("normalizes local Australian mobile input for auth", () => {
    expect(normalizePhoneForCountry("0412 999 234", "AU")).toBe("+61412999234");
  });
});
