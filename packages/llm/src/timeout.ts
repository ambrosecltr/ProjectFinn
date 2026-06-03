export interface LLMTimeoutOptions {
  signal?: AbortSignal;
  timeoutMs: number;
  timeoutMessage?: string;
}

export function withLLMTimeout<T>(options: LLMTimeoutOptions, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort(options.timeoutMessage ?? `LLM process timed out after ${options.timeoutMs}ms.`);
  const timeout = setTimeout(abort, options.timeoutMs);

  if (options.signal) {
    if (options.signal.aborted) {
      abort();
    } else {
      options.signal.addEventListener("abort", abort, { once: true });
    }
  }

  return run(controller.signal).finally(() => {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abort);
  });
}

export function getAbortErrorMessage(error: unknown): string | null {
  if (error instanceof Error && error.name === "AbortError") {
    return error.message || "LLM process timed out.";
  }

  if (error instanceof Error && /abort|timeout|timed out/i.test(error.message)) {
    return error.message;
  }

  return null;
}
