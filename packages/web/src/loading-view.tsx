import { DashRing } from "./components/loading-ui/dash-ring";

export function LoadingView(props: { label: string }) {
  return (
    <div className="loading-view" role="status" aria-live="polite">
      <DashRing className="loading-view-spinner" aria-hidden="true" />
      <span>{props.label}</span>
    </div>
  );
}
