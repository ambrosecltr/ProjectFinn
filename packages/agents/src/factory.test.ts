import { describe, expect, it } from "bun:test";

import { buildHotPathIdentityFiles } from "./factory.js";

const baseConfig = {
  capabilities: {
    integrations: {
      memory: false,
    },
    media: {
      fileStorage: true,
      textToSpeech: false,
      voiceRoundTrip: false,
    },
    tools: {
      hotPath: {
        send_message: true,
        send_media: true,
        react: true,
        wait: true,
        display_draft: true,
        patterns: true,
        my_day: true,
        files: true,
        search_memory: false,
        reflect_memory: false,
      },
      worker: {
        web_search: false,
        get_page_contents: false,
        composio: false,
        create_or_edit_image: false,
        create_or_edit_video: false,
        mcp: false,
        patterns: false,
        memory: false,
        skills: false,
      },
    },
  },
};

const baseUser = {
  tenantId: "tenant_default",
  userId: "usr_test",
  phoneNumber: "+15555555555",
  displayName: "Test User",
  timezone: "UTC",
  timezoneSource: "server" as const,
  location: null,
  kidsMode: false,
};

describe("buildHotPathIdentityFiles", () => {
  it("uses the default identity and hot-path prompts for adult mode", () => {
    const identity = buildHotPathIdentityFiles({ config: baseConfig as never, user: baseUser });

    expect(identity.finn).toContain("<finn>");
    expect(identity.finn).toContain("<hot_path>");
    expect(identity.finn).toContain("call send_message, delegate, and finish_turn together");
    expect(identity.finn).toContain("use delegate with worker_id for a direct follow-up");
    expect(identity.finn).toContain("workspace_search");
    expect(identity.finn).toContain("finn.files");
    expect(identity.finn).toContain("do not mark done just because a worker finished");
    expect(identity.finn).toContain("<file_context>");
    expect(identity.finn).toContain("<patterns_scheduling_reminders>");
    expect(identity.finn).toContain("<my_day_todos>");
    expect(identity.finn).not.toContain("<reminder_pattern_routing>");
    expect(identity.finn).not.toContain("## file context");
    expect(identity.finn).not.toContain("## reminder and Pattern routing");
    expect(identity.finn).not.toContain("## My Day and todos");
    expect(identity.finn).not.toContain("# Finn Kids Mode");
    expect(identity.finn).not.toContain("# kids hot path");
    expect(identity.finn).not.toContain("search_memory");
    expect(identity.finn).not.toContain("reflect_memory");
    expect(identity.finn).not.toContain("memory recall");
    expect("user" in identity).toBe(false);
  });

  it("omits My Day todo guidance when My Day tools are disabled", () => {
    const config = {
      ...baseConfig,
      capabilities: {
        ...baseConfig.capabilities,
        tools: {
          ...baseConfig.capabilities.tools,
          hotPath: {
            ...baseConfig.capabilities.tools.hotPath,
            my_day: false,
          },
        },
      },
    } as never;
    const identity = buildHotPathIdentityFiles({ config, user: baseUser });

    expect(identity.finn).not.toContain("<my_day_todos>");
    expect(identity.finn).not.toContain("My Day and todos");
    expect(identity.finn).not.toContain("My Day todo tools");
  });

  it("keeps native Pattern and reminder guidance when hot-path Pattern tools are disabled", () => {
    const config = {
      ...baseConfig,
      capabilities: {
        ...baseConfig.capabilities,
        tools: {
          ...baseConfig.capabilities.tools,
          hotPath: {
            ...baseConfig.capabilities.tools.hotPath,
            patterns: false,
          },
        },
      },
    } as never;
    // Pattern scheduling guidance is core hot-path routing; this flag only hides optional direct Pattern tools.
    const identity = buildHotPathIdentityFiles({ config, user: baseUser });

    expect(identity.finn).toContain("<patterns_scheduling_reminders>");
    expect(identity.finn).toContain("create_reminder");
    expect(identity.finn).toContain("list_active_patterns");
    expect(identity.finn).not.toContain("<reminder_pattern_routing>");
  });

  it("adds memory recall guidance only when memory capabilities are enabled", () => {
    const config = {
      capabilities: {
        media: {
          fileStorage: true,
          textToSpeech: false,
          voiceRoundTrip: false,
        },
        integrations: {
          memory: true,
        },
        tools: {
          hotPath: {
            send_message: true,
            send_media: true,
            react: true,
            wait: true,
            display_draft: true,
            patterns: true,
            my_day: true,
            files: true,
            search_memory: true,
            reflect_memory: true,
          },
          worker: {
            web_search: false,
            get_page_contents: false,
            composio: false,
            create_or_edit_image: false,
            create_or_edit_video: false,
            mcp: false,
            patterns: false,
            memory: true,
            skills: false,
          },
        },
      },
    } as never;
    const identity = buildHotPathIdentityFiles({ config, user: baseUser });

    expect(identity.finn).toContain("search_memory");
    expect(identity.finn).toContain("reflect_memory");
    expect(identity.finn).toContain("<memory_requirements>");
    expect(identity.finn).not.toContain("## memory requirements");
    expect(identity.finn).toContain("Strong default");
    expect(identity.finn).toContain("Before making a specific claim about core user information");
    expect(identity.finn).toContain("call `search_memory` first");
    expect(identity.finn).toContain("Auto-injected memory context may also appear");
  });

  it("adds context-only memory guidance without tool names", () => {
    const config = {
      capabilities: {
        media: {
          fileStorage: true,
          textToSpeech: false,
          voiceRoundTrip: false,
        },
        integrations: {
          memory: true,
        },
        tools: {
          hotPath: {
            send_message: true,
            send_media: true,
            react: true,
            wait: true,
            display_draft: true,
            patterns: true,
            my_day: true,
            files: true,
            search_memory: false,
            reflect_memory: false,
          },
          worker: {
            web_search: false,
            get_page_contents: false,
            composio: false,
            create_or_edit_image: false,
            create_or_edit_video: false,
            mcp: false,
            patterns: false,
            memory: true,
            skills: false,
          },
        },
      },
    } as never;

    const identity = buildHotPathIdentityFiles({ config, user: baseUser });

    expect(identity.finn).toContain("Auto-injected memory context may include");
    expect(identity.finn).toContain("Core user information must stay grounded");
    expect(identity.finn).toContain("<memory_context>");
    expect(identity.finn).not.toContain("## memory context");
    expect(identity.finn).not.toContain("`search_memory`");
    expect(identity.finn).not.toContain("`reflect_memory`");
  });

  it("uses kid-safe identity and hot-path prompts for kids mode", () => {
    const identity = buildHotPathIdentityFiles({ config: baseConfig as never, user: { ...baseUser, kidsMode: true } });

    expect(identity.finn).toContain("a personal intelligence that lives in iMessage for a kid or teen");
    expect(identity.finn).toContain("<kids_guardrails");
    expect(identity.finn).toContain("trusted adults");
    expect(identity.finn).toContain("send_message, delegate, and finish_turn together");
    expect(identity.finn).not.toContain("lean best-friend");
    expect("user" in identity).toBe(false);
  });
});
