export function MyDaySummaryCard(props: {
  taskCount: number;
  summary: string;
  lastRefreshedAt: string | null;
}) {
  const taskNoun = props.taskCount === 1 ? "task" : "tasks";
  const taskVerb = props.taskCount === 1 ? "needs" : "need";
  const taskAttentionLabel = `You have ${props.taskCount} ${taskNoun} that ${taskVerb} your attention today.`;

  const dateLabel = new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    day: "numeric",
    month: "long",
  }).format(new Date());

  const updatedLabel = formatRelativeTime(props.lastRefreshedAt);

  return (
    <section className="my-day-summary-card">
      <span className="my-day-summary-date">{dateLabel}</span>
      <p className="my-day-summary-task-count">{taskAttentionLabel}</p>
      <p className="my-day-summary-description">{props.summary}</p>
      {updatedLabel ? <p className="my-day-summary-updated">{updatedLabel}</p> : null}
    </section>
  );
}

function formatRelativeTime(iso: string | null): string | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;
  const diffMs = Date.now() - then;
  const diffMin = Math.round(diffMs / 60_000);
  if (diffMin < 1) return "Updated just now";
  if (diffMin === 1) return "Updated 1 min ago";
  if (diffMin < 60) return `Updated ${diffMin} mins ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr === 1) return "Updated 1 hour ago";
  if (diffHr < 24) return `Updated ${diffHr} hours ago`;
  return "Updated over a day ago";
}
