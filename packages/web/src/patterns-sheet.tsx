import {
  Activity03Icon,
  Alert01Icon,
  ArrowDown01Icon,
  ArrowRight01Icon,
  Calendar01Icon,
  Delete03Icon,
  LaptopIcon,
  Notification01Icon,
  PauseIcon,
  PlayIcon,
  Refresh04Icon,
  Share07Icon,
  Tick01Icon,
  Time02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { AnimatePresence, LayoutGroup, motion, type TargetAndTransition } from "motion/react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import ContentLoader from "react-content-loader";

import { DashRing } from "./components/loading-ui/dash-ring";
import { cn } from "./lib/utils";
import { LoadingView } from "./loading-view";
import { PageTransition, useOrderedPageDirection } from "./page-transition";
import { SegmentedControl, type SegmentedOption } from "./segmented-control";
import type { Pattern, PatternConnector, PatternRun } from "./web-types";
import { capitalizeFirst } from "./web-utils";

type PatternFilter = "all" | "scheduled" | "apps" | "reminders";

const patternFilterOptions = [
  { value: "all", label: "All" },
  { value: "reminders", label: "Reminders", icon: <HugeiconsIcon icon={Notification01Icon} size={15} strokeWidth={2} aria-hidden="true" /> },
  { value: "scheduled", label: "Scheduled", icon: <HugeiconsIcon icon={Calendar01Icon} size={15} strokeWidth={2} aria-hidden="true" /> },
  { value: "apps", label: "Apps", icon: <HugeiconsIcon icon={Share07Icon} size={15} strokeWidth={2} aria-hidden="true" /> },
] as const satisfies ReadonlyArray<SegmentedOption<PatternFilter>>;

const patternFilterValues = ["all", "reminders", "scheduled", "apps"] as const satisfies readonly PatternFilter[];

const skeletonColors = {
  backgroundColor: "#f6f6f6",
  foregroundColor: "#ededed",
};

function ConnectorLogo(props: {
  src?: string;
  fallback: string;
  large?: boolean;
  pill?: boolean;
}) {
  const [showImage, setShowImage] = useState(Boolean(props.src));

  useEffect(() => {
    setShowImage(Boolean(props.src));
  }, [props.src]);

  return (
    <span className={cn("connector-logo", props.large && "large", props.pill && "pill")}>
      {props.src && showImage ? (
        <img
          className="app-image"
          src={props.src}
          alt=""
          draggable={false}
          onError={() => setShowImage(false)}
        />
      ) : props.fallback}
    </span>
  );
}

function ConnectorGlyph(props: {
  connector: PatternConnector;
  large?: boolean;
  pill?: boolean;
}) {
  if (props.connector.slug === "puter") {
    return (
      <span className={cn("connector-logo", props.large && "large", props.pill && "pill")}>
        <HugeiconsIcon icon={LaptopIcon} size={props.large ? 25 : props.pill ? 14 : 20} strokeWidth={1.9} aria-hidden="true" />
      </span>
    );
  }

  return <ConnectorLogo src={props.connector.logo} fallback={props.connector.name.slice(0, 1)} large={props.large} pill={props.pill} />;
}

function formatDateTime(value: string | null): string {
  if (!value) return "Never";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatRelativePatternTime(value: string | null): string {
  if (!value) return "Scheduled";
  const target = new Date(value).getTime();
  const deltaMs = target - Date.now();
  const absDeltaMs = Math.abs(deltaMs);
  const minuteMs = 60 * 1000;
  const hourMs = 60 * minuteMs;
  const dayMs = 24 * hourMs;

  if (deltaMs <= 0) return "Due now";
  if (absDeltaMs < hourMs) {
    const minutes = Math.max(1, Math.round(deltaMs / minuteMs));
    return `In ${minutes} min${minutes === 1 ? "" : "s"}`;
  }
  if (absDeltaMs < dayMs) {
    const hours = Math.max(1, Math.round(deltaMs / hourMs));
    return `In ${hours} hour${hours === 1 ? "" : "s"}`;
  }
  if (absDeltaMs < 2 * dayMs) return "Tomorrow";

  const days = Math.max(2, Math.round(deltaMs / dayMs));
  return `In ${days} days`;
}

function formatReminderPatternTime(value: string | null): string {
  if (!value) return "Scheduled";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Scheduled";
  const day = new Intl.DateTimeFormat("en-AU", { day: "numeric" }).format(date);
  const month = new Intl.DateTimeFormat("en-AU", { month: "short" }).format(date);
  const time = new Intl.DateTimeFormat("en-AU", { hour: "numeric", hour12: true }).format(date).toLowerCase().replace(" ", "");
  return `${day} ${month} @ ${time}`;
}

function patternTriggerLabel(pattern: Pattern): string {
  if (pattern.triggerConfig.type === "schedule") {
    return formatRelativePatternTime(pattern.nextRunAt);
  }
  return pattern.triggerConfig.toolkitName || pattern.triggerConfig.toolkitSlug
    .split(/[-_]/g)
    .filter(Boolean)
    .map(capitalizeFirst)
    .join(" ");
}

function connectorDisplayName(issue: NonNullable<Pattern["connectorIssues"]>[number]): string {
  return issue.toolkitName || issue.toolkitSlug
    .split(/[-_]/g)
    .filter(Boolean)
    .map(capitalizeFirst)
    .join(" ");
}

function patternConnectorIssueLabel(pattern: Pattern): string | null {
  if (!pattern.connectorIssues?.length) return null;
  const names = [...new Set(pattern.connectorIssues.map(connectorDisplayName))];
  return names.length === 1 ? `Reconnect ${names[0]}` : `Reconnect ${names.length} connectors`;
}

function isReminderPattern(pattern: Pattern): boolean {
  return pattern.workerType === "reminder";
}

function patternTypeIcon(pattern: Pattern) {
  if (isReminderPattern(pattern)) return Notification01Icon;
  if (pattern.triggerConfig.type === "schedule") return Calendar01Icon;
  return Share07Icon;
}

function capitalizeSentence(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return `${trimmed[0]?.toLocaleUpperCase() ?? ""}${trimmed.slice(1)}`;
}

function patternRunStatusLabel(run: PatternRun): string {
  if (run.skipReason) return "Skipped";
  if (run.notifyOutcome) return run.notifyOutcome.notify ? "Notified" : "No notify";
  if (run.error || run.result?.error) return "Failed";
  return capitalizeFirst(run.state);
}

function formatRelativePastTime(value: string | null): string {
  if (!value) return "Unknown";
  const target = new Date(value).getTime();
  const deltaMs = Date.now() - target;
  const minuteMs = 60 * 1000;
  const hourMs = 60 * minuteMs;
  const dayMs = 24 * hourMs;

  if (deltaMs < minuteMs) return "Just now";
  if (deltaMs < hourMs) {
    const minutes = Math.max(1, Math.round(deltaMs / minuteMs));
    return `${minutes} min${minutes === 1 ? "" : "s"} ago`;
  }
  if (deltaMs < dayMs) {
    const hours = Math.max(1, Math.round(deltaMs / hourMs));
    return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  }
  if (deltaMs < 7 * dayMs) {
    const days = Math.max(1, Math.round(deltaMs / dayMs));
    return `${days} day${days === 1 ? "" : "s"} ago`;
  }

  return formatDateTime(value);
}

function formatRunDuration(run: PatternRun): string {
  if (run.state === "queued") return "Queued";
  if (run.state === "running") return "Running";
  const end = run.completedAt ? new Date(run.completedAt).getTime() : null;
  const start = new Date(run.createdAt).getTime();
  if (!end || Number.isNaN(start) || Number.isNaN(end) || end < start) return patternRunStatusLabel(run);
  const seconds = Math.max(1, Math.round((end - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
}

function patternRunDescription(pattern: Pattern, run: PatternRun): string {
  if (run.state === "running" || run.state === "queued") return `Running ${pattern.name}`;
  return run.notifyOutcome?.reason || run.skipReason || run.error || run.result?.summary || "No run details captured.";
}

function patternRunNotifyLabel(run: PatternRun): string {
  if (run.state === "running" || run.state === "queued") return "Running";
  return run.notifyOutcome?.notify ? "Notified" : "Not notified";
}

interface PatternStackRadius {
  topLeft: number;
  topRight: number;
  bottomRight: number;
  bottomLeft: number;
}

const PATTERN_STACK_RADIUS = 15;
const PATTERN_LAYOUT_TRANSITION = { type: "spring", stiffness: 380, damping: 34, mass: 0.78 } as const;

function patternRadiusValues(topLeft: number, topRight: number, bottomRight: number, bottomLeft: number): PatternStackRadius {
  return { topLeft, topRight, bottomRight, bottomLeft };
}

function getPatternStackRadius(index: number, count: number, expandedIndex: number): PatternStackRadius {
  if (count <= 1 || index === expandedIndex) return patternRadiusValues(PATTERN_STACK_RADIUS, PATTERN_STACK_RADIUS, PATTERN_STACK_RADIUS, PATTERN_STACK_RADIUS);
  if (expandedIndex < 0) {
    if (index === 0) return patternRadiusValues(PATTERN_STACK_RADIUS, PATTERN_STACK_RADIUS, 0, 0);
    if (index === count - 1) return patternRadiusValues(0, 0, PATTERN_STACK_RADIUS, PATTERN_STACK_RADIUS);
    return patternRadiusValues(0, 0, 0, 0);
  }

  const isAboveExpanded = index < expandedIndex;
  const segmentStart = isAboveExpanded ? 0 : expandedIndex + 1;
  const segmentEnd = isAboveExpanded ? expandedIndex - 1 : count - 1;

  if (index === segmentStart && index === segmentEnd) return patternRadiusValues(PATTERN_STACK_RADIUS, PATTERN_STACK_RADIUS, PATTERN_STACK_RADIUS, PATTERN_STACK_RADIUS);
  if (index === segmentStart) return patternRadiusValues(PATTERN_STACK_RADIUS, PATTERN_STACK_RADIUS, 0, 0);
  if (index === segmentEnd) return patternRadiusValues(0, 0, PATTERN_STACK_RADIUS, PATTERN_STACK_RADIUS);
  return patternRadiusValues(0, 0, 0, 0);
}

function patternRadiusAnimation(radius: PatternStackRadius): TargetAndTransition {
  return {
    borderTopLeftRadius: radius.topLeft,
    borderTopRightRadius: radius.topRight,
    borderBottomRightRadius: radius.bottomRight,
    borderBottomLeftRadius: radius.bottomLeft,
  };
}

function joinedTopBorderColor(radius: PatternStackRadius): string {
  return radius.topLeft === 0 && radius.topRight === 0 ? "transparent" : "#f7f7f7";
}

export function PatternsSheet(props: {
  patterns: Pattern[];
  connectors: PatternConnector[];
  loading: boolean;
  pausingPatternIds: Set<string>;
  onPause: (pattern: Pattern) => void;
  onReconnectConnector: (slug: string, previousConnectedAccountId?: string) => void;
  onShowActivity: (pattern: Pattern) => void;
  onRequestDelete: (pattern: Pattern) => void;
  SheetComponent: (props: { title: string; children: ReactNode; onBack?: () => void; backLabel?: string; locked?: boolean; className?: string }) => ReactNode;
  onHapticFeedback: () => void;
}) {
  const [expandedPatternId, setExpandedPatternId] = useState<string | null>(null);
  const [filter, setFilter] = useState<PatternFilter>("all");
  const connectorBySlug = useMemo(() => new Map(props.connectors.map((connector) => [connector.slug, connector])), [props.connectors]);
  const filteredPatterns = useMemo(() => {
    return props.patterns.filter((pattern) => {
      if (filter === "reminders") return isReminderPattern(pattern);
      if (filter === "scheduled") return pattern.triggerConfig.type === "schedule" && !isReminderPattern(pattern);
      if (filter === "apps") return pattern.triggerConfig.type === "composio" && !isReminderPattern(pattern);
      return true;
    });
  }, [filter, props.patterns]);
  const filterDirection = useOrderedPageDirection(filter, patternFilterValues);
  const expandedPatternIndex = filteredPatterns.findIndex((pattern) => pattern.id === expandedPatternId);

  useEffect(() => {
    setExpandedPatternId(null);
  }, [filter]);

  const SheetComponent = props.SheetComponent;

  return (
    <SheetComponent title="Patterns">
      <div className="connector-sheet-body">
        <SegmentedControl
          className="sheet-segmented-control"
          value={filter}
          options={patternFilterOptions}
          ariaLabel="Filter patterns"
          onValueChange={setFilter}
          onHaptic={props.onHapticFeedback}
        />
        <span className="sr-only" aria-live="polite">
          {filteredPatterns.length} {filter === "all" ? "total" : filter} patterns
        </span>
        <PageTransition pageKey={filter} direction={filterDirection} className="sheet-tab-slide">
          <LayoutGroup>
          <motion.div className="pattern-list" layout="position" transition={PATTERN_LAYOUT_TRANSITION}>
            {props.loading ? <PatternListSkeleton /> : null}
            {!props.loading && filteredPatterns.length === 0 ? <p className="empty-state">No {filter === "reminders" ? "reminders" : "patterns"} match this filter.</p> : null}
            <AnimatePresence initial={false}>
            {!props.loading && filteredPatterns.map((pattern, index) => {
              const expanded = expandedPatternId === pattern.id;
              const reminder = isReminderPattern(pattern);
              const triggerLabel = reminder ? formatReminderPatternTime(pattern.nextRunAt) : patternTriggerLabel(pattern);
              const TypeIcon = patternTypeIcon(pattern);
              const title = capitalizeSentence(pattern.name);
              const summary = capitalizeSentence(pattern.reminderContext?.reminderText || pattern.userDescription || pattern.taskPrompt);
              const connectorIssueLabel = patternConnectorIssueLabel(pattern);
              const connectorIssues = pattern.connectorIssues ?? [];
              const reconnectIssues = [...new Map(connectorIssues.map((issue) => [issue.toolkitSlug, issue])).values()];
              const showTriggerPill = pattern.active && (reminder || connectorIssues.length === 0);
              const showTriggerIcon = reminder || pattern.triggerConfig.type === "schedule";
              const triggerConnector = pattern.triggerConfig.type === "composio" ? connectorBySlug.get(pattern.triggerConfig.toolkitSlug) : null;
              const status = connectorIssues.length ? "blocked" : pattern.active ? "active" : "paused";
              const StatusIcon = status === "blocked" ? Alert01Icon : status === "active" ? Tick01Icon : PauseIcon;
              const stackRadius = getPatternStackRadius(index, filteredPatterns.length, expandedPatternIndex);

              return (
                <motion.article
                  className={`automation-card ${expanded ? "expanded" : ""}`}
                  key={pattern.id}
                  layout="position"
                  initial={{ opacity: 0, y: 8, scale: 0.98 }}
                  animate={{
                    opacity: 1,
                    y: 0,
                    scale: 1,
                    marginTop: expanded && index > 0 ? 14 : 0,
                    marginBottom: expanded ? 14 : 0,
                    borderTopColor: joinedTopBorderColor(stackRadius),
                    ...patternRadiusAnimation(stackRadius),
                  }}
                  exit={{ opacity: 0, height: 0, marginBottom: 0, scale: 0.98 }}
                  transition={PATTERN_LAYOUT_TRANSITION}
                >
                  <div className="automation-card-surface">
                    <button
                      className="automation-card-main"
                      type="button"
                      aria-expanded={expanded}
                      onClick={() => {
                        props.onHapticFeedback();
                        setExpandedPatternId(expanded ? null : pattern.id);
                      }}
                    >
                      <span className="automation-card-title-row">
                        <span className="automation-title">
                          <HugeiconsIcon className="automation-type-icon" icon={TypeIcon} size={16} strokeWidth={2} aria-hidden="true" />
                          <span>{title}</span>
                        </span>
                        <motion.span className="automation-chevron" animate={{ rotate: expanded ? 180 : 0 }} transition={PATTERN_LAYOUT_TRANSITION}>
                          <HugeiconsIcon icon={ArrowDown01Icon} size={18} strokeWidth={2} aria-hidden="true" />
                        </motion.span>
                      </span>
                      <span className="automation-summary">{summary}</span>
                    </button>
                  </div>
                  <div className="automation-expanded">
                    <div className="automation-expanded-inner">
                      <div className="automation-footer">
                        <span className="automation-meta">
                          {showTriggerPill ? (
                            <span className="automation-trigger status-pill">
                              {triggerConnector ? <ConnectorGlyph connector={triggerConnector} pill /> : showTriggerIcon ? <HugeiconsIcon icon={Time02Icon} size={14} strokeWidth={2} aria-hidden="true" /> : null}
                              {triggerLabel}
                            </span>
                          ) : null}
                          {!reminder ? (
                            <span className={`automation-status status-pill ${status}`}>
                              {status === "active" ? <span className="status-pill-dot" aria-hidden="true" /> : <HugeiconsIcon icon={StatusIcon} size={18} strokeWidth={2.4} aria-hidden="true" />}
                              {connectorIssueLabel ?? (pattern.active ? "Active" : "Paused")}
                            </span>
                          ) : null}
                        </span>
                        <span className="automation-actions">
                          {!reminder ? (
                            <>
                              <button className="automation-icon-button" type="button" aria-label={`Show activity for ${pattern.name}`} onClick={() => props.onShowActivity(pattern)}>
                                <HugeiconsIcon icon={Activity03Icon} size={17} strokeWidth={2} />
                              </button>
                              <button
                                className="automation-icon-button"
                                type="button"
                                aria-label={`${pattern.active ? "Pause" : "Resume"} ${pattern.name}`}
                                disabled={props.pausingPatternIds.has(pattern.id) || connectorIssues.length > 0}
                                onClick={() => props.onPause(pattern)}
                              >
                                {props.pausingPatternIds.has(pattern.id) ? <DashRing className="automation-action-spinner" aria-hidden="true" /> : <HugeiconsIcon icon={pattern.active ? PauseIcon : PlayIcon} size={17} strokeWidth={2} />}
                              </button>
                            </>
                          ) : null}
                          <button className="automation-icon-button danger" type="button" aria-label={`Delete ${pattern.name}`} onClick={() => props.onRequestDelete(pattern)}>
                            <HugeiconsIcon icon={Delete03Icon} size={17} strokeWidth={2} />
                          </button>
                        </span>
                        {connectorIssues.length > 0 ? (
                          <span className="automation-reconnect-actions">
                            {reconnectIssues.map((issue) => (
                              <button
                                className="automation-reconnect-button"
                                key={`${pattern.id}-${issue.toolkitSlug}`}
                                type="button"
                                onClick={() => props.onReconnectConnector(issue.toolkitSlug, issue.connectedAccountId)}
                              >
                                <HugeiconsIcon icon={Refresh04Icon} size={15} strokeWidth={2} />
                                <span>Reconnect {connectorDisplayName(issue)}</span>
                              </button>
                            ))}
                          </span>
                        ) : null}
                      </div>
                    </div>
                  </div>
                </motion.article>
              );
            })}
            </AnimatePresence>
          </motion.div>
          </LayoutGroup>
        </PageTransition>
      </div>
    </SheetComponent>
  );
}

export function PatternActivitySheet(props: {
  pattern: Pattern;
  runs: PatternRun[];
  loading: boolean;
  onClose: () => void;
  StandaloneSheetComponent: (props: { title: string; className?: string; children: ReactNode; onClose: () => void }) => ReactNode;
  fallbackRuns?: (patternId: string) => PatternRun[];
}) {
  const sourceRuns = props.runs.length > 0 ? props.runs : props.fallbackRuns?.(props.pattern.id) ?? [];
  const latestRuns = sourceRuns
    .slice()
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 10);
  const latestRunIds = latestRuns.map((run) => run.id).join("|");
  const hasRuns = latestRuns.length > 0;
  const [closedRunIds, setClosedRunIds] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    const visibleRunIds = new Set(latestRuns.map((run) => run.id));
    setClosedRunIds((current) => {
      const next = new Set([...current].filter((id) => visibleRunIds.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [latestRunIds]);

  function toggleRunDetails(runId: string) {
    setClosedRunIds((current) => {
      const next = new Set(current);
      if (next.has(runId)) {
        next.delete(runId);
      } else {
        next.add(runId);
      }
      return next;
    });
  }

  const StandaloneSheetComponent = props.StandaloneSheetComponent;

  return (
    <StandaloneSheetComponent title={props.pattern.name} className="pattern-activity-sheet-panel" onClose={props.onClose}>
      <div className="pattern-activity">
        {props.loading && !hasRuns ? <LoadingView label="Loading activity..." /> : null}
        {!props.loading && !hasRuns ? <p className="empty-state">No runs yet.</p> : null}
        {hasRuns ? (
          <>
            <div className="pattern-timeline" role="list">
              {latestRuns.map((run, index) => {
              const active = run.state === "running" || run.state === "queued";
              const completed = run.state === "done" && !run.error && !run.result?.error;
              const title = active ? `Started ${formatRelativePastTime(run.createdAt)}` : formatRelativePastTime(run.completedAt ?? run.createdAt);

              return (
                <article className="pattern-timeline-item" data-status={active ? "active" : completed ? "completed" : "pending"} role="listitem" key={run.id}>
                  <div className="pattern-timeline-rail" aria-hidden="true">
                    <span className="pattern-timeline-indicator">
                      {active ? <DashRing className="pattern-timeline-spinner" /> : completed ? <HugeiconsIcon icon={Tick01Icon} size={17} strokeWidth={2} /> : <span className="pattern-timeline-dot" />}
                    </span>
                    {index < latestRuns.length - 1 ? <span className="pattern-timeline-separator" /> : null}
                  </div>
                  <div className="pattern-timeline-content">
                    <div className="pattern-timeline-header">
                      <strong>{title}</strong>
                      <span className={`pattern-run-badge status-pill ${active ? "active" : completed ? "completed" : "pending"}`}>
                        {active ? <DashRing className="status-pill-spinner" aria-hidden="true" /> : <HugeiconsIcon icon={completed ? Tick01Icon : Time02Icon} size={12} strokeWidth={2.2} aria-hidden="true" />}
                        {formatRunDuration(run)}
                      </span>
                    </div>
                    <PatternRunDetails
                      pattern={props.pattern}
                      run={run}
                      active={active}
                      open={!closedRunIds.has(run.id)}
                      onToggle={() => toggleRunDetails(run.id)}
                    />
                  </div>
                </article>
              );
              })}
            </div>
            {sourceRuns.length > latestRuns.length ? <p className="pattern-activity-caption">Last 10 pattern runs.</p> : null}
          </>
        ) : null}
      </div>
    </StandaloneSheetComponent>
  );
}

function PatternRunDetails(props: { pattern: Pattern; run: PatternRun; active: boolean; open: boolean; onToggle: () => void }) {
  return (
    <div className={`pattern-run-frame ${props.open ? "open" : ""}`}>
      <button className="pattern-run-frame-trigger" type="button" aria-expanded={props.open} onClick={props.onToggle}>
        <span>Details</span>
        <HugeiconsIcon className="pattern-run-frame-chevron" icon={ArrowRight01Icon} size={18} strokeWidth={2.1} aria-hidden="true" />
      </button>
      <div className="pattern-run-panel-wrap" aria-hidden={!props.open}>
        <div className="pattern-run-panel">
          <p>{patternRunDescription(props.pattern, props.run)}</p>
          {!props.active ? (
            <span className={`pattern-notify-pill status-pill ${props.run.notifyOutcome?.notify ? "notified" : "not-notified"}`}>
              <HugeiconsIcon icon={props.run.notifyOutcome?.notify ? Notification01Icon : Alert01Icon} size={14} strokeWidth={2} aria-hidden="true" />
              {patternRunNotifyLabel(props.run)}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function PatternListSkeleton() {
  return (
    <div className="skeleton-list" aria-hidden="true">
      {Array.from({ length: 4 }, (_, index) => (
        <article className="automation-card pattern-skeleton-card" key={index}>
          <ContentLoader
            className="skeleton-loader"
            speed={1.8}
            viewBox="0 0 420 94"
            preserveAspectRatio="none"
            title=""
            uniqueKey={`pattern-list-skeleton-${index}`}
            {...skeletonColors}
          >
            <rect x="0" y="0" rx="18" ry="18" width="420" height="94" />
            <rect x="18" y="18" rx="5" ry="5" width={index % 2 === 0 ? 124 : 92} height="14" />
            <rect x="384" y="19" rx="8" ry="8" width="16" height="16" />
            <rect x="18" y="50" rx="5" ry="5" width={index % 2 === 0 ? 330 : 292} height="12" />
            <rect x="18" y="70" rx="5" ry="5" width={index % 2 === 0 ? 252 : 316} height="12" />
          </ContentLoader>
        </article>
      ))}
    </div>
  );
}
