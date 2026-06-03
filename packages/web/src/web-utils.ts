import type { CSSProperties } from "react";

export function preloadedImageStyle(src?: string | null): CSSProperties | undefined {
  return src ? { backgroundImage: `url(${JSON.stringify(src)})` } : undefined;
}

export function capitalizeFirst(value: string): string {
  const trimmed = value.trim();
  return trimmed ? trimmed[0].toUpperCase() + trimmed.slice(1) : "";
}

function normalizeSmsRecipient(phoneNumber: string): string {
  return phoneNumber.replace(/[^\d+]/g, "");
}

export function buildTextFinnHref(phoneNumber: string, body?: string): string {
  const recipient = normalizeSmsRecipient(phoneNumber);
  return body ? `sms:${recipient}?body=${encodeURIComponent(body)}` : `sms:${recipient}`;
}
