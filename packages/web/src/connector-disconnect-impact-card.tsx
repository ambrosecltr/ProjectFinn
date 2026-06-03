import { Alert01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

import { DashRing } from "./components/loading-ui/dash-ring";
import type { ConnectorDisconnectImpact } from "./web-types";

export function ConnectorDisconnectImpactCard(props: {
  impact: ConnectorDisconnectImpact | null;
  loading: boolean;
}) {
  if (props.loading) {
    return (
      <div className="connector-impact-card">
        <DashRing className="connector-impact-spinner" aria-hidden="true" />
        <span>Checking Pattern impact...</span>
      </div>
    );
  }
  if (!props.impact || props.impact.patterns.length === 0) {
    return null;
  }

  const connectorName = props.impact.toolkitName || props.impact.toolkitSlug;
  const pausedCount = props.impact.patterns.length;
  const triggerCount = props.impact.triggerPatterns.length;
  const scheduledCount = props.impact.scheduledPatterns.length;

  return (
    <div className="connector-impact-card">
      <HugeiconsIcon className="connector-impact-icon" icon={Alert01Icon} size={19} strokeWidth={2} aria-hidden="true" />
      <div className="connector-impact-copy">
        <strong>{pausedCount} Pattern{pausedCount === 1 ? "" : "s"} will be paused</strong>
        <span>
          {triggerCount > 0 ? `${triggerCount} app-triggered Pattern${triggerCount === 1 ? "" : "s"} will have ${triggerCount === 1 ? "its" : "their"} Composio trigger recreated after reconnect. ` : ""}
          {scheduledCount > 0 ? `${scheduledCount} scheduled Pattern${scheduledCount === 1 ? "" : "s"} will wait for ${connectorName} to reconnect.` : ""}
        </span>
      </div>
    </div>
  );
}
