import { describe, expect, it } from "bun:test";
import { buildCheckpointKey, normalizeCheckpointScope } from "./personal-intelligence-checkpoint-store.js";
import { buildPersonalIntelligenceSourceHash, buildPersonalIntelligenceSourceValues } from "./personal-intelligence-source-store.js";

const owner = { tenantId: "tenant_123", userId: "usr_123" };

describe("PersonalIntelligenceSourceStore helpers", () => {
  it("builds stable source hashes from normalized source identity", () => {
    const first = buildPersonalIntelligenceSourceHash({
      ...owner,
      toolkitSlug: "Gmail",
      accountScopeId: " gmail:email:user@example.com ",
      connectedAccountId: "acct_123",
      sourceType: "Email",
      sourceId: "MSG_123",
    });
    const second = buildPersonalIntelligenceSourceHash({
      ...owner,
      toolkitSlug: "gmail",
      accountScopeId: "gmail:email:user@example.com",
      connectedAccountId: "acct_123",
      sourceType: "email",
      sourceId: "MSG_123",
    });
    const different = buildPersonalIntelligenceSourceHash({
      ...owner,
      toolkitSlug: "gmail",
      accountScopeId: "gmail:email:user@example.com",
      connectedAccountId: "acct_123",
      sourceType: "email",
      sourceId: "MSG_456",
    });

    expect(first).toBe(second);
    expect(first).not.toBe(different);
  });

  it("normalizes values before ledger insert", () => {
    const now = new Date("2026-05-15T04:00:00.000Z");
    const values = buildPersonalIntelligenceSourceValues({
      owner,
      now,
      params: {
        runId: "arun_123",
        toolkitSlug: " Gmail ",
        accountScopeId: " gmail:email:user@example.com ",
        connectedAccountId: " acct_123 ",
        sourceType: " Email ",
        sourceId: " msg_123 ",
        retainedDocumentId: "doc_123",
        title: "  Lease renewal  ",
        sourceUrl: "  https://mail.example/msg_123  ",
        sourceTimestamp: "2026-05-12T12:00:00.000Z",
        metadata: { label: "INBOX" },
      },
    });

    expect(values).toEqual(expect.objectContaining({
      tenantId: owner.tenantId,
      userId: owner.userId,
      runId: "arun_123",
      toolkitSlug: "gmail",
      accountScopeId: "gmail:email:user@example.com",
      connectedAccountId: "acct_123",
      sourceType: "email",
      sourceId: "msg_123",
      retainedDocumentId: "doc_123",
      title: "Lease renewal",
      sourceUrl: "https://mail.example/msg_123",
      sourceTimestamp: new Date("2026-05-12T12:00:00.000Z"),
      metadata: { label: "INBOX" },
      createdAt: now,
      updatedAt: now,
    }));
  });
});

describe("PersonalIntelligenceCheckpointStore helpers", () => {
  it("normalizes connector-agnostic checkpoint scopes", () => {
    expect(normalizeCheckpointScope({
      toolkitSlug: " Gmail ",
      accountScopeId: " gmail:email:user@example.com ",
      connectedAccountId: " acct_123 ",
      sourceType: " Records ",
    })).toEqual({
      toolkitSlug: "gmail",
      accountScopeId: "gmail:email:user@example.com",
      connectedAccountId: "acct_123",
      sourceType: "records",
    });
  });

  it("builds stable checkpoint keys", () => {
    expect(buildCheckpointKey({
      toolkitSlug: "Gmail",
      accountScopeId: "gmail:email:user@example.com",
      connectedAccountId: "acct_123",
      sourceType: "Records",
    })).toBe("gmail:gmail:email:user@example.com:records");
  });

  it("rejects non-Puter checkpoint scopes without canonical account scope", () => {
    // Runtime guard covers malformed checkpoint scopes received at trust boundaries.
    // @ts-expect-error intentionally omits required accountScopeId.
    expect(() => normalizeCheckpointScope({
      toolkitSlug: "gmail",
      connectedAccountId: "acct_123",
      sourceType: "records",
    })).toThrow("requires an account scope");
  });
});
