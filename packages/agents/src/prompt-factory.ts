import type { AppConfig } from "@finn/core";

const voiceNotesSectionPattern = /\n## voice notes\n[\s\S]*?(?=\n## |$)/;
const generatedImageExamplePattern = /\n(?:good \(playful, confident, from inside\):\n\n)?```\nhmm lemme think\n\[generates and sends image\]\nreckon that's pretty close\n```/;

function renderXmlPromptSection(tag: string, lines: string[]): string {
  return `<${tag}>\n${lines.filter((line) => line.length > 0).join("\n")}\n</${tag}>`;
}

function joinPromptSections(sections: string[]): string {
  return sections
    .map((section) => section.trim())
    .filter((section) => section.length > 0)
    .join("\n\n");
}

function renderVoiceReplyAppendix(capabilities: AppConfig["capabilities"]): string {
  if (!capabilities.media.textToSpeech) {
    return "";
  }

  return [
    renderXmlPromptSection("voice_reply_capability", [
      "The `send_message` tool can send an iMessage voice note when its `voice_message` field is true.",
      "Use voice replies only when the user explicitly asks for audio/voice/talking, or when replying directly to a transcribed voice message and audio is clearly the better fit.",
      "Default to normal text. A voice reply sends audio only, with no text bubble.",
    ]),
  ].join("\n");
}

function renderHotPathMemoryAppendix(capabilities: AppConfig["capabilities"]): string {
  if (!capabilities.integrations?.memory) {
    return "";
  }

  const hasSearchMemory = capabilities.tools.hotPath.search_memory;
  const hasReflectMemory = capabilities.tools.hotPath.reflect_memory;
  if (!hasSearchMemory) {
    return [
      renderXmlPromptSection("memory_context", [
        "Auto-injected memory context may include compact semantic recall results. It is best-effort, incomplete, and not guaranteed relevant. Use it naturally when it helps, but do not recite it unprompted, announce memory access, or expose memory mechanics.",
        "Core user information must stay grounded: names, relationships, family members, health details, locations, jobs, commitments, preferences, and other durable personal facts. Do not invent or infer these from vibes, summaries, or roles. If a specific fact is not present, use a generic role or say you don't know.",
      ]),
    ].join("\n");
  }

  return renderXmlPromptSection("memory_requirements", [
    "The `search_memory` tool can search Finn's user memory: durable context inferred from prior Finn/user interactions, including preferences, personal facts, communication style, history, and what Finn may already know or have told the user. You cannot add, edit, or delete memory.",
    hasReflectMemory ? "The `reflect_memory` tool asks Finn's memory layer to synthesize an answer from that same user memory. Its budget is a work budget, not a quality slider: low for simple/specific facts, mid for synthesis across a few related memories, and high only for broad, ambiguous, sensitive, or high-consequence synthesis." : "",
    "Auto-injected memory context may also appear in runtime context as compact semantic recall results. Treat it as best-effort: useful but incomplete, possibly noisy, and not a substitute for explicit memory search/reflect when accuracy matters.",
    "Use memory tools when user-specific context, prior conversation recall, user preferences/history, or a worker/Pattern-result novelty check would materially change the response.",
    "Before making a specific claim about core user information, use the current conversation, user profile, or relevant memory as evidence. Core user information includes names, relationships, family members, health details, locations, jobs, commitments, preferences, and other durable personal facts.",
    "If you are about to name or characterize a partner, child, family member, friend, coworker, pet, workplace, home/base location, or preference and the exact fact is not already explicit in current context, call `search_memory` first. If memory is unavailable or still does not prove it, avoid the specific claim; use the role instead or say you don't know.",
    hasReflectMemory ? "Use `search_memory` for raw matching facts. Use `reflect_memory` only when the current LLM process needs a higher-level synthesis about patterns, preferences, relationship context, current projects, commitments, or what Finn should understand from multiple memories." : "Use `search_memory` for raw matching facts.",
    "Strong default: before sending a user-visible worker or Pattern result about an ongoing topic, repeated update, health/anxiety-sensitive subject, or anything that may duplicate prior information, usually call `search_memory` to check what Finn already told the user unless the current turn context already proves it is new.",
    "For user asks like 'latest', 'any update', 'check again', 'what did you tell me', or follow-ups on a continuing topic, usually search memory before delegating if prior context would change the worker task or the eventual answer.",
    "Do not search before every normal message, trivial ack, reaction, or same-turn follow-up. Do not announce memory access or expose memory mechanics.",
    "If search is unavailable or returns nothing useful, do not invent.",
  ]);
}

function renderHotPathFileAppendix(capabilities: AppConfig["capabilities"]): string {
  if (!capabilities.tools.hotPath?.files) {
    return "";
  }

  return renderXmlPromptSection("file_context", [
    "Use `workspace_search` and `workspace_execute` with the Finn `files` APIs when the user refers to an uploaded, shared, generated, or recent file that is not already visible in the current message context.",
    "The hot path has write-capable `/workspace` access, but file work should stay lightweight and user-relevant; use `/artifacts` for temporary runtime outputs.",
    "Start with `workspace_search` for the right `finn.files.*` API and keep hot-path file work lightweight. Use native `view_image` for image pixels. Delegate to a worker when file contents, document extraction, transformations, or detailed inspection are needed.",
  ]);
}

function renderMyDayAppendix(): string {
  return renderXmlPromptSection("my_day_todos", [
    "Runtime status may include a compact My Day summary and todo list. Use it as private context; do not recite it unprompted or nag about todos.",
    "Use My Day todo tools only when the user asks to add, edit, complete, reopen, or archive/delete a todo, or when a completed worker outcome clearly finishes a todo that the user handed off.",
    "When a handed-off worker reports back, decide from the actual result whether the todo is complete. Ask the user if more information is needed; do not mark done just because a worker finished.",
    "Deleting a My Day todo archives it: it disappears from the visible list but remains dedupe context. Do not recreate archived todos unless the user asks or a clearly new current-day source makes it actionable again.",
    "Automated/contextual additions should be high confidence and useful. Never remove or complete todos unless the user asks or a user-assigned worker completed the task.",
  ]);
}

export function buildHotPathFinnPrompt(input: {
  finnIdentity: string;
  hotPathPrompt: string;
  capabilities: AppConfig["capabilities"];
}): string {
  const finnIdentity = input.capabilities.media.voiceRoundTrip
    ? input.finnIdentity
    : input.finnIdentity.replace(voiceNotesSectionPattern, "").trimEnd();
  const gatedFinnIdentity = input.capabilities.tools.worker.create_or_edit_image
    ? finnIdentity
    : finnIdentity.replace(generatedImageExamplePattern, "").trimEnd();

  return joinPromptSections([
    gatedFinnIdentity,
    input.hotPathPrompt,
    renderVoiceReplyAppendix(input.capabilities),
    renderHotPathMemoryAppendix(input.capabilities),
    renderHotPathFileAppendix(input.capabilities),
    input.capabilities.tools.hotPath?.my_day ? renderMyDayAppendix() : "",
  ]);
}
