import {
  useEffect,
  useState,
} from "react";
import {
  Contact,
  MessageCircleMore,
  Notebook,
  ShieldCheck,
  SquareMousePointer,
} from "lucide-react";
import {
  PersonalIntelligenceRow,
  PermissionRow,
  SegmentedTabs,
  SourceAccessRow,
  StatusPill,
} from "./components";
import {
  accessStatusForSource,
  canTogglePersonalIntelligence,
  greetingForDate,
  permissionGranted,
} from "./state";
import type {
  AccessState,
  PermissionTarget,
  SettingsDirection,
  SourceKey,
  SourceState,
} from "./types";
import { settingsTabs } from "./settings-tabs";
import type { SettingsTab } from "./types";

export { settingsTabs } from "./settings-tabs";

export function SettingsView(props: {
  displayName: string;
  activeTab: SettingsTab;
  settingsDirection: SettingsDirection;
  access: AccessState;
  sources: Record<SourceKey, SourceState>;
  busy: boolean;
  connected: boolean;
  highlightedPermission: PermissionTarget | null;
  onTabChange: (tab: SettingsTab) => void;
  onConfigurePermission: (target: PermissionTarget) => void;
  onToggleSource: (source: SourceKey, enabled: boolean) => void;
  onTogglePersonalIntelligence: (source: SourceKey, enabled: boolean) => void;
  onGrantPermission: (target: PermissionTarget) => void;
}) {
  return (
    <>
      <SegmentedTabs tabs={settingsTabs} activeTab={props.activeTab} onChange={props.onTabChange} />
      <section className="settings-page" data-tab={props.activeTab}>
        <div className="settings-tab-panel" key={props.activeTab} data-direction={props.settingsDirection}>
          {props.activeTab === "access" ? <AccessTab {...props} /> : null}
          {props.activeTab === "personal_intelligence" ? <PersonalIntelligenceTab {...props} /> : null}
          {props.activeTab === "permissions" ? <PermissionsTab {...props} /> : null}
        </div>
        <StatusPill connected={props.connected} />
      </section>
    </>
  );
}

function AccessTab(props: {
  displayName: string;
  access: AccessState;
  sources: Record<SourceKey, SourceState>;
  busy: boolean;
  connected: boolean;
  onConfigurePermission: (target: PermissionTarget) => void;
  onToggleSource: (source: SourceKey, enabled: boolean) => void;
}) {
  const greeting = useTimeGreeting();

  return (
    <>
      <h1>{greeting}, {firstName(props.displayName)}.</h1>
      <div className="settings-stack">
        {sourceRows.map((source) => {
          const status = accessStatusForSource(source.id, props.access);
          return (
            <SourceAccessRow
              key={source.id}
              icon={source.icon}
              title={source.title}
              description={source.accessDescription}
              enabled={props.sources[source.id].enabled}
              available={status.available}
              disabled={props.busy || !props.connected}
              onToggle={(enabled) => props.onToggleSource(source.id, enabled)}
              onConfigure={() => props.onConfigurePermission(status.target ?? "full_disk")}
            />
          );
        })}
      </div>
    </>
  );
}

function PersonalIntelligenceTab(props: {
  access: AccessState;
  sources: Record<SourceKey, SourceState>;
  busy: boolean;
  connected: boolean;
  onTogglePersonalIntelligence: (source: SourceKey, enabled: boolean) => void;
}) {
  return (
    <>
      <h1>Personal Intelligence</h1>
      <div className="settings-stack">
        {sourceRows.map((source) => {
          const available = canTogglePersonalIntelligence(source.id, props.sources, props.access);
          return (
            <PersonalIntelligenceRow
              key={source.id}
              title={source.title}
              description={source.piDescription}
              enabled={props.sources[source.id].personalIntelligenceEnabled}
              available={available}
              disabled={props.busy || !props.connected}
              onToggle={(enabled) => props.onTogglePersonalIntelligence(source.id, enabled)}
            />
          );
        })}
      </div>
    </>
  );
}

function PermissionsTab(props: {
  access: AccessState;
  busy: boolean;
  highlightedPermission: PermissionTarget | null;
  onGrantPermission: (target: PermissionTarget) => void;
}) {
  const fullDiskGranted = permissionGranted(props.access.imessage) || permissionGranted(props.access.notes);

  return (
    <>
      <h1>Permissions</h1>
      <div className="settings-stack">
        <PermissionRow
          target="full_disk"
          title="Full disk access"
          description="In order to read your iMessages and Notes, Puter requires full disk access. Puter does not access any other information on your Mac, this is just a macOS requirement. Puter will never write, only read."
          granted={fullDiskGranted}
          disabled={props.busy}
          highlighted={props.highlightedPermission === "full_disk"}
          onGrant={() => props.onGrantPermission("full_disk")}
        />
        <PermissionRow
          target="contacts"
          title="Contact access"
          description="Puter uses your Contacts to better understand who you are messaging and who is messaging you. Puter will never create, update, or delete your contacts."
          granted={permissionGranted(props.access.contacts)}
          disabled={props.busy}
          highlighted={props.highlightedPermission === "contacts"}
          onGrant={() => props.onGrantPermission("contacts")}
        />
        <PermissionRow
          target="accessibility"
          title="Accessibility"
          description="Accessibility access is needed for Computer Use. This allows Puter to control apps on your Mac."
          granted={permissionGranted(props.access.accessibility)}
          disabled={props.busy}
          highlighted={props.highlightedPermission === "accessibility"}
          onGrant={() => props.onGrantPermission("accessibility")}
        />
      </div>
    </>
  );
}

const sourceRows = [
  {
    id: "imessage" as const,
    title: "iMessage",
    icon: MessageCircleMore,
    accessDescription: "Allow Finn to access iMessages on your Mac.",
    piDescription: "Allow personal intelligence to use your iMessages to build personal knowledge and understanding of you and your daily life.",
  },
  {
    id: "notes" as const,
    title: "Notes",
    icon: Notebook,
    accessDescription: "Allow Finn to access Notes on your Mac.",
    piDescription: "Allow personal intelligence to use your Notes to build personal knowledge and understanding of you and your daily life.",
  },
];

export const permissionIcons = {
  full_disk: ShieldCheck,
  contacts: Contact,
  accessibility: SquareMousePointer,
};

function firstName(displayName: string): string {
  return displayName.trim().split(/\s+/)[0] || displayName;
}

function useTimeGreeting(): string {
  const [greeting, setGreeting] = useState(() => greetingForDate(new Date()));

  useEffect(() => {
    const refreshGreeting = () => setGreeting(greetingForDate(new Date()));
    const timer = window.setInterval(refreshGreeting, 60_000);
    refreshGreeting();
    return () => window.clearInterval(timer);
  }, []);

  return greeting;
}
