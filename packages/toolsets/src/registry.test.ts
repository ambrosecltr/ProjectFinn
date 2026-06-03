import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { createToolsetRuntime } from "./registry.js";
import { createSkillsToolsetDefinition } from "./toolsets/skills/index.js";
import type { PuterToolsetRecord } from "./types.js";

const records: PuterToolsetRecord[] = [
  {
    sourceType: "imessage",
    sourceId: "msg_3",
    messageId: "msg_3",
    threadId: "thread_project",
    sender: "+15550000003",
    senderContact: { handle: "+15550000003", displayName: "Mina Example" },
    recipients: ["user@example.com"],
    title: "Project Atlas",
    timestamp: "2026-05-16T12:00:00.000Z",
    content: "Project Atlas launch review is with Mina.",
    attachments: [{
      attachmentId: 7,
      filename: "pizza.png",
      mimeType: "image/png",
      totalBytes: 1200,
      path: "/Users/test/Library/Messages/Attachments/pizza.png",
      missing: false,
    }],
    metadata: { isFromMe: false, rowId: 3 },
  },
  {
    sourceType: "imessage",
    sourceId: "msg_2",
    messageId: "msg_2",
    threadId: "thread_project",
    sender: "user@example.com",
    recipients: ["+15550000003"],
    recipientContacts: [{ handle: "+15550000003", displayName: "Mina Example" }],
    title: "Project Atlas",
    timestamp: "2026-05-16T11:00:00.000Z",
    content: "Project Atlas needs the decision log before Friday.",
    metadata: {
      isFromMe: true,
      rowId: 2,
      senderDisplayName: "Local User",
      destinationCallerId: "local-user@icloud.com",
    },
  },
  {
    sourceType: "imessage",
    sourceId: "msg_1",
    messageId: "msg_1",
    threadId: "thread_family",
    sender: "+15551234567",
    recipients: ["user@example.com"],
    title: "Family",
    timestamp: "2026-05-15T12:00:00.000Z",
    content: "Mum's appointment is every Tuesday morning.",
    metadata: { isFromMe: false, rowId: 1 },
  },
  {
    sourceType: "imessage",
    sourceId: "msg_0",
    messageId: "msg_0",
    threadId: "thread_project",
    sender: "+15550000003",
    recipients: ["user@example.com"],
    title: "Project Atlas",
    timestamp: "2026-05-15T10:00:00.000Z",
    content: "Project Atlas kickoff notes are in the shared folder.",
    metadata: { isFromMe: false, rowId: 0 },
  },
  {
    sourceType: "notes",
    sourceId: "note_3",
    recipients: [],
    title: "Project Atlas review",
    timestamp: "2026-05-16T09:00:00.000Z",
    content: "Project Atlas needs a customer story review.",
    metadata: { folder: "Work" },
  },
  {
    sourceType: "notes",
    sourceId: "note_2",
    recipients: [],
    title: "Project Atlas risks",
    timestamp: "2026-05-15T09:00:00.000Z",
    content: "Project Atlas risk is unclear launch ownership.",
    metadata: { folder: "Work" },
  },
  {
    sourceType: "notes",
    sourceId: "note_1",
    recipients: [],
    title: "House preferences",
    timestamp: "2026-05-14T08:00:00.000Z",
    content: "Prefer quiet hotels near train stations.",
    metadata: { folder: "Personal" },
  },
];

