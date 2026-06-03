import { readFile } from "node:fs/promises";
import type { ToolsetDefinition } from "../../types.js";
import { history, listChats, loadAttachment, readThread, search, searchMessages } from "./executor.js";
import { puterImessageManifest } from "./manifest.js";
import { historyInputSchema, listChatsInputSchema, loadAttachmentInputSchema, readThreadInputSchema, searchMessagesInputSchema } from "./schemas.js";

export const puterImessageToolset: ToolsetDefinition = {
  manifest: puterImessageManifest,
  loadInstructions: () => readFile(new URL("./TOOL.md", import.meta.url), "utf8"),
  executors: {
    chats: (args, context) => listChats(listChatsInputSchema.parse(args), context),
    history: (args, context) => history(historyInputSchema.parse(args), context),
    search: (args, context) => search(searchMessagesInputSchema.parse(args), context),
    load_attachment: (args, context) => loadAttachment(loadAttachmentInputSchema.parse(args), context),
    list_chats: (args, context) => listChats(listChatsInputSchema.parse(args), context),
    search_messages: (args, context) => searchMessages(searchMessagesInputSchema.parse(args), context),
    read_thread: (args, context) => readThread(readThreadInputSchema.parse(args), context),
  },
};
