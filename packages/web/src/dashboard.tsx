import {
  ActivitySparkIcon,
  Calendar02Icon,
  File02Icon,
  Message01Icon,
  Share07Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { CSSProperties } from "react";

import brandMarkUrl from "./assets/icon_transparent_black.png";
import { DashRing } from "./components/loading-ui/dash-ring";
import { HapticSwitchOverlay } from "./haptics";
import type { ActiveSheet, AppTheme, UserProfile } from "./web-types";
import { buildTextFinnHref, capitalizeFirst, preloadedImageStyle } from "./web-utils";

export function FinnMark() {
  return <img className="finn-mark app-image" src={brandMarkUrl} alt="" draggable={false} />;
}

function ThemeSceneImage(props: { className: string; theme: AppTheme }) {
  return (
    <picture className="hero-scene-picture">
      <img
        className={`${props.className} app-image`}
        src={props.theme.backgroundUrl}
        alt=""
        draggable={false}
        style={{ transform: `scale(${props.theme.imageScale})` }}
      />
    </picture>
  );
}

export function Dashboard(props: {
  user: UserProfile;
  theme: AppTheme;
  dayLabel: string;
  greeting: string;
  weatherText: string;
  weatherLoading: boolean;
  finnPhoneNumber: string;
  onOpenSheet: (sheet: ActiveSheet) => void;
  onTextFinnClick: () => void;
}) {
  const displayName = props.user.displayName.trim();
  const greetingName = displayName ? capitalizeFirst(displayName) : "";
  const textFinnHref = props.finnPhoneNumber ? buildTextFinnHref(props.finnPhoneNumber) : null;
  const dashboardStyle = {
    "--dashboard-chrome-color": props.theme.chromeColor,
    "--dashboard-chrome-rgb": props.theme.chromeRgb.join(" "),
    "--dashboard-foreground-color": props.theme.foregroundColor,
    "--dashboard-foreground-muted-color": props.theme.foregroundMutedColor,
    "--dashboard-menu-text-color": props.theme.menuTextColor,
    "--dashboard-menu-surface-color": props.theme.menuSurfaceColor,
    "--dashboard-menu-border-color": props.theme.menuBorderColor,
    "--dashboard-topbar-date-color": props.theme.topbarDateColor,
    "--dashboard-logo-filter": props.theme.logoFilter,
    "--dashboard-scene-filter": props.theme.sceneFilter,
  } as CSSProperties;

  return (
    <main className={`dashboard dashboard-theme-${props.theme.name}`} style={dashboardStyle}>
      <section className="dashboard-scene-panel">
        <ThemeSceneImage className="dashboard-hero-image" theme={props.theme} />
        <div className="dashboard-scene-shader" aria-hidden="true" />
        <header className="topbar dashboard-topbar">
          <FinnMark />
          <time>{props.dayLabel}</time>
          <button className="avatar-button haptic-switch-target" onClick={() => props.onOpenSheet("settings")} aria-label="Open profile settings">
            {props.user.profileImageUrl ? (
              <span className="dashboard-avatar-image app-image" style={preloadedImageStyle(props.user.profileImageUrl)} aria-hidden="true" />
            ) : (
              (displayName[0] || "A").toUpperCase()
            )}
            <HapticSwitchOverlay />
          </button>
        </header>
        <div className="greeting">
          <h1 className="dashboard-greeting-title">{greetingName ? `${props.greeting}, ${greetingName}` : props.greeting}</h1>
          <p className="dashboard-weather-text">
            {props.weatherLoading ? (
              <>
                <span>Fetching weather</span>
                <DashRing className="dashboard-weather-spinner" aria-hidden="true" />
              </>
            ) : props.weatherText}
          </p>
        </div>
      </section>
      <nav className="menu-panel" aria-label="Finn dashboard">
        <div className="menu-row menu-row-primary">
          <button className="menu-card haptic-switch-target" type="button" onClick={() => props.onOpenSheet("my-day")}>
            <HugeiconsIcon className="menu-icon" icon={Calendar02Icon} size={23} strokeWidth={1.8} />
            <span>My day</span>
            <HapticSwitchOverlay />
          </button>
          <button className="menu-card haptic-switch-target" onClick={() => props.onOpenSheet("patterns")}>
            <HugeiconsIcon className="menu-icon" icon={ActivitySparkIcon} size={23} strokeWidth={1.8} />
            <span>Patterns</span>
            <HapticSwitchOverlay />
          </button>
        </div>
        <div className="menu-row menu-row-secondary">
          <button className="menu-card haptic-switch-target" type="button" onClick={() => props.onOpenSheet("library")}>
            <HugeiconsIcon className="menu-icon" icon={File02Icon} size={23} strokeWidth={1.8} />
            <span>Library</span>
            <HapticSwitchOverlay />
          </button>
          <button className="menu-card haptic-switch-target" onClick={() => props.onOpenSheet("connectors")}>
            <HugeiconsIcon className="menu-icon" icon={Share07Icon} size={23} strokeWidth={1.8} />
            <span>Connectors</span>
            <HapticSwitchOverlay />
          </button>
          {textFinnHref ? (
            <a className="menu-card menu-card-link haptic-switch-target" href={textFinnHref} onClick={props.onTextFinnClick}>
              <HugeiconsIcon className="menu-icon" icon={Message01Icon} size={23} strokeWidth={1.8} />
              <span>Text Finn</span>
              <HapticSwitchOverlay />
            </a>
          ) : (
            <button className="menu-card haptic-switch-target" type="button" disabled>
              <HugeiconsIcon className="menu-icon" icon={Message01Icon} size={23} strokeWidth={1.8} />
              <span>Text Finn</span>
              <HapticSwitchOverlay disabled />
            </button>
          )}
        </div>
      </nav>
    </main>
  );
}
