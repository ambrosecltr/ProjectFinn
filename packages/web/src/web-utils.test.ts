import { describe, expect, test } from "bun:test";

import { buildTextFinnHref } from "./web-utils";

describe("buildTextFinnHref", () => {
  test("uses the first SMS query parameter for a prefilled body", () => {
    expect(buildTextFinnHref("+1 (555) 555-0100", "Hey Finn")).toBe("sms:+15555550100?body=Hey%20Finn");
  });

  test("omits the query string when there is no body", () => {
    expect(buildTextFinnHref("+1 (555) 555-0100")).toBe("sms:+15555550100");
  });
});
