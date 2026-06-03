// ---------------------------------------------------------------------------
// Custom error types for Finn
// ---------------------------------------------------------------------------

export class FinnError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "FinnError";
    this.code = code;
  }
}

/** Configuration validation or missing env var */
export class ConfigError extends FinnError {
  constructor(message: string) {
    super(message, "CONFIG_ERROR");
    this.name = "ConfigError";
  }
}

/** Database connection or query failure */
export class DatabaseError extends FinnError {
  readonly query?: string;

  constructor(message: string, query?: string) {
    super(message, "DATABASE_ERROR");
    this.name = "DatabaseError";
    this.query = query;
  }
}

/** LLM provider error (rate limit, timeout, bad response) */
export class LLMError extends FinnError {
  readonly provider: string;
  readonly model: string;

  constructor(message: string, provider: string, model: string) {
    super(message, "LLM_ERROR");
    this.name = "LLMError";
    this.provider = provider;
    this.model = model;
  }
}

/** Messaging layer error (Spectrum, Chat SDK) */
export class MessagingError extends FinnError {
  readonly platform: string;

  constructor(message: string, platform: string) {
    super(message, "MESSAGING_ERROR");
    this.name = "MessagingError";
    this.platform = platform;
  }
}

/** Worker execution error */
export class WorkerError extends FinnError {
  readonly workerId: string;

  constructor(message: string, workerId: string) {
    super(message, "WORKER_ERROR");
    this.name = "WorkerError";
    this.workerId = workerId;
  }
}

/** Tool execution error */
export class ToolError extends FinnError {
  readonly toolName: string;

  constructor(message: string, toolName: string) {
    super(message, "TOOL_ERROR");
    this.name = "ToolError";
    this.toolName = toolName;
  }
}

/** Webhook verification failure */
export class WebhookError extends FinnError {
  constructor(message: string) {
    super(message, "WEBHOOK_ERROR");
    this.name = "WebhookError";
  }
}

/** Memory subsystem error */
export class MemoryError extends FinnError {
  constructor(message: string) {
    super(message, "MEMORY_ERROR");
    this.name = "MemoryError";
  }
}

/** Context window overflow or compaction error */
export class ContextError extends FinnError {
  readonly tokenCount?: number;
  readonly maxTokens?: number;

  constructor(message: string, tokenCount?: number, maxTokens?: number) {
    super(message, "CONTEXT_ERROR");
    this.name = "ContextError";
    this.tokenCount = tokenCount;
    this.maxTokens = maxTokens;
  }
}

/** External integration API failure */
export class IntegrationError extends FinnError {
  readonly integration: string;
  readonly statusCode?: number;

  constructor(message: string, integration: string, statusCode?: number) {
    super(message, "INTEGRATION_ERROR");
    this.name = "IntegrationError";
    this.integration = integration;
    this.statusCode = statusCode;
  }
}

/** File storage failure */
export class StorageError extends FinnError {
  constructor(message: string) {
    super(message, "STORAGE_ERROR");
    this.name = "StorageError";
  }
}
