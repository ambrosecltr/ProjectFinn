export function normalizeOutgoingAssistantText(text: string): string {
  const normalizedBlocks = text
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0)
    .filter((block, index, blocks) => index === 0 || block !== blocks[index - 1]);

  return normalizedBlocks.join("\n\n");
}
