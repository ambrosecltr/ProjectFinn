import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  AccessScope,
  CommandActivityEvent,
  ConnectorConfig,
  ConnectorDetailsResponse,
  PermissionCheck,
  PrivacyPane,
  SavedPuterState,
  SessionResponse,
  SocketStatusEvent,
} from "./types";

export async function savedPuterState(): Promise<SavedPuterState> {
  return invoke<SavedPuterState>("saved_puter_state");
}

export async function deviceId(): Promise<string> {
  return invoke<string>("device_id");
}

export async function configureHost(host: string): Promise<string> {
  return invoke<string>("configure_host", { host });
}

export async function fetchSession(): Promise<SessionResponse> {
  return invoke<SessionResponse>("fetch_session");
}

export async function requestLogin(phoneNumber: string): Promise<void> {
  await invoke("request_login", { input: { phone_number: phoneNumber } });
}

export async function verifyLogin(phoneNumber: string, code: string): Promise<SessionResponse> {
  return invoke<SessionResponse>("verify_login", {
    input: { phone_number: phoneNumber, code },
  });
}

export async function updatePuterConfig(input: {
  device_id: string;
  imessage_enabled?: boolean;
  imessage_personal_intelligence_enabled?: boolean;
  notes_enabled?: boolean;
  notes_personal_intelligence_enabled?: boolean;
}): Promise<{ config: ConnectorConfig }> {
  return invoke<{ config: ConnectorConfig }>("update_puter_config", { input });
}

export async function fetchPuterConfig(): Promise<ConnectorDetailsResponse> {
  return invoke<ConnectorDetailsResponse>("fetch_puter_config");
}

export async function connectPuterSocket(device_id: string): Promise<void> {
  await invoke("connect_puter_socket", { input: { device_id } });
}

export async function disconnectPuterSocket(): Promise<void> {
  await invoke("disconnect_puter_socket");
}

export async function socketStatus(): Promise<SocketStatusEvent> {
  return invoke<SocketStatusEvent>("socket_status");
}

export async function checkAuthorization(scope: AccessScope): Promise<PermissionCheck> {
  return invoke<PermissionCheck>("check_authorization", { scope });
}

export async function requestAuthorization(scope: AccessScope): Promise<PermissionCheck> {
  return invoke<PermissionCheck>("request_authorization", { scope });
}

export async function openPrivacyPane(pane: PrivacyPane): Promise<void> {
  await invoke("open_privacy_pane", { pane });
}

export async function syncAccessStatus(): Promise<void> {
  await invoke("sync_access_status");
}

export async function completeSetup(): Promise<void> {
  await invoke("complete_setup");
}

export async function signOut(): Promise<void> {
  await invoke("sign_out");
}

export function listenForPuterConfig(handler: (config: ConnectorConfig) => void): Promise<() => void> {
  return listenForFrontendEvent("puter_config_updated", handler);
}

export function listenForSocketStatus(handler: (status: SocketStatusEvent) => void): Promise<() => void> {
  return listenForFrontendEvent("puter_socket_status", handler);
}

export function listenForCommandActivity(handler: (activity: CommandActivityEvent) => void): Promise<() => void> {
  return listenForFrontendEvent("puter_command_activity", handler);
}

async function listenForFrontendEvent<T>(eventName: string, handler: (payload: T) => void): Promise<() => void> {
  const eventTarget = globalThis as unknown as {
    addEventListener: (name: string, listener: (event: { detail: T }) => void) => void;
    removeEventListener: (name: string, listener: (event: { detail: T }) => void) => void;
  };
  const customEventHandler = (event: { detail: T }) => {
    handler(event.detail);
  };
  eventTarget.addEventListener(eventName, customEventHandler);

  try {
    const unlisten = await listen<T>(eventName, (event) => handler(event.payload));
    return () => {
      eventTarget.removeEventListener(eventName, customEventHandler);
      unlisten();
    };
  } catch (error) {
    console.warn(`Could not attach Tauri listener for ${eventName}; using webview events only.`, error);
    return () => {
      eventTarget.removeEventListener(eventName, customEventHandler);
    };
  }
}
