const replacementCharacter = "\uFFFD";

export interface PostgresJsonSanitizationResult<T> {
  value: T;
  changed: boolean;
}

export function sanitizePostgresText(value: string): string {
  let sanitized = "";
  let changed = false;

  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);

    if (code === 0) {
      sanitized += replacementCharacter;
      changed = true;
      continue;
    }

    if (code >= 0xD800 && code <= 0xDBFF) {
      const nextCode = value.charCodeAt(index + 1);
      if (nextCode >= 0xDC00 && nextCode <= 0xDFFF) {
        sanitized += value[index] + value[index + 1];
        index += 1;
        continue;
      }

      sanitized += replacementCharacter;
      changed = true;
      continue;
    }

    if (code >= 0xDC00 && code <= 0xDFFF) {
      sanitized += replacementCharacter;
      changed = true;
      continue;
    }

    sanitized += value[index];
  }

  return changed ? sanitized : value;
}

export function sanitizePostgresJsonValue<T>(value: T): PostgresJsonSanitizationResult<T> {
  return sanitizeJsonValue(value, new WeakMap<object, unknown>()) as PostgresJsonSanitizationResult<T>;
}

export function sanitizePostgresJson<T>(value: T): T {
  return sanitizePostgresJsonValue(value).value;
}

function sanitizeJsonValue(value: unknown, seen: WeakMap<object, unknown>): PostgresJsonSanitizationResult<unknown> {
  if (typeof value === "string") {
    const sanitized = sanitizePostgresText(value);
    return {
      value: sanitized,
      changed: sanitized !== value,
    };
  }

  if (value === null || typeof value !== "object") {
    return { value, changed: false };
  }

  if (value instanceof Date) {
    return { value, changed: false };
  }

  if (seen.has(value)) {
    const sanitized = seen.get(value);
    return {
      value: sanitized,
      changed: sanitized !== value,
    };
  }

  if (Array.isArray(value)) {
    let changed = false;
    const sanitizedItems: unknown[] = [];
    seen.set(value, sanitizedItems);
    value.forEach((item) => {
      const sanitized = sanitizeJsonValue(item, seen);
      changed ||= sanitized.changed;
      sanitizedItems.push(sanitized.value);
    });
    if (!changed) {
      seen.set(value, value);
    }

    return {
      value: changed ? sanitizedItems : value,
      changed,
    };
  }

  if (!isPlainRecord(value)) {
    seen.set(value, value);
    return { value, changed: false };
  }

  let changed = false;
  const sanitizedRecord: Record<string, unknown> = {};
  seen.set(value, sanitizedRecord);
  for (const [key, item] of Object.entries(value)) {
    const sanitizedKey = sanitizePostgresText(key);
    const sanitizedItem = sanitizeJsonValue(item, seen);
    changed ||= sanitizedKey !== key || sanitizedItem.changed;
    sanitizedRecord[sanitizedKey] = sanitizedItem.value;
  }
  if (!changed) {
    seen.set(value, value);
  }

  return {
    value: changed ? sanitizedRecord : value,
    changed,
  };
}

function isPlainRecord(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
