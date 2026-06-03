import pino from "pino";
import type { ProcessType } from "./types.js";

// ---------------------------------------------------------------------------
// Root logger — configured once based on LOG_LEVEL env
// ---------------------------------------------------------------------------

const isDev = process.env["NODE_ENV"] === "development";

function resolveTransport(): pino.TransportSingleOptions | pino.TransportMultiOptions | undefined {
  if (isDev) {
    return { target: "pino-pretty" };
  }

  return undefined;
}

const transport = resolveTransport();
const usesMultiTransport = transport && "targets" in transport;

const loggerOptions: pino.LoggerOptions = {
  level: process.env["LOG_LEVEL"] ?? "info",
  transport,
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: [
      "apiKey",
      "apiSecret",
      "bearerToken",
      "signingSecret",
      "authHeader",
      "authorization",
      "password",
      "secret",
      "token",
      "*.apiKey",
      "*.apiSecret",
      "*.bearerToken",
      "*.signingSecret",
      "*.authHeader",
      "*.authorization",
      "*.password",
      "*.secret",
      "*.token",
      "config.spectrum.projectSecret",
      "config.apiKeys.default",
      "config.apiKeys.hotPath",
      "config.apiKeys.worker",
      "config.apiKeys.compactor",
      "config.admin.bearerToken",
    ],
    censor: "[REDACTED]",
  },
  ...(usesMultiTransport ? {} : {
    formatters: {
      level(label: string) {
        return { level: label };
      },
    },
  }),
};

const rootLogger = pino(loggerOptions);

// ---------------------------------------------------------------------------
// Child logger factory — one per module / process type
// ---------------------------------------------------------------------------

export function createLogger(module: string, extra?: Record<string, unknown>): pino.Logger {
  return rootLogger.child({ module, ...extra });
}

/** Convenience: create a logger scoped to a process type */
export function createProcessLogger(
  processType: ProcessType,
  extra?: Record<string, unknown>,
): pino.Logger {
  return rootLogger.child({ processType, ...extra });
}

// Pre-built loggers for the four process types
export const hotPathLogger = createProcessLogger("hot-path");
export const workerLogger = createProcessLogger("worker");
export const compactorLogger = createProcessLogger("compactor");

export { rootLogger as logger };
