import { z } from "zod";

export interface FormatUnknownErrorOptions {
  zodPrefix?: string;
  fallback?: string;
}

export function formatUnknownError(error: unknown, options: FormatUnknownErrorOptions = {}): string {
  if (error instanceof z.ZodError) {
    const prefix = options.zodPrefix ?? "Validation failed";
    const issues = error.issues.map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `${path}: ${issue.message}`;
    });
    return `${prefix}: ${issues.join("; ")}`;
  }

  if (error instanceof Error) {
    return error.message || error.name || options.fallback || "Unknown error";
  }

  if (typeof error === "object" && error !== null) {
    return stringifyUnknownObject(error);
  }

  if (error === undefined || error === null || String(error).length === 0) {
    return options.fallback ?? "Unknown error";
  }

  return String(error);
}

function stringifyUnknownObject(value: object): string {
  const seen = new WeakSet<object>();
  try {
    const serialized = JSON.stringify(value, (_key, entry: unknown) => {
      if (typeof entry === "bigint") {
        return entry.toString();
      }
      if (typeof entry === "function") {
        return `[Function ${entry.name || "anonymous"}]`;
      }
      if (typeof entry === "object" && entry !== null) {
        if (seen.has(entry)) {
          return "[Circular]";
        }
        seen.add(entry);
      }
      return entry;
    });
    return serialized && serialized.length > 0 ? serialized : Object.prototype.toString.call(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}
