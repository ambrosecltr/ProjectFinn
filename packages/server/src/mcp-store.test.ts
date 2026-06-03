import { describe, expect, it } from "bun:test";

import { McpServerStore } from "./mcp-store.js";

const user = { tenantId: "tenant_test", userId: "usr_test" };

function createInsertDb() {
  let inserted: Record<string, unknown> | null = null;
  return {
    db: {
      insert: () => ({
        values: (value: Record<string, unknown>) => {
          inserted = value;
          return { returning: async () => [value] };
        },
      }),
    } as never,
    get inserted() {
      return inserted;
    },
  };
}

describe("McpServerStore", () => {
  it("does not persist API-key transport headers", async () => {
    const db = createInsertDb();
    const store = new McpServerStore(db.db, { getUserRoot: async () => "/tmp/finn-test" });

    await store.createForUser(user, {
      name: "private mcp",
      metadata: { auth: { type: "api_key" } },
      transport: {
        type: "http",
        url: "https://mcp.example.com",
        headers: {
          "x-api-key": "secret",
          accept: "application/json",
        },
      },
    });

    expect(db.inserted?.transport).toEqual({
      type: "http",
      url: "https://mcp.example.com",
    });
  });

  it("strips secret-like legacy headers without dropping ordinary headers", async () => {
    const db = createInsertDb();
    const store = new McpServerStore(db.db, { getUserRoot: async () => "/tmp/finn-test" });

    await store.createForUser(user, {
      name: "legacy mcp",
      transport: {
        type: "sse",
        url: "https://mcp.example.com/sse",
        headers: {
          authorization: "Bearer secret",
          "x-api-key": "secret",
          accept: "text/event-stream",
        },
      },
    });

    expect(db.inserted?.transport).toEqual({
      type: "sse",
      url: "https://mcp.example.com/sse",
      headers: {
        accept: "text/event-stream",
      },
    });
  });
});
