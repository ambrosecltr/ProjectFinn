import type { PatternRun } from "./web-types";

export function patternRunsEqual(previous: PatternRun[] | undefined, next: PatternRun[]): boolean {
  if (!previous || previous.length !== next.length) return false;
  return previous.every((run, index) => {
    const nextRun = next[index];
    return run.id === nextRun.id
      && run.state === nextRun.state
      && run.error === nextRun.error
      && run.skipReason === nextRun.skipReason
      && run.createdAt === nextRun.createdAt
      && run.completedAt === nextRun.completedAt
      && run.surfacedAt === nextRun.surfacedAt
      && JSON.stringify(run.result) === JSON.stringify(nextRun.result)
      && JSON.stringify(run.notifyOutcome) === JSON.stringify(nextRun.notifyOutcome);
  });
}
