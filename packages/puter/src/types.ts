import type { LucideIcon } from "lucide-react";

export interface SavedPuterState {
  host: string | null;
  setupCompleted: boolean;
}

export interface SessionResponse {
  user: {
    displayName: string;
    phoneNumber: string;
    profileImageUrl?: string | null;
  } | null;
}

export interface ConnectorConfig {
  puter?: {
    imessageEnabled: boolean;
    imessagePersonalIntelligenceEnabled: boolean;
    notesEnabled: boolean;
    notesPersonalIntelligenceEnabled: boolean;
  };
}

export interface ConnectorDetailsResponse {
  connector: {
    config: ConnectorConfig;
  };
}

export interface SocketStatusEvent {
  connected: boolean;
  message: string;
}

export interface CommandActivityEvent {
  active: boolean;
  message: string;
  generation?: number;
}

export interface PermissionCheck {
  granted: boolean;
  message: string;
}

export interface AccessState {
  imessage: PermissionCheck | null;
  contacts: PermissionCheck | null;
  notes: PermissionCheck | null;
  accessibility: PermissionCheck | null;
}

export interface SourceState {
  enabled: boolean;
  personalIntelligenceEnabled: boolean;
}

export type SourceKey = "imessage" | "notes";
export type AccessScope = keyof AccessState;
export type PermissionTarget = "full_disk" | "contacts" | "accessibility";
export type SettingsTab = "access" | "personal_intelligence" | "permissions";
export type SettingsDirection = "forward" | "back";
export type Screen = "loading" | "connection_error" | "host" | "login" | "verify" | "setup" | "finish" | "settings";
export type SetupStepId = "full_disk" | "contacts";
export type PrivacyPane = "Privacy_AllFiles" | "Privacy_Contacts" | "Privacy_Accessibility";
export type CountryCode = "AU" | "CN" | "US" | "CA";

export interface SetupStep {
  id: SetupStepId;
  target: PermissionTarget;
  scopes: AccessScope[];
  icon: LucideIcon;
  title: string;
  body: string;
  primaryAction: string;
  hint: string;
  pane?: PrivacyPane;
}
