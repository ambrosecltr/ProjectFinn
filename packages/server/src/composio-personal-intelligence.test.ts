import { describe, expect, it } from "bun:test";
import { isComposioPersonalIntelligenceToolkitSupported, resolveComposioPersonalIntelligenceIdentity } from "./composio-personal-intelligence.js";

describe("Composio Personal Intelligence identity resolvers", () => {
  it("maps Gmail reconnects for the same mailbox to one durable scope", async () => {
    const composio = {
      executeToolForConnectedAccount: async () => ({ data: { emailAddress: "User@Example.com", historyId: "123" } }),
    };

    const first = await resolveComposioPersonalIntelligenceIdentity({
      composio: composio as never,
      composioUserId: "tenant_usr",
      toolkitSlug: "gmail",
      connectedAccountId: "acct_old",
    });
    const second = await resolveComposioPersonalIntelligenceIdentity({
      composio: composio as never,
      composioUserId: "tenant_usr",
      toolkitSlug: "gmail",
      connectedAccountId: "acct_new",
    });

    expect(first.accountScopeId).toBe("gmail:email:user@example.com");
    expect(second.accountScopeId).toBe(first.accountScopeId);
    expect(second.currentConnectedAccountId).toBe("acct_new");
  });

  it("keeps different Gmail mailboxes isolated", async () => {
    const resolve = (email: string) => resolveComposioPersonalIntelligenceIdentity({
      composio: { executeToolForConnectedAccount: async () => ({ emailAddress: email }) } as never,
      composioUserId: "tenant_usr",
      toolkitSlug: "gmail",
      connectedAccountId: `acct_${email}`,
    });

    await expect(resolve("user@example.com")).resolves.toMatchObject({ accountScopeId: "gmail:email:user@example.com" });
    await expect(resolve("other@example.com")).resolves.toMatchObject({ accountScopeId: "gmail:email:other@example.com" });
  });

  it("does not mark arbitrary Composio toolkits as PI supported", () => {
    expect(isComposioPersonalIntelligenceToolkitSupported("gmail")).toBe(true);
    expect(isComposioPersonalIntelligenceToolkitSupported("todoist")).toBe(false);
  });
});
