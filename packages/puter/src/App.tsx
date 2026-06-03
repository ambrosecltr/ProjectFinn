import { useEffect, useRef, useState } from "react";
import {
  ConnectionError,
  OnboardingFinish,
  OnboardingHost,
  OnboardingLogin,
  OnboardingPermissionStep,
  OnboardingVerify,
  onboardingSteps,
} from "./onboarding";
import { formatPhoneForCountry, normalizePhoneForCountry } from "./phone";
import { SettingsView } from "./settings";
import {
  accessStatusForSource,
  allAccessScopes,
  emptyAccess,
  emptySources,
  mergeAccess,
  sourcesFromConnectorConfig,
} from "./state";
import * as puter from "./tauri";
import type {
  AccessScope,
  AccessState,
  ConnectorConfig,
  CountryCode,
  PermissionTarget,
  Screen,
  SessionResponse,
  SettingsDirection,
  SettingsTab,
  SetupStep,
  SetupStepId,
  SocketStatusEvent,
  SourceKey,
  SourceState,
} from "./types";

const disconnectedStatus: SocketStatusEvent = {
  connected: false,
  message: "Disconnected from Finn.",
};

const settingsTabOrder: SettingsTab[] = ["access", "personal_intelligence", "permissions"];

export function App() {
  const [screen, setScreen] = useState<Screen>("loading");
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("access");
  const [settingsDirection, setSettingsDirection] = useState<SettingsDirection>("forward");
  const [highlightedPermission, setHighlightedPermission] = useState<PermissionTarget | null>(null);
  const [host, setHost] = useState("");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [countryCode, setCountryCode] = useState<CountryCode>("AU");
  const [submittedPhoneNumber, setSubmittedPhoneNumber] = useState("");
  const [code, setCode] = useState("");
  const [session, setSession] = useState<SessionResponse | null>(null);
  const [currentDeviceId, setCurrentDeviceId] = useState("");
  const [sources, setSources] = useState<Record<SourceKey, SourceState>>(emptySources);
  const [access, setAccess] = useState<AccessState>(emptyAccess);
  const [activeSetupStep, setActiveSetupStep] = useState<SetupStepId>("full_disk");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [socketStatus, setSocketStatus] = useState<SocketStatusEvent>(disconnectedStatus);
  const accessCheckInFlight = useRef(false);
  const bootStarted = useRef(false);
  const socketConnectedRef = useRef(false);
  const accessRef = useRef<AccessState>(emptyAccess);

  const authenticated = Boolean(session?.user);
  const displayName = session?.user?.displayName?.trim() || "there";
  const socketConnected = socketStatus.connected;
  const usingExplicitHttpHost = host.trim().toLowerCase().startsWith("http://");

  useEffect(() => {
    if (bootStarted.current) {
      return;
    }
    bootStarted.current = true;
    void boot();
  }, []);

  useEffect(() => {
    accessRef.current = access;
  }, [access]);

  useEffect(() => {
    let disposed = false;
    let unlistenConfig: (() => void) | undefined;
    let unlistenSocketStatus: (() => void) | undefined;

    void puter.listenForPuterConfig(applyConnectorConfig).then((cleanup) => {
      if (disposed) cleanup();
      else unlistenConfig = cleanup;
    }).catch((error: unknown) => {
      console.warn("Could not listen for Finn Puter config events.", error);
    });

    void puter.listenForSocketStatus(applySocketStatus).then((cleanup) => {
      if (disposed) cleanup();
      else unlistenSocketStatus = cleanup;
    }).catch((error: unknown) => {
      console.warn("Could not listen for Finn Puter socket events.", error);
    });

    return () => {
      disposed = true;
      unlistenConfig?.();
      unlistenSocketStatus?.();
    };
  }, []);

  async function boot() {
    setBusy(true);
    setScreen("loading");
    setNotice("");
    let savedHost: string | null = null;

    try {
      const [saved, nextDeviceId] = await Promise.all([
        puter.savedPuterState(),
        puter.deviceId(),
      ]);
      savedHost = saved.host;
      setCurrentDeviceId(nextDeviceId);

      if (!saved.host) {
        setScreen("host");
        return;
      }

      setHost(saved.host);
      const current = await puter.fetchSession();
      setSession(current);
      if (!current.user) {
        setScreen("login");
        return;
      }

      await pairDevice(nextDeviceId);
      void connectSocket(nextDeviceId);
      const nextAccess = await refreshAccess(allAccessScopes, { quiet: true });

      if (saved.setupCompleted) {
        accessRef.current = nextAccess;
        setScreen("settings");
        return;
      }

      setActiveSetupStep(firstMissingOnboardingStep(nextAccess));
      setScreen("setup");
    } catch (error) {
      setSocketStatus(disconnectedStatus);
      await puter.disconnectPuterSocket().catch(() => undefined);
      if (savedHost || await hasSavedHost()) {
        setScreen("connection_error");
        setNotice(getErrorMessage(error));
      } else {
        setScreen("host");
      }
    } finally {
      setBusy(false);
    }
  }

  async function saveHost() {
    setBusy(true);
    setNotice("");
    try {
      const configured = await puter.configureHost(host);
      setHost(configured);
      const current = await puter.fetchSession().catch(() => ({ user: null }));
      setSession(current);
      if (!current.user) {
        setScreen("login");
        return;
      }

      const nextDeviceId = currentDeviceId || await puter.deviceId();
      setCurrentDeviceId(nextDeviceId);
      await pairDevice(nextDeviceId);
      void connectSocket(nextDeviceId);
      const nextAccess = await refreshAccess(allAccessScopes, { quiet: true });
      setActiveSetupStep(firstMissingOnboardingStep(nextAccess));
      setScreen("setup");
    } catch (error) {
      setNotice(getErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function requestCode() {
    const normalizedPhoneNumber = normalizePhoneForCountry(phoneNumber, countryCode);
    if (!normalizedPhoneNumber) {
      setNotice("Enter your phone number.");
      return;
    }

    setBusy(true);
    setNotice("");
    try {
      await puter.requestLogin(normalizedPhoneNumber);
      setSubmittedPhoneNumber(normalizedPhoneNumber);
      setScreen("verify");
    } catch (error) {
      setNotice(getErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function verifyCode() {
    const normalizedPhoneNumber = submittedPhoneNumber || normalizePhoneForCountry(phoneNumber, countryCode);
    setBusy(true);
    setNotice("");
    try {
      const nextSession = await puter.verifyLogin(normalizedPhoneNumber, code);
      setSession(nextSession);
      const nextDeviceId = currentDeviceId || await puter.deviceId();
      setCurrentDeviceId(nextDeviceId);
      await pairDevice(nextDeviceId);
      void connectSocket(nextDeviceId);
      const nextAccess = await refreshAccess(allAccessScopes, { quiet: true });
      setActiveSetupStep(firstMissingOnboardingStep(nextAccess));
      setScreen("setup");
    } catch (error) {
      setNotice(getErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function pairDevice(nextDeviceId = currentDeviceId): Promise<ConnectorConfig | null> {
    if (!nextDeviceId) {
      return null;
    }
    const result = await puter.updatePuterConfig({ device_id: nextDeviceId });
    applyConnectorConfig(result.config);
    return result.config;
  }

  async function refreshPuterConfig() {
    const result = await puter.fetchPuterConfig();
    applyConnectorConfig(result.connector.config);
  }

  async function connectSocket(nextDeviceId = currentDeviceId) {
    if (!nextDeviceId) {
      setNotice("Could not identify this Mac.");
      return;
    }

    setSocketStatus({ connected: false, message: "Connecting to Finn." });
    try {
      await puter.connectPuterSocket(nextDeviceId);
      const status = await waitForSocketStatus();
      if (status) {
        applySocketStatus(status);
      }
    } catch (error) {
      setSocketStatus({ connected: false, message: getErrorMessage(error) });
    }
  }

  function applySocketStatus(nextStatus: SocketStatusEvent) {
    const wasConnected = socketConnectedRef.current;
    socketConnectedRef.current = nextStatus.connected;
    setSocketStatus(nextStatus);
    if (nextStatus.connected && !wasConnected) {
      void refreshPuterConfig().catch((error: unknown) => {
        console.warn("Could not refresh Finn Puter config after socket connected.", error);
      });
    }
  }

  async function waitForSocketStatus(timeoutMs = 10_000): Promise<SocketStatusEvent | null> {
    const deadline = Date.now() + timeoutMs;
    let latest: SocketStatusEvent | null = null;

    while (Date.now() < deadline) {
      const status = await puter.socketStatus().catch(() => null);
      if (status) {
        latest = status;
        applySocketStatus(status);
        if (status.connected || socketStatusSettled(status.message)) {
          return status;
        }
      }
      await sleep(250);
    }

    return latest;
  }

  function applyConnectorConfig(config: ConnectorConfig) {
    setSources(sourcesFromConnectorConfig(config));
  }

  function changeCountry(nextCountryCode: CountryCode) {
    setCountryCode(nextCountryCode);
    setPhoneNumber((current) => formatPhoneForCountry(current, nextCountryCode));
  }

  async function refreshAccess(scopes: AccessScope[], options: { quiet?: boolean } = {}): Promise<AccessState> {
    if (accessCheckInFlight.current) {
      return accessRef.current;
    }

    accessCheckInFlight.current = true;
    if (!options.quiet) {
      setBusy(true);
      setNotice("");
    }

    try {
      const results = await Promise.all(scopes.map(async (scope) => {
        const result = await puter.checkAuthorization(scope);
        return [scope, result] as const;
      }));
      const resultsMap = Object.fromEntries(results) as Partial<AccessState>;
      const nextAccess: AccessState = { ...accessRef.current, ...resultsMap };
      accessRef.current = nextAccess;
      setAccess(nextAccess);
      void puter.syncAccessStatus().catch((error: unknown) => {
        console.warn("Could not sync Finn Puter access status.", error);
      });
      return nextAccess;
    } catch (error) {
      if (!options.quiet) {
        setNotice(getErrorMessage(error));
      }
      return accessRef.current;
    } finally {
      accessCheckInFlight.current = false;
      if (!options.quiet) {
        setBusy(false);
      }
    }
  }

  async function runSetupStep(step: SetupStep) {
    setBusy(true);
    setNotice("");
    try {
      await grantPermission(step.target);
      const nextAccess = await refreshAccess(step.scopes, { quiet: true });
      const nextStep = nextSetupStepAfter(step.id, nextAccess);
      if (nextStep) {
        setActiveSetupStep(nextStep);
      } else {
        await completeOnboarding();
      }
    } catch (error) {
      setNotice(getErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  function skipSetupStep() {
    const nextStep = nextSetupStepAfter(activeSetupStep, accessRef.current);
    if (nextStep) {
      setActiveSetupStep(nextStep);
    } else {
      void completeOnboarding();
    }
  }

  async function completeOnboarding() {
    setBusy(true);
    try {
      await puter.completeSetup();
      setScreen("finish");
    } catch (error) {
      setNotice(getErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  function openSettings() {
    setSettingsDirection("forward");
    setSettingsTab("access");
    setScreen("settings");
  }

  function changeSettingsTab(nextTab: SettingsTab) {
    if (nextTab === settingsTab) {
      return;
    }

    const currentIndex = settingsTabOrder.indexOf(settingsTab);
    const nextIndex = settingsTabOrder.indexOf(nextTab);
    setSettingsDirection(nextIndex > currentIndex ? "forward" : "back");
    setSettingsTab(nextTab);
  }

  async function grantPermission(target: PermissionTarget) {
    if (target === "full_disk") {
      await puter.openPrivacyPane("Privacy_AllFiles");
      return;
    }
    if (target === "contacts") {
      const result = await puter.requestAuthorization("contacts");
      const nextAccess = mergeAccess(accessRef.current, "contacts", result);
      accessRef.current = nextAccess;
      setAccess(nextAccess);
      void puter.syncAccessStatus().catch(() => undefined);
      if (!result.granted) {
        await puter.openPrivacyPane("Privacy_Contacts").catch(() => undefined);
      }
      return;
    }
    await puter.openPrivacyPane("Privacy_Accessibility");
  }

  function configurePermission(target: PermissionTarget) {
    changeSettingsTab("permissions");
    setHighlightedPermission(target);
    window.setTimeout(() => {
      setHighlightedPermission((current) => current === target ? null : current);
    }, 1_600);
  }

  async function updateSource(source: SourceKey, enabled: boolean) {
    if (!socketConnected) {
      setNotice("Puter is reconnecting. Wait until it is connected before changing settings.");
      return;
    }
    const status = accessStatusForSource(source, access);
    if (!status.available) {
      configurePermission(status.target ?? "full_disk");
      return;
    }

    setBusy(true);
    setNotice("");
    const nextSource = {
      ...sources[source],
      enabled,
      personalIntelligenceEnabled: enabled ? sources[source].personalIntelligenceEnabled : false,
    };

    try {
      const result = await puter.updatePuterConfig({
        device_id: currentDeviceId,
        imessage_enabled: source === "imessage" ? nextSource.enabled : undefined,
        imessage_personal_intelligence_enabled: source === "imessage" ? nextSource.personalIntelligenceEnabled : undefined,
        notes_enabled: source === "notes" ? nextSource.enabled : undefined,
        notes_personal_intelligence_enabled: source === "notes" ? nextSource.personalIntelligenceEnabled : undefined,
      });
      applyConnectorConfig(result.config);
    } catch (error) {
      setNotice(getErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function updatePersonalIntelligence(source: SourceKey, enabled: boolean) {
    if (!socketConnected) {
      setNotice("Puter is reconnecting. Wait until it is connected before changing settings.");
      return;
    }

    setBusy(true);
    setNotice("");
    try {
      const result = await puter.updatePuterConfig({
        device_id: currentDeviceId,
        imessage_personal_intelligence_enabled: source === "imessage" ? enabled : undefined,
        notes_personal_intelligence_enabled: source === "notes" ? enabled : undefined,
      });
      applyConnectorConfig(result.config);
    } catch (error) {
      setNotice(getErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function changeHost() {
    await puter.disconnectPuterSocket().catch(() => undefined);
    setSocketStatus(disconnectedStatus);
    setScreen("host");
  }

  const setupStep = onboardingSteps.find((step) => step.id === activeSetupStep) ?? onboardingSteps[0];

  return (
    <main className="puter-shell" data-screen={screen}>
      {screen === "loading" ? (
        <div className="loading-screen" role="status" aria-label="Loading Finn Puter">
          <span className="puter-spinner" aria-hidden="true" />
        </div>
      ) : null}

      {screen === "connection_error" ? (
        <ConnectionError message={notice} busy={busy} onRetry={() => void boot()} onChangeHost={() => void changeHost()} />
      ) : null}

      {screen === "host" ? (
        <OnboardingHost host={host} busy={busy} explicitHttp={usingExplicitHttpHost} onHostChange={setHost} onSubmit={() => void saveHost()} />
      ) : null}

      {screen === "login" ? (
        <OnboardingLogin
          phoneNumber={phoneNumber}
          countryCode={countryCode}
          busy={busy}
          onPhoneNumberChange={setPhoneNumber}
          onCountryChange={changeCountry}
          onSubmit={() => void requestCode()}
        />
      ) : null}

      {screen === "verify" ? (
        <OnboardingVerify code={code} busy={busy} onCodeChange={setCode} onSubmit={() => void verifyCode()} />
      ) : null}

      {screen === "setup" ? (
        <OnboardingPermissionStep
          key={setupStep.id}
          step={setupStep}
          busy={busy}
          onPrimary={() => void runSetupStep(setupStep)}
          onSkip={skipSetupStep}
        />
      ) : null}

      {screen === "finish" ? (
        <OnboardingFinish busy={busy} onGetStarted={openSettings} />
      ) : null}

      {screen === "settings" ? (
        <SettingsView
          displayName={displayName}
          activeTab={settingsTab}
          settingsDirection={settingsDirection}
          access={access}
          sources={sources}
          busy={busy}
          connected={authenticated && socketConnected}
          highlightedPermission={highlightedPermission}
          onTabChange={changeSettingsTab}
          onConfigurePermission={configurePermission}
          onToggleSource={(source, enabled) => void updateSource(source, enabled)}
          onTogglePersonalIntelligence={(source, enabled) => void updatePersonalIntelligence(source, enabled)}
          onGrantPermission={(target) => void grantPermission(target)}
        />
      ) : null}

      {notice && screen !== "connection_error" ? <p className="status-message">{notice}</p> : null}
    </main>
  );
}

function firstMissingOnboardingStep(access: AccessState): SetupStepId {
  return onboardingSteps.find((step) => !step.scopes.every((scope) => access[scope]?.granted))?.id ?? "full_disk";
}

function nextSetupStepAfter(current: SetupStepId, access: AccessState): SetupStepId | null {
  const index = onboardingSteps.findIndex((step) => step.id === current);
  const next = onboardingSteps.slice(index + 1).find((step) => !step.scopes.every((scope) => access[scope]?.granted));
  if (next) {
    return next.id;
  }
  return null;
}

async function hasSavedHost(): Promise<boolean> {
  const saved = await puter.savedPuterState().catch(() => null);
  return Boolean(saved?.host);
}

function socketStatusSettled(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes("could not connect")
    || normalized.includes("disconnected")
    || normalized.includes("waiting for finn");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
