type PromptAttributeValue = boolean | number | string | null | undefined;

type PromptEnvelopeOptions = {
  escapeContent?: boolean;
};

export function escapePromptAttributeValue(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function escapePromptContentValue(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function formatAttributes(attributes: Record<string, PromptAttributeValue>): string {
  const rendered = Object.entries(attributes)
    .filter((entry): entry is [string, boolean | number | string] => entry[1] !== null && entry[1] !== undefined)
    .map(([key, value]) => `${key}="${escapePromptAttributeValue(String(value))}"`);

  return rendered.length > 0 ? ` ${rendered.join(" ")}` : "";
}

export function formatPromptEnvelope(
  tag: string,
  attributes: Record<string, PromptAttributeValue>,
  content: string,
  options: PromptEnvelopeOptions = {},
): string {
  const body = options.escapeContent ? escapePromptContentValue(content) : content;
  return `<${tag}${formatAttributes(attributes)}>\n${body.trim()}\n</${tag}>`;
}

export function startsWithPromptEnvelope(content: string, tag: string): boolean {
  const trimmed = content.trimStart();
  const prefix = `<${tag}`;
  if (!trimmed.startsWith(prefix)) {
    return false;
  }

  const boundary = trimmed.at(prefix.length);
  return boundary === undefined || boundary === ">" || boundary === "/" || /\s/.test(boundary);
}