describe("ToolsetRuntime", () => {
  it("only lists enabled Puter toolsets", () => {
    const runtime = createRuntime(["puter.imessage"]);

    expect(runtime.list().map((toolset) => toolset.slug)).toEqual(["puter.imessage"]);
    expect(runtime.list("notes")).toEqual([]);
  });

  it("does not expose skills unless explicitly enabled", async () => {
    const runtime = createRuntime([]);

    expect(runtime.list("skills")).toEqual([]);
    await expect(runtime.load("skills")).rejects.toThrow("Toolset is not available");
  });

  it("lists generated skills commands when explicitly enabled", () => {
    const runtime = createToolsetRuntime({
      processType: "worker",
      enabledTools: ["skills"],
      definitions: [createSkillsToolsetDefinition({
        processTypes: ["worker"],
        runtime: {
          rootDir: "/tmp/finn-test-skills",
          commandRunner: {
            spawn: () => {
              throw new Error("not used");
            },
          },
        },
      })],
      context: {},
    });

    const [summary] = runtime.list("skills");

    expect(summary).toMatchObject({
      slug: "skills",
      effects: ["read", "write"],
      commands: [
        expect.objectContaining({ name: "list", effects: ["read"] }),
        expect.objectContaining({ name: "search", effects: ["read"] }),
        expect.objectContaining({ name: "install", effects: ["write"] }),
        expect.objectContaining({ name: "remove", effects: ["write"] }),
        expect.objectContaining({ name: "update", effects: ["write"] }),
        expect.objectContaining({ name: "load", effects: ["read"] }),
        expect.objectContaining({ name: "read_resource", effects: ["read"] }),
      ],
    });
  });

  it("loads tool instructions for enabled toolsets", async () => {
    const runtime = createRuntime(["puter.notes"]);

    const loaded = await runtime.load("puter.notes");

    expect(loaded.toolset.slug).toBe("puter.notes");
    expect(loaded.instructions).toContain("# Puter Notes");
    expect(loaded.instructions).toContain("finn.puter.notes.getNote({ noteId })");
  });

  it("renders structured examples for grant-filtered Puter toolsets", async () => {
    const runtime = createToolsetRuntime({
      processType: "worker",
      enabledTools: ["puter.notes"],
      toolsetGrants: { "puter.notes": "read" },
      context: {
        executeCommand: async () => ({ ok: true }),
      },
    });

    const loaded = await runtime.load("puter.notes");

    expect(loaded.instructions).toContain("API: finn.puter.notes.listNotes(input)");
    expect(loaded.instructions).toContain("### Code examples");
    expect(loaded.instructions).toContain("await finn.puter.notes.searchNotes({ query: \"Project Atlas\", limit: 25 })");
    expect(loaded.instructions).toContain("When nextCursor is present");
  });

  it("rejects disabled toolsets at execution time", async () => {
    const runtime = createRuntime(["puter.imessage"]);

    await expect(runtime.execute({
      toolset: "puter.notes",
      command: "search_notes",
      args: { query: "hotels" },
    })).rejects.toThrow("Toolset is not available");
  });

  it("executes allowlisted iMessage and Notes commands over local records", async () => {
    const runtime = createRuntime(["puter.imessage", "puter.notes"]);

    const messages = await runtime.execute({
      toolset: "puter.imessage",
      command: "search_messages",
      args: { query: "Tuesday" },
    });
    const notes = await runtime.execute({
      toolset: "puter.notes",
      command: "get_note",
      args: { noteId: "note_1" },
    });

    expect(messages.result).toEqual(expect.objectContaining({
      messages: [expect.objectContaining({ sourceId: "msg_1", threadId: "thread_family" })],
    }));
    const contactMessages = await runtime.execute({
      toolset: "puter.imessage",
      command: "search_messages",
      args: { query: "Mina Example" },
    });
    expect(contactMessages.result).toEqual(expect.objectContaining({
      messages: expect.arrayContaining([
        expect.objectContaining({
          sourceId: "msg_3",
          senderContact: { handle: "+15550000003", displayName: "Mina Example" },
        }),
      ]),
    }));
    expect(notes.result).toEqual(expect.objectContaining({
      note: expect.objectContaining({ sourceId: "note_1", title: "House preferences" }),
    }));
  });

  it("cursor-paginates local Puter list and search commands", async () => {
    const runtime = createRuntime(["puter.imessage", "puter.notes"]);

    const firstMessages = await runtime.execute({
      toolset: "puter.imessage",
      command: "search_messages",
      args: { query: "Project Atlas", limit: 2 },
    });
    const firstMessagePage = firstMessages.result as {
      messages: Array<{ sourceId: string }>;
      nextCursor: string | null;
      previousCursor: string | null;
      total: number;
    };
    expect(firstMessagePage).toMatchObject({
      messages: [{ sourceId: "msg_3" }, { sourceId: "msg_2" }],
      nextCursor: "2",
      previousCursor: null,
      total: 3,
    });

    const secondMessages = await runtime.execute({
      toolset: "puter.imessage",
      command: "search_messages",
      args: { query: "Project Atlas", limit: 2, cursor: firstMessagePage.nextCursor },
    });
    expect(secondMessages.result).toEqual(expect.objectContaining({
      messages: [expect.objectContaining({ sourceId: "msg_0" })],
      nextCursor: null,
      previousCursor: "0",
      total: 3,
    }));

    const threadPage = await runtime.execute({
      toolset: "puter.imessage",
      command: "read_thread",
      args: { threadId: "thread_project", limit: 2 },
    });
    expect(threadPage.result).toEqual(expect.objectContaining({
      messages: [
        expect.objectContaining({ sourceId: "msg_2" }),
        expect.objectContaining({ sourceId: "msg_3" }),
      ],
      nextCursor: "2",
      previousCursor: null,
      total: 3,
    }));

    const chats = await runtime.execute({
      toolset: "puter.imessage",
      command: "list_chats",
      args: { limit: 1 },
    });
    expect(chats.result).toEqual(expect.objectContaining({
      chats: [expect.objectContaining({
        threadId: "thread_project",
        participantDetails: [{ handle: "+15550000003", displayName: "Mina Example" }],
      })],
      nextCursor: "1",
      previousCursor: null,
      total: 2,
    }));

    const notes = await runtime.execute({
      toolset: "puter.notes",
      command: "search_notes",
      args: { query: "Project Atlas", limit: 1 },
    });
    const notePage = notes.result as {
      notes: Array<{ sourceId: string }>;
      nextCursor: string | null;
      previousCursor: string | null;
      total: number;
    };
    expect(notePage).toMatchObject({
      notes: [{ sourceId: "note_3" }],
      nextCursor: "1",
      previousCursor: null,
      total: 2,
    });

    const secondNotes = await runtime.execute({
      toolset: "puter.notes",
      command: "search_notes",
      args: { query: "Project Atlas", limit: 1, cursor: notePage.nextCursor },
    });
    expect(secondNotes.result).toEqual(expect.objectContaining({
      notes: [expect.objectContaining({ sourceId: "note_2" })],
      nextCursor: null,
      previousCursor: "0",
      total: 2,
    }));

    const listedNotes = await runtime.execute({
      toolset: "puter.notes",
      command: "list_notes",
      args: { limit: 2 },
    });
    expect(listedNotes.result).toEqual(expect.objectContaining({
      notes: [
        expect.objectContaining({ sourceId: "note_3" }),
        expect.objectContaining({ sourceId: "note_2" }),
      ],
      nextCursor: "2",
      previousCursor: null,
      total: 3,
    }));
    expect((listedNotes.result as { notes: Array<Record<string, unknown>> }).notes[0]).not.toHaveProperty("content");
  });

  it("keeps direct Notes reads scoped to the runtime window", async () => {
    const runtime = createToolsetRuntime({
      processType: "personal_intelligence",
      enabledTools: ["puter.notes"],
      context: {
        records: [
          ...records,
          {
            sourceType: "notes",
            sourceId: "note_old",
            recipients: [],
            title: "Old note",
            timestamp: "2026-04-01T00:00:00.000Z",
            content: "This old note is outside the run window.",
            metadata: { folder: "Archive" },
          },
        ],
        connectedAccountId: "puter:mac",
        windowStart: new Date("2026-05-01T00:00:00.000Z"),
        windowEnd: new Date("2026-05-17T00:00:00.000Z"),
      },
    });

    const result = await runtime.execute({
      toolset: "puter.notes",
      command: "get_note",
      args: { noteId: "note_old" },
    });

    expect(result.result).toEqual({
      connectedAccountId: "puter:mac",
      note: null,
    });
  });

  it("uses a live command bridge when the context provides executeCommand", async () => {
    const calls: unknown[] = [];
    const optionsSeen: unknown[] = [];
    const abortController = new AbortController();
    const runtime = createToolsetRuntime({
      processType: "personal_intelligence",
      enabledTools: ["puter.imessage"],
      context: {
        connectedAccountId: "puter:mac",
        windowStart: new Date("2026-05-01T00:00:00.000Z"),
        windowEnd: new Date("2026-05-17T00:00:00.000Z"),
        executeCommand: async (input, options) => {
          calls.push(input);
          optionsSeen.push(options);
          return { messages: [{ sourceId: "live_msg" }] };
        },
      },
    });

    const result = await runtime.execute({
      toolset: "puter.imessage",
      command: "search_messages",
      args: { query: "live", limit: 10, cursor: "10" },
    }, { abortSignal: abortController.signal });
    const attachment = await runtime.execute({
      toolset: "puter.imessage",
      command: "load_attachment",
      args: { path: "~/Library/Messages/Attachments/photo.png", maxBytes: 1000 },
    });

    expect(calls).toEqual([
      {
        toolset: "puter.imessage",
        command: "search_messages",
        args: { query: "live", limit: 10, cursor: "10", match: "contains" },
      },
      {
        toolset: "puter.imessage",
        command: "load_attachment",
        args: { path: "~/Library/Messages/Attachments/photo.png", maxBytes: 1000 },
      },
    ]);
    expect(result.result).toEqual({ messages: [{ sourceId: "live_msg" }] });
    expect(attachment.result).toEqual({ messages: [{ sourceId: "live_msg" }] });
    expect(optionsSeen[0]).toEqual({ abortSignal: abortController.signal });
  });

  it("normalizes sent iMessages returned by the live Puter bridge", async () => {
    const runtime = createToolsetRuntime({
      processType: "personal_intelligence",
      enabledTools: ["puter.imessage"],
      context: {
        connectedAccountId: "puter:mac",
        windowStart: new Date("2026-05-01T00:00:00.000Z"),
        windowEnd: new Date("2026-05-17T00:00:00.000Z"),
        executeCommand: async () => ({
          messages: [{
            sourceType: "imessage",
            sourceId: "BF099BF9-2022-40A6-B359-2C77DC316BD7",
            messageId: "BF099BF9-2022-40A6-B359-2C77DC316BD7",
            threadId: "any;-;cheyenneu97@gmail.com",
            sender: "cheyenneu97@gmail.com",
            senderContact: { handle: "cheyenneu97@gmail.com", displayName: "Baby" },
            recipients: ["cheyenneu97@gmail.com"],
            recipientContacts: [{ handle: "cheyenneu97@gmail.com", displayName: "Baby" }],
            title: "Baby",
            timestamp: "2026-05-18T00:46:55.000Z",
            content: "Yeah\n\nBroccolini\nChicken Thigh\nGolden curry mix\nBoysenberry drumsticks\nx",
            metadata: {
              isFromMe: true,
              senderDisplayName: "Baby",
              destinationCallerId: "local-user@icloud.com",
            },
          }],
        }),
      },
    });

    const result = await runtime.execute({
      toolset: "puter.imessage",
      command: "search_messages",
      args: { query: "Broccolini" },
    });
    const aliasResult = await runtime.execute({
      toolset: "puter.imessage",
      command: "search",
      args: { query: "Broccolini" },
    });

    expect(result.result).toEqual(expect.objectContaining({
      messages: [expect.objectContaining({
        sourceId: "BF099BF9-2022-40A6-B359-2C77DC316BD7",
        direction: "sent_by_user",
        sender: "me",
        metadata: expect.objectContaining({
          isFromMe: true,
          localUser: true,
          sourceDirection: "sent_or_authored_by_user",
          localSenderHandle: "local-user@icloud.com",
        }),
      })],
    }));
    const [message] = (result.result as {
      messages: Array<{ senderContact?: unknown; metadata: Record<string, unknown> }>;
    }).messages;
    expect(message.senderContact).toBeUndefined();
    expect(message.metadata.senderDisplayName).toBeUndefined();
    expect(message.metadata.destinationCallerId).toBeUndefined();
    expect(aliasResult.result).toEqual(expect.objectContaining({
      messages: [expect.objectContaining({ sender: "me", direction: "sent_by_user" })],
    }));
  });

  it("executes validated Puter JS workspace calls", async () => {
    const runtime = createRuntime(["puter.imessage", "puter.notes"]);

    const messages = await runtime.execute({
      toolset: "puter.imessage",
      command: "search_messages",
      args: { query: "Project Atlas", limit: 2 },
    });
    const note = await runtime.execute({
      toolset: "puter.notes",
      command: "get_note",
      args: { noteId: "note_1" },
    });

    expect(messages).toEqual(
      expect.objectContaining({
        toolset: "puter.imessage",
        command: "search_messages",
        result: expect.objectContaining({
          messages: [
            expect.objectContaining({ sourceId: "msg_3" }),
            expect.objectContaining({ sourceId: "msg_2" }),
          ],
        }),
      }),
    );
    expect(note).toEqual(
      expect.objectContaining({
        toolset: "puter.notes",
        command: "get_note",
        result: expect.objectContaining({
          note: expect.objectContaining({ sourceId: "note_1" }),
        }),
      }),
    );
  });

  it("supports iMessage aliases in structured JS workspace calls", async () => {
    const runtime = createRuntime(["puter.imessage"]);

    const chats = await runtime.execute({
      toolset: "puter.imessage",
      command: "chats",
      args: { limit: 1 },
    });
    const history = await runtime.execute({
      toolset: "puter.imessage",
      command: "history",
      args: { threadId: "thread_project", limit: 2, attachments: true },
    });
    const search = await runtime.execute({
      toolset: "puter.imessage",
      command: "search",
      args: { query: "pizza.png", match: "exact" },
    });

    expect(chats).toEqual(
      expect.objectContaining({
        command: "chats",
        result: expect.objectContaining({
          chats: [expect.objectContaining({ threadId: "thread_project" })],
        }),
      }),
    );
    expect(history).toEqual(
      expect.objectContaining({
        command: "history",
        result: expect.objectContaining({
          messages: expect.arrayContaining([
            expect.objectContaining({
              sourceId: "msg_3",
              attachments: [expect.objectContaining({ filename: "pizza.png", mimeType: "image/png" })],
            }),
          ]),
        }),
      }),
    );
    expect(search).toEqual(
      expect.objectContaining({
        command: "search",
        result: expect.objectContaining({
          messages: [expect.objectContaining({ sourceId: "msg_3" })],
        }),
      }),
    );
  });

  it("excludes configured handles from local iMessage results", async () => {
    const runtime = createToolsetRuntime({
      processType: "personal_intelligence",
      enabledTools: ["puter.imessage"],
      context: {
        records: [
          ...records,
          {
            sourceType: "imessage",
            sourceId: "msg_finn",
            messageId: "msg_finn",
            threadId: "thread_finn",
            sender: "+15550001111",
            recipients: ["user@example.com"],
            title: "+15550001111",
            timestamp: "2026-05-16T13:00:00.000Z",
            content: "hello from finn",
            metadata: { isFromMe: false, rowId: 11 },
          },
        ],
        connectedAccountId: "puter:mac",
        windowStart: new Date("2026-05-01T00:00:00.000Z"),
        windowEnd: new Date("2026-05-17T00:00:00.000Z"),
        excludedHandles: ["+1 (555) 000-1111"],
      },
    });

    const chats = await runtime.execute({
      toolset: "puter.imessage",
      command: "chats",
      args: { limit: 10 },
    });
    const search = await runtime.execute({
      toolset: "puter.imessage",
      command: "search",
      args: { query: "hello from finn" },
    });

    expect(chats.result).toEqual(expect.objectContaining({
      chats: expect.not.arrayContaining([
        expect.objectContaining({ threadId: "thread_finn" }),
      ]),
    }));
    expect(search.result).toEqual(expect.objectContaining({
      messages: [],
      total: 0,
    }));
  });

  it("excludes archived, deleted, and spam local iMessage records", async () => {
    const runtime = createToolsetRuntime({
      processType: "personal_intelligence",
      enabledTools: ["puter.imessage"],
      context: {
        records: [
          ...records,
          {
            sourceType: "imessage",
            sourceId: "msg_archived_chat",
            messageId: "msg_archived_chat",
            threadId: "thread_archived_chat",
            sender: "+15550000004",
            recipients: ["user@example.com"],
            title: "Archived chat",
            timestamp: "2026-05-16T14:00:00.000Z",
            content: "hidden archived chat message",
            metadata: { chatIsArchived: 1, rowId: 12 },
          },
          {
            sourceType: "imessage",
            sourceId: "msg_archived_message",
            messageId: "msg_archived_message",
            threadId: "thread_project",
            sender: "+15550000003",
            recipients: ["user@example.com"],
            title: "Project Atlas",
            timestamp: "2026-05-16T13:30:00.000Z",
            content: "hidden archived message",
            metadata: { messageIsArchive: 1, rowId: 13 },
          },
          {
            sourceType: "imessage",
            sourceId: "msg_deleted",
            messageId: "msg_deleted",
            threadId: "thread_deleted",
            sender: "+15550000005",
            recipients: ["user@example.com"],
            title: "Deleted chat",
            timestamp: "2026-05-16T13:15:00.000Z",
            content: "hidden deleted message",
            metadata: { isRecoverable: true, rowId: 14 },
          },
          {
            sourceType: "imessage",
            sourceId: "msg_spam",
            messageId: "msg_spam",
            threadId: "thread_spam",
            sender: "+15550000006",
            recipients: ["user@example.com"],
            title: "Spam",
            timestamp: "2026-05-16T13:10:00.000Z",
            content: "hidden spam message",
            metadata: { messageIsSpam: 1, rowId: 15 },
          },
        ],
        connectedAccountId: "puter:mac",
        windowStart: new Date("2026-05-01T00:00:00.000Z"),
        windowEnd: new Date("2026-05-17T00:00:00.000Z"),
      },
    });

    const chats = await runtime.execute({
      toolset: "puter.imessage",
      command: "chats",
      args: { limit: 10 },
    });
    const search = await runtime.execute({
      toolset: "puter.imessage",
      command: "search",
      args: { query: "hidden" },
    });
    const thread = await runtime.execute({
      toolset: "puter.imessage",
      command: "history",
      args: { threadId: "thread_project", limit: 10 },
    });

    expect(chats.result).toEqual(expect.objectContaining({
      chats: expect.not.arrayContaining([
        expect.objectContaining({ threadId: "thread_archived_chat" }),
        expect.objectContaining({ threadId: "thread_deleted" }),
        expect.objectContaining({ threadId: "thread_spam" }),
      ]),
    }));
    expect(search.result).toEqual(expect.objectContaining({
      messages: [],
      total: 0,
    }));
    expect(thread.result).toEqual(expect.objectContaining({
      messages: expect.not.arrayContaining([
        expect.objectContaining({ sourceId: "msg_archived_message" }),
      ]),
      total: 3,
    }));
  });

  it("marks sent iMessages as authored by the local Messages account", async () => {
    const runtime = createToolsetRuntime({
      processType: "personal_intelligence",
      enabledTools: ["puter.imessage"],
      context: {
        records,
        connectedAccountId: "puter:mac",
        windowStart: new Date("2026-05-01T00:00:00.000Z"),
        windowEnd: new Date("2026-05-17T00:00:00.000Z"),
      },
    });

    const result = await runtime.execute({
      toolset: "puter.imessage",
      command: "history",
      args: { threadId: "thread_project", limit: 10 },
    });

    expect(result.result).toEqual(expect.objectContaining({
      messages: expect.arrayContaining([
        expect.objectContaining({
          sourceId: "msg_2",
          direction: "sent_by_user",
          sender: "me",
          recipients: ["+15550000003"],
          metadata: expect.objectContaining({
            isFromMe: true,
            localUser: true,
            sourceDirection: "sent_or_authored_by_user",
            localSenderHandle: "local-user@icloud.com",
          }),
        }),
      ]),
    }));
    const sentMessage = (result.result as { messages: Array<{ sourceId: string; metadata: Record<string, unknown> }> }).messages.find((message) => message.sourceId === "msg_2");
    expect(sentMessage?.metadata.senderDisplayName).toBeUndefined();
    expect(sentMessage?.metadata.destinationCallerId).toBeUndefined();
  });

  it("throws structured execution errors for unavailable toolsets and invalid inputs", async () => {
    const runtime = createRuntime(["puter.imessage"]);

    await expect(runtime.execute({
      toolset: "puter.notes",
      command: "list_notes",
      args: { limit: 1 },
    })).rejects.toThrow("Toolset is not available");
    await expect(runtime.execute({
      toolset: "puter.imessage",
      command: "list_chats",
      args: { unknown: "yes" },
    })).rejects.toThrow("Unrecognized key");
  });

  it("supports injected non-Puter toolset definitions", async () => {
    const runtime = createToolsetRuntime({
      processType: "worker",
      enabledTools: ["files"],
      includeBuiltInToolsets: false,
      definitions: [{
        manifest: {
          slug: "files",
          displayName: "Files",
          description: "Read and write workspace files.",
          capability: "write",
          effects: ["read", "write"],
          processTypes: ["worker"],
          commands: [{
            name: "read",
            description: "Read a file.",
            effects: ["read"],
            inputSchema: z.object({ path: z.string() }),
          }],
        },
        loadInstructions: async () => "Use await finn.files.read({ path }).",
        executors: {
          read: async (args) => ({ args }),
        },
      }],
      context: {
        connectedAccountId: "worker",
        windowStart: new Date("2026-05-01T00:00:00.000Z"),
        windowEnd: new Date("2026-05-17T00:00:00.000Z"),
      },
    });

    expect(runtime.list()).toEqual([
      expect.objectContaining({
        slug: "files",
        capability: "read",
        effects: ["read"],
        commands: [expect.objectContaining({ name: "read", effects: ["read"], flags: ["path"] })],
      }),
    ]);
    await expect(runtime.execute({
      toolset: "files",
      command: "read",
      args: { path: "/workspace/tmp/output.txt" },
    })).resolves.toEqual({
      toolset: "files",
      command: "read",
      result: { args: { path: "/workspace/tmp/output.txt" } },
    });
  });

  it("summarizes and executes grant-filtered Finn JS workspace toolsets", async () => {
    const runtime = createToolsetRuntime({
      processType: "worker",
      enabledTools: ["puter.notes"],
      includeBuiltInToolsets: false,
      definitions: [{
        manifest: {
          slug: "puter.notes",
          displayName: "Puter Notes",
          description: "Read and write notes.",
          capability: "write",
          processTypes: ["worker"],
          commands: [
            {
              name: "search_notes",
              description: "Search notes.",
              effects: ["read"],
              inputSchema: z.object({
                query: z.string().describe("Search query."),
                limit: z.coerce.number().optional(),
              }).strict(),
            },
            {
              name: "create_note",
              description: "Create a note.",
              effects: ["write"],
              inputSchema: z.object({
                title: z.string(),
                visible: z.boolean().optional(),
              }).strict(),
            },
          ],
        },
        executors: {
          search_notes: async (args) => ({ args }),
          create_note: async (args) => ({ args }),
        },
      }],
      toolsetGrants: { "puter.notes": "read" },
      context: {},
    });

    expect(runtime.toCodeModeToolsets()).toEqual([
      expect.objectContaining({
        slug: "puter.notes",
        commands: [
          expect.objectContaining({
            toolset: "puter.notes",
            name: "search_notes",
            inputSchema: expect.any(z.ZodObject),
          }),
        ],
      }),
    ]);

    await expect(runtime.execute({
      toolset: "puter.notes",
      command: "search_notes",
      args: { query: "atlas", limit: 2 },
    })).resolves.toEqual({
      toolset: "puter.notes",
      command: "search_notes",
      result: { args: { query: "atlas", limit: 2 } },
    });
    await expect(runtime.execute({
      toolset: "puter.notes",
      command: "create_note",
      args: { title: "nope" },
    })).rejects.toThrow("Toolset command is not allowed");
  });

  it("filters listed, loaded, and executable commands by non-files toolset grants", async () => {
    const runtime = createToolsetRuntime({
      processType: "worker",
      enabledTools: ["notes"],
      toolsetGrants: { notes: "read" },
      includeBuiltInToolsets: false,
      definitions: [{
        manifest: {
          slug: "notes",
          displayName: "Notes",
          description: "Read and write notes.",
          capability: "write",
          effects: ["read", "write"],
          processTypes: ["worker"],
          commands: [
            {
              name: "read",
              description: "Read a workspace file.",
              effects: ["read"],
              inputSchema: z.object({ path: z.string() }).strict(),
            },
            {
              name: "write",
              description: "Write a workspace file.",
              effects: ["write"],
              inputSchema: z.object({ path: z.string(), contents: z.string() }).strict(),
            },
          ],
        },
        loadInstructions: async () => "Static docs mention await finn.notes.write({ path, contents }).",
        executors: {
          read: async (args) => ({ args }),
          write: async (args) => ({ args }),
        },
      }],
      context: {
        connectedAccountId: "worker",
        windowStart: new Date("2026-05-01T00:00:00.000Z"),
        windowEnd: new Date("2026-05-17T00:00:00.000Z"),
      },
    });

    expect(runtime.list()).toEqual([
      expect.objectContaining({
        slug: "notes",
        capability: "read",
        effects: ["read"],
        commands: [
          expect.objectContaining({
            name: "read",
            effects: ["read"],
            flags: ["path"],
          }),
        ],
      }),
    ]);
    const loaded = await runtime.load("notes");
    expect(loaded.instructions).toContain("API: finn.notes.read(input)");
    expect(loaded.instructions).toContain("Input fields: path");
    expect(loaded.instructions).not.toContain("finn.notes.write");
    expect(loaded.instructions).not.toContain("contents");
    expect(loaded.instructions.toLowerCase()).not.toContain("write");

    await expect(runtime.execute({
      toolset: "notes",
      command: "read",
      args: { path: "/workspace/tmp/output.txt" },
    })).resolves.toEqual({
      toolset: "notes",
      command: "read",
      result: { args: { path: "/workspace/tmp/output.txt" } },
    });
    await expect(runtime.execute({
      toolset: "notes",
      command: "write",
      args: { path: "/workspace/tmp/output.txt", contents: "nope" },
    })).rejects.toThrow("Toolset command is not allowed");

  });

  it("does not hide write-capable files APIs when the files grant is read-only", async () => {
    const runtime = createToolsetRuntime({
      processType: "worker",
      enabledTools: ["files"],
      toolsetGrants: { files: "read" },
      includeBuiltInToolsets: false,
      definitions: [{
        manifest: {
          slug: "files",
          displayName: "Files",
          description: "Read and write workspace files.",
          capability: "write",
          effects: ["read", "write"],
          processTypes: ["worker"],
          commands: [
            {
              name: "read",
              description: "Read a workspace file.",
              effects: ["read"],
              inputSchema: z.object({ path: z.string() }).strict(),
            },
            {
              name: "write",
              description: "Write a workspace file.",
              effects: ["write"],
              inputSchema: z.object({ path: z.string(), contents: z.string() }).strict(),
            },
          ],
        },
        executors: {
          read: async (args) => ({ args }),
          write: async (args) => ({ args }),
        },
      }],
      context: {
        connectedAccountId: "worker",
        windowStart: new Date("2026-05-01T00:00:00.000Z"),
        windowEnd: new Date("2026-05-17T00:00:00.000Z"),
      },
    });

    expect(runtime.list()).toEqual([
      expect.objectContaining({
        slug: "files",
        capability: "write",
        effects: ["read", "write"],
        commands: [
          expect.objectContaining({ name: "read" }),
          expect.objectContaining({ name: "write" }),
        ],
      }),
    ]);
    const loaded = await runtime.load("files");
    expect(loaded.instructions).toContain("API: finn.files.write(input)");
    await expect(runtime.execute({
      toolset: "files",
      command: "write",
      args: { path: "/workspace/tmp/output.txt", contents: "ok" },
    })).resolves.toEqual({
      toolset: "files",
      command: "write",
      result: { args: { path: "/workspace/tmp/output.txt", contents: "ok" } },
    });
  });
});

function createRuntime(enabledTools: string[]) {
  return createToolsetRuntime({
    processType: "personal_intelligence",
    enabledTools,
    context: {
      records,
      connectedAccountId: "puter:mac",
      windowStart: new Date("2026-05-01T00:00:00.000Z"),
      windowEnd: new Date("2026-05-17T00:00:00.000Z"),
    },
  });
}
