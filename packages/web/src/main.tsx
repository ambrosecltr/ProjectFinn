import {
  ArrowRight01Icon,
  ArrowDown01Icon,
  ArrowUp01Icon,
  Activity03Icon,
  Calendar01Icon,
  LockedIcon,
  Tick01Icon,
  Delete02Icon,
  Delete03Icon,
  Notification01Icon,
  PauseIcon,
  PlayIcon,
  Refresh04Icon,
  Time02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { Sheet as SilkSheet, SheetStack as SilkSheetStack } from "@silk-hq/components";
import "@silk-hq/components/layered-styles.css";
import { StrictMode, Suspense, lazy, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { toast } from "react-hot-toast";
import { AnimatePresence, LayoutGroup, motion, type TargetAndTransition } from "motion/react";
import "@fontsource-variable/nunito-sans/standard.css";
import {
  dashboardClockParts,
  getAuthGreeting,
  getThemeForDate,
  getWeatherSummary,
  preloadImageSource,
  profileHeaderUrl,
  setAppClosedChrome,
  setSheetBackdropProgress,
  suggestHomeLocation,
} from "./app-environment";
import { AppBackground, AuthTopBar, installDisplayModeAttribute, preventImageInteractions } from "./app-shell";
import { LoginScreen, SignupHandoffScreen, VerifyScreen } from "./auth-screens";
import { Button } from "./components/ui/button";
import { cn } from "./lib/utils";
import { isSupportedTimeZone } from "./lib/timezones";
import { puterPatchMatchesConfig } from "./connector-config-utils";
import { ConnectorDisconnectImpactCard } from "./connector-disconnect-impact-card";
import { Dashboard } from "./dashboard";
import {
  createOnboardingDemoConnectors,
  createOnboardingDemoUser,
  demoConnector,
  demoMcpServers,
  demoMyDayPage,
  demoPatternRuns,
  demoPatterns,
  demoSpectrumAssignedPhoneNumber,
  testDashboardUser,
} from "./demo-data";
import { LoadingView } from "./loading-view";
import { connectorNameForSlug, getInitialOnboardingStep, type OnboardingStep } from "./onboarding-utils";
import { PageTransition, useOrderedPageDirection } from "./page-transition";
import { patternRunsEqual } from "./pattern-run-utils";
import { formatPhoneForCountry, inferCountryCodeFromPhone, normalizePhoneForCountry } from "./phone-utils";
import { appPathForSheet, normalizePathSheet } from "./sheet-routing";
import { AppToaster, ConfirmSheet, SheetFrame, StandaloneSheet, type SheetFrameProps } from "./sheet-shell";
import { ensureHapticBridge, removeHapticBridge, triggerHapticFeedback } from "./haptics";
import { api } from "./web-api";
import type {
  ActiveSheet,
  Connector,
  ConnectorConfig,
  ConnectorConfigPatch,
  ConnectorDetails,
  ConnectorDisconnectImpact,
  ConnectorPage,
  CountryCode,
  LibraryFile,
  LibraryFolder,
  LibraryPage,
  McpServer,
  McpServerDraft,
  McpServerPage,
  MyDayPage,
  MyDayTodo,
  Pattern,
  PatternPage,
  PatternRun,
  PatternRunPage,
  ProfileFieldName,
  ProfilePatch,
  SettingsView,
  UserProfile,
} from "./web-types";
import { buildTextFinnHref } from "./web-utils";
import "./index.css";

interface SessionResponse {
  user: UserProfile | null;
  finnPhoneNumber: string;
}

interface RequestCodeResponse {
  ok: true;
  isNewUser: boolean;
}

type PendingConnectorDelete =
  | { type: "connector"; slug: string; name: string }
  | { type: "mcp"; id: string; name: string };
type PendingMyDayTodoAction = { type: "delete"; todo: MyDayTodo };
type Screen = "loading" | "login" | "verify" | "signup-handoff" | "dashboard";

const settingsViewValues = ["menu", "profile", "settings"] as const satisfies readonly SettingsView[];

const toastMessages = {
  genericError: "Something went wrong.",
  profileSaved: "Settings updated",
  profileSaving: "Saving settings...",
  profileImageSaved: "Profile image updated",
} as const;

const SettingsSheet = lazy(() => import("./settings-sheet").then(({ SettingsSheet }) => ({ default: SettingsSheet })));
const LibrarySheet = lazy(() => import("./library-sheet").then(({ LibrarySheet }) => ({ default: LibrarySheet })));
const PatternsSheet = lazy(() => import("./patterns-sheet").then(({ PatternsSheet }) => ({ default: PatternsSheet })));
const PatternActivitySheet = lazy(() => import("./patterns-sheet").then(({ PatternActivitySheet }) => ({ default: PatternActivitySheet })));
const ConnectorsSheet = lazy(() => import("./connectors-sheet").then(({ ConnectorsSheet }) => ({ default: ConnectorsSheet })));
const OnboardingSheet = lazy(() => import("./onboarding-sheet").then(({ OnboardingSheet }) => ({ default: OnboardingSheet })));
const MyDaySheet = lazy(() => import("./my-day-sheet").then(({ MyDaySheet }) => ({ default: MyDaySheet })));
const TimeZoneSheet = lazy(() => import("./timezone-sheet").then(({ TimeZoneSheet }) => ({ default: TimeZoneSheet })));

function getErrorMessage(error: unknown, fallback: string = toastMessages.genericError): string {
  return error instanceof Error ? error.message : fallback;
}

function notifyError(error: unknown, fallback: string = toastMessages.genericError): string {
  const message = getErrorMessage(error, fallback);
  toast.error(message);
  return message;
}

function Sheet(props: SheetFrameProps) {
  return <SheetFrame {...props} onTravelProgress={setSheetBackdropProgress} />;
}

function App() {
  const searchParams = new URLSearchParams(window.location.search);
  const showTestDashboard = import.meta.env.DEV && searchParams.get("testDashboard") === "1";
  const showOnboardingDemo = import.meta.env.DEV && window.location.pathname === "/onboarding-demo";
  const showDemoSession = showTestDashboard || showOnboardingDemo;
  const showDemoData = showOnboardingDemo || (showTestDashboard && searchParams.get("demoData") === "1");
  const [screen, setScreen] = useState<Screen>(showDemoSession ? "dashboard" : "loading");
  const [sheet, setSheet] = useState<ActiveSheet>(normalizePathSheet);
  const [mountedSheet, setMountedSheet] = useState<ActiveSheet>(sheet);
  const [sheetRenderKey, setSheetRenderKey] = useState(0);
  const [user, setUser] = useState<UserProfile | null>(() => {
    if (showOnboardingDemo) return createOnboardingDemoUser();
    if (showTestDashboard) return testDashboardUser;
    return null;
  });
  const [countryCode, setCountryCode] = useState<CountryCode>("AU");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [submittedPhoneNumber, setSubmittedPhoneNumber] = useState("");
  const [authFlowIsNewUser, setAuthFlowIsNewUser] = useState(false);
  const [code, setCode] = useState("");
  const [authLoading, setAuthLoading] = useState(false);
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileSavingField, setProfileSavingField] = useState<ProfileFieldName | null>(null);
  const [profileImageUploading, setProfileImageUploading] = useState(false);
  const [onboardingStep, setOnboardingStep] = useState<OnboardingStep>("welcome");
  const [onboardingCompleting, setOnboardingCompleting] = useState(false);
  const [connectors, setConnectors] = useState<Connector[]>(() => {
    if (showOnboardingDemo) return createOnboardingDemoConnectors();
    if (showDemoData) return [demoConnector];
    return [];
  });
  const [mcpServers, setMcpServers] = useState<McpServer[]>(showDemoData ? demoMcpServers : []);
  const [myDayPage, setMyDayPage] = useState<MyDayPage | null>(showDemoData ? demoMyDayPage() : null);
  const [myDayLoading, setMyDayLoading] = useState(false);
  const [myDaySavingTodoIds, setMyDaySavingTodoIds] = useState<Set<string>>(() => new Set());
  const [pendingMyDayTodoAction, setPendingMyDayTodoAction] = useState<PendingMyDayTodoAction | null>(null);
  const [libraryPage, setLibraryPage] = useState<LibraryPage | null>(null);
  const [libraryFolderId, setLibraryFolderId] = useState<string | null>(null);
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [librarySaving, setLibrarySaving] = useState(false);
  const [connectorLoading, setConnectorLoading] = useState(false);
  const [mcpLoading, setMcpLoading] = useState(false);
  const [connectorLoadingMore, setConnectorLoadingMore] = useState(false);
  const [connectorCursor, setConnectorCursor] = useState<string | null>(null);
  const [selectedConnectorSlug, setSelectedConnectorSlug] = useState<string | null>(null);
  const [selectedConnector, setSelectedConnector] = useState<ConnectorDetails | null>(null);
  const [selectedMcpServerId, setSelectedMcpServerId] = useState<string | null>(null);
  const [addingMcpServer, setAddingMcpServer] = useState(false);
  const [selectedConnectorLoading, setSelectedConnectorLoading] = useState(false);
  const [connectorConfigSaving, setConnectorConfigSaving] = useState(false);
  const [mcpServerSaving, setMcpServerSaving] = useState(false);
  const [patterns, setPatterns] = useState<Pattern[]>(showDemoData ? demoPatterns : []);
  const [patternLoading, setPatternLoading] = useState(false);
  const [pendingDeletePattern, setPendingDeletePattern] = useState<Pattern | null>(null);
  const [activityPattern, setActivityPattern] = useState<Pattern | null>(null);
  const [pausingPatternIds, setPausingPatternIds] = useState<Set<string>>(() => new Set());
  const [patternRuns, setPatternRuns] = useState<Record<string, PatternRun[]>>({});
  const [patternRunsLoading, setPatternRunsLoading] = useState<Record<string, boolean>>({});
  const [pendingConnectorDelete, setPendingConnectorDelete] = useState<PendingConnectorDelete | null>(null);
  const [connectorDisconnectImpact, setConnectorDisconnectImpact] = useState<ConnectorDisconnectImpact | null>(null);
  const [connectorDisconnectImpactLoading, setConnectorDisconnectImpactLoading] = useState(false);
  const [connectorDisconnectImpactSlug, setConnectorDisconnectImpactSlug] = useState<string | null>(null);
  const [connectorDisconnectImpactError, setConnectorDisconnectImpactError] = useState(false);
  const [timeZoneSheet, setTimeZoneSheet] = useState<{
    value: string;
    onSelect: (timezone: string) => void;
  } | null>(null);
  const [weatherText, setWeatherText] = useState("");
  const [weatherLoading, setWeatherLoading] = useState(false);
  const [clockTick, setClockTick] = useState(() => Date.now());
  const [finnPhoneNumber, setFinnPhoneNumber] = useState(showDemoSession ? demoSpectrumAssignedPhoneNumber : "");
  const browserTimeZoneCaptureAttemptedRef = useRef(false);
  const connectorImpactRequestRef = useRef(0);

  const sortedConnectors = useMemo(
    () => [...connectors].sort((a, b) => Number(b.connected) - Number(a.connected) || a.name.localeCompare(b.name)),
    [connectors],
  );
  const onboardingRequired = Boolean(user && !user.onboarding.completedAt);

  const sortedMcpServers = useMemo(
    () => [...mcpServers].sort((a, b) => Number(b.connected) - Number(a.connected) || a.name.localeCompare(b.name)),
    [mcpServers],
  );

  const selectedMcpServer = useMemo(
    () => sortedMcpServers.find((server) => server.id === selectedMcpServerId) ?? null,
    [selectedMcpServerId, sortedMcpServers],
  );

  const sortedPatterns = useMemo(
    () => [...patterns].sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name)),
    [patterns],
  );

  const currentMyDayDate = useMemo(
    () => user ? new Intl.DateTimeFormat("en-CA", { timeZone: user.timezone }).format(new Date(clockTick)) : null,
    [clockTick, user],
  );

  const { dayLabel, greeting } = useMemo(
    () => dashboardClockParts(new Date(clockTick)),
    [clockTick],
  );

  const authGreeting = useMemo(
    () => getAuthGreeting(new Date(clockTick)),
    [clockTick],
  );

  const appTheme = useMemo(
    () => getThemeForDate(new Date(clockTick)),
    [clockTick],
  );

  useEffect(() => {
    ensureHapticBridge();
    preloadImageSource(profileHeaderUrl);
    return () => {
      removeHapticBridge();
    };
  }, []);

  useEffect(() => {
    preloadImageSource(user?.profileImageUrl);
  }, [user?.profileImageUrl]);

  useEffect(() => {
    document.documentElement.dataset.screen = screen;
    return () => {
      delete document.documentElement.dataset.screen;
    };
  }, [screen]);

  useEffect(() => {
    if (sheet === null) {
      setSheetBackdropProgress(0);
    }
  }, [screen, sheet]);

  useEffect(() => {
    if (sheet !== null) return;
    setAppClosedChrome(screen === "dashboard" ? appTheme : null);
  }, [appTheme, screen, sheet]);

  useEffect(() => {
    if (showDemoSession) return;

    api<SessionResponse>("/session")
      .then((result) => {
        setFinnPhoneNumber(result.finnPhoneNumber);
        if (result.user) {
          if (result.user.timezoneSource === "server" && !browserTimeZoneCaptureAttemptedRef.current) {
            browserTimeZoneCaptureAttemptedRef.current = true;
            const browserTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
            if (isSupportedTimeZone(browserTimeZone)) {
              const nextUser = {
                ...result.user,
                timezone: browserTimeZone,
                timezoneSource: "browser" as const,
              };
              setUser(nextUser);
              api<{ user: UserProfile }>("/profile", {
                method: "PATCH",
                body: JSON.stringify(nextUser),
              })
                .then((profileResult) => setUser(profileResult.user))
                .catch(() => setUser(result.user));
              setScreen("dashboard");
              return;
            }
          }

          setUser(result.user);
          setScreen("dashboard");
          return;
        }
        setScreen("login");
      })
      .catch(() => setScreen("login"));
  }, [showDemoSession]);

  useEffect(() => {
    const interval = window.setInterval(() => setClockTick(Date.now()), 60_000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    const passiveFalse = { passive: false } as const;
    const preventGesture = (event: Event) => event.preventDefault();
    const preventPinchZoom = (event: TouchEvent) => {
      if (event.touches.length > 1) {
        event.preventDefault();
      }
    };

    document.addEventListener("gesturestart", preventGesture, passiveFalse);
    document.addEventListener("gesturechange", preventGesture, passiveFalse);
    document.addEventListener("gestureend", preventGesture, passiveFalse);
    document.addEventListener("touchmove", preventPinchZoom, passiveFalse);

    return () => {
      document.removeEventListener("gesturestart", preventGesture);
      document.removeEventListener("gesturechange", preventGesture);
      document.removeEventListener("gestureend", preventGesture);
      document.removeEventListener("touchmove", preventPinchZoom);
    };
  }, []);

  useEffect(() => {
    document.addEventListener("contextmenu", preventImageInteractions);
    document.addEventListener("dragstart", preventImageInteractions);

    return () => {
      document.removeEventListener("contextmenu", preventImageInteractions);
      document.removeEventListener("dragstart", preventImageInteractions);
    };
  }, []);

  useEffect(() => {
    if (!user) return;

    let cancelled = false;
    setWeatherLoading(true);

    getWeatherSummary(user)
      .then((summary) => {
        if (!cancelled) {
          setWeatherText(summary.text);
          setWeatherLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setWeatherText(user.location || "weather unavailable");
          setWeatherLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [user?.id, user?.location]);

  useEffect(() => {
    if (!activityPattern) return;
    const latestPattern = patterns.find((pattern) => pattern.id === activityPattern.id);
    if (latestPattern) {
      setActivityPattern(latestPattern);
    }
  }, [activityPattern?.id, patterns]);

  useEffect(() => {
    if (!activityPattern) return;
    const interval = window.setInterval(() => {
      void loadPatternRuns(activityPattern.id, { silent: true });
    }, 10_000);
    return () => window.clearInterval(interval);
  }, [activityPattern?.id]);

  async function loadConnectors(options: { append?: boolean; silent?: boolean } = {}) {
    if (!user) return;
    if (showDemoData) {
      if (showOnboardingDemo) {
        setConnectors((current) => current.length > 0 ? current : createOnboardingDemoConnectors());
      } else {
        setConnectors([demoConnector]);
      }
      setConnectorCursor(null);
      setConnectorLoading(false);
      setConnectorLoadingMore(false);
      return;
    }

    if (options.append) {
      setConnectorLoadingMore(true);
    } else if (!options.silent) {
      setConnectorLoading(true);
      setConnectorCursor(null);
    }

    try {
      const params = new URLSearchParams({ limit: "25" });
      if (options.append && connectorCursor) {
        params.set("cursor", connectorCursor);
      }

      const result = await api<ConnectorPage>(`/connectors?${params}`);
      setConnectors((current) => {
        const next = options.append ? [...current] : [];
        for (const connector of result.connectors) {
          const existingIndex = next.findIndex((item) => item.slug === connector.slug);
          if (existingIndex === -1) {
            next.push(connector);
          } else {
            next[existingIndex] = connector;
          }
        }
        return next;
      });
      setConnectorCursor(result.nextCursor ?? null);
      if (options.append) {
        toast.success("Connectors loaded");
      }
    } catch (error) {
      if (!options.silent) {
        notifyError(error, "Could not load connectors right now.");
      }
    } finally {
      if (!options.silent) {
        setConnectorLoading(false);
      }
      setConnectorLoadingMore(false);
    }
  }

  async function loadMcpServers() {
    if (!user) return;
    if (showDemoData) {
      setMcpServers(demoMcpServers);
      setMcpLoading(false);
      return;
    }

    setMcpLoading(true);
    try {
      const result = await api<McpServerPage>("/mcp-servers");
      setMcpServers(result.servers);
    } catch (error) {
      notifyError(error, "Could not load MCP servers.");
    } finally {
      setMcpLoading(false);
    }
  }

  async function loadConnectorDetails(slug: string) {
    setSelectedConnectorSlug(slug);
    setSelectedConnector(null);
    setSelectedMcpServerId(null);
    setAddingMcpServer(false);
    setSelectedConnectorLoading(true);
    if (showDemoData) {
      const demoConnectorDetails = showOnboardingDemo
        ? connectors.find((connector) => connector.slug === slug) ?? null
        : demoConnector.slug === slug ? demoConnector : null;
      setSelectedConnector(demoConnectorDetails);
      setSelectedConnectorLoading(false);
      return;
    }

    try {
      const result = await api<{ connector: ConnectorDetails }>(`/connectors/${encodeURIComponent(slug)}`);
      setSelectedConnector(result.connector);
    } catch (error) {
      notifyError(error, "Could not load connector.");
    } finally {
      setSelectedConnectorLoading(false);
    }
  }

  async function loadPatterns() {
    if (!user) return;
    if (showDemoData) {
      setPatterns(demoPatterns);
      setPatternLoading(false);
      return;
    }
    setPatternLoading(true);
    try {
      const result = await api<PatternPage>("/patterns");
      setPatterns(result.patterns);
    } catch (error) {
      notifyError(error, "Could not load patterns.");
    } finally {
      setPatternLoading(false);
    }
  }

  async function loadMyDay() {
    if (!user) return;
    if (showDemoData) {
      setMyDayPage(demoMyDayPage());
      setMyDayLoading(false);
      return;
    }
    setMyDayLoading(true);
    try {
      const query = currentMyDayDate ? `?date=${encodeURIComponent(currentMyDayDate)}` : "";
      const result = await api<MyDayPage>(`/my-day${query}`);
      setMyDayPage(result);
    } catch (error) {
      notifyError(error, "Could not load My Day.");
    } finally {
      setMyDayLoading(false);
    }
  }

  async function loadLibrary(folderId = libraryFolderId) {
    if (!user) return;
    if (showDemoData) {
      setLibraryPage({ folder: null, breadcrumbs: [], folders: [], files: [] });
      setLibraryFolderId(null);
      setLibraryLoading(false);
      return;
    }

    setLibraryLoading(true);
    try {
      const query = folderId ? `?folderId=${encodeURIComponent(folderId)}` : "";
      const result = await api<LibraryPage>(`/library${query}`);
      setLibraryPage(result);
      setLibraryFolderId(result.folder?.id ?? null);
    } catch (error) {
      notifyError(error, "Could not load Library.");
    } finally {
      setLibraryLoading(false);
    }
  }

  async function createLibraryFolder(name: string, parentId: string | null) {
    setLibrarySaving(true);
    try {
      await api<{ folder: LibraryFolder }>("/library/folders", {
        method: "POST",
        body: JSON.stringify({ name, parentId }),
      });
      await loadLibrary(parentId);
    } catch (error) {
      notifyError(error, "Could not create folder.");
    } finally {
      setLibrarySaving(false);
    }
  }

  async function uploadLibraryFile(file: File, folderId: string | null) {
    setLibrarySaving(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      if (folderId) formData.append("folderId", folderId);
      const response = await fetch("/api/web/library/files", { method: "POST", body: formData });
      const body = await response.json().catch(() => null) as { file?: LibraryFile; error?: string } | null;
      if (!response.ok) {
        throw new Error(body?.error || "Could not upload file.");
      }
      await loadLibrary(folderId);
      toast.success("File added to Library");
    } catch (error) {
      notifyError(error, "Could not upload file.");
    } finally {
      setLibrarySaving(false);
    }
  }

  async function moveLibraryFile(fileId: string, folderId: string | null) {
    setLibrarySaving(true);
    try {
      await api<{ file: LibraryFile }>(`/library/files/${encodeURIComponent(fileId)}`, {
        method: "PATCH",
        body: JSON.stringify({ folderId }),
      });
      await loadLibrary(libraryFolderId);
    } catch (error) {
      notifyError(error, "Could not move file.");
    } finally {
      setLibrarySaving(false);
    }
  }

  async function deleteLibraryFile(file: LibraryFile) {
    setLibrarySaving(true);
    try {
      await api<{ ok: true }>(`/library/files/${encodeURIComponent(file.id)}`, { method: "DELETE" });
      await loadLibrary(libraryFolderId);
      toast.success("File deleted");
    } catch (error) {
      notifyError(error, "Could not delete file.");
    } finally {
      setLibrarySaving(false);
    }
  }

  async function deleteLibraryFolder(folder: LibraryFolder) {
    setLibrarySaving(true);
    try {
      await api<{ ok: true }>(`/library/folders/${encodeURIComponent(folder.id)}`, { method: "DELETE" });
      await loadLibrary(libraryFolderId);
      toast.success("Folder deleted");
    } catch (error) {
      notifyError(error, "Could not delete folder.");
    } finally {
      setLibrarySaving(false);
    }
  }

  async function createMyDayTodo(title: string) {
    if (!currentMyDayDate) return;
    if (showDemoData) {
      const now = new Date().toISOString();
      const todo: MyDayTodo = { id: `demo-todo-${Date.now()}`, title, notes: null, status: "open", source: { type: "user", label: "My Day" }, handoffAt: null, handoffWorkerId: null, createdAt: now, updatedAt: now, completedAt: null, archivedAt: null };
      setMyDayPage((current) => current ? { ...current, todos: [...current.todos, todo] } : current);
      return;
    }

    try {
      const result = await api<{ todo: MyDayTodo }>("/my-day/todos", {
        method: "POST",
        body: JSON.stringify({ date: currentMyDayDate, title }),
      });
      setMyDayPage((current) => current ? { ...current, todos: [...current.todos, result.todo] } : current);
    } catch (error) {
      notifyError(error, "Could not add todo.");
    }
  }

  async function updateMyDayTodo(todo: MyDayTodo, patch: Partial<Pick<MyDayTodo, "title" | "notes" | "status">>) {
    setMyDaySavingTodoIds((current) => new Set(current).add(todo.id));
    const optimisticTodo = { ...todo, ...patch, updatedAt: new Date().toISOString(), completedAt: patch.status === "done" ? new Date().toISOString() : patch.status === "open" ? null : todo.completedAt };
    setMyDayPage((current) => current ? { ...current, todos: current.todos.map((item) => item.id === todo.id ? optimisticTodo : item) } : current);

    if (showDemoData) {
      setMyDaySavingTodoIds((current) => {
        const next = new Set(current);
        next.delete(todo.id);
        return next;
      });
      return;
    }

    try {
      const result = await api<{ todo: MyDayTodo }>(`/my-day/todos/${encodeURIComponent(todo.id)}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      setMyDayPage((current) => current ? { ...current, todos: current.todos.map((item) => item.id === todo.id ? result.todo : item) } : current);
    } catch (error) {
      setMyDayPage((current) => current ? { ...current, todos: current.todos.map((item) => item.id === todo.id ? todo : item) } : current);
      notifyError(error, "Could not update todo.");
    } finally {
      setMyDaySavingTodoIds((current) => {
        const next = new Set(current);
        next.delete(todo.id);
        return next;
      });
    }
  }

  async function deleteMyDayTodo(todo: MyDayTodo) {
    if (showDemoData) {
      const now = new Date().toISOString();
      setMyDayPage((current) => current ? { ...current, todos: current.todos.map((item) => item.id === todo.id ? { ...item, status: "archived", updatedAt: now, archivedAt: now } : item) } : current);
      return;
    }

    try {
      const result = await api<{ archived: true; todo: MyDayTodo }>(`/my-day/todos/${encodeURIComponent(todo.id)}`, { method: "DELETE" });
      setMyDayPage((current) => current ? { ...current, todos: current.todos.map((item) => item.id === todo.id ? result.todo : item) } : current);
    } catch (error) {
      notifyError(error, "Could not delete todo.");
    }
  }

  async function handoffMyDayTodo(todo: MyDayTodo, context?: string) {
    setMyDaySavingTodoIds((current) => new Set(current).add(todo.id));
    if (showDemoData) {
      setMyDayPage((current) => current ? { ...current, todos: current.todos.map((item) => item.id === todo.id ? { ...item, handoffAt: new Date().toISOString(), updatedAt: new Date().toISOString() } : item) } : current);
      setMyDaySavingTodoIds((current) => {
        const next = new Set(current);
        next.delete(todo.id);
        return next;
      });
      return;
    }

    try {
      const result = await api<{ todo: MyDayTodo; queued: boolean }>(`/my-day/todos/${encodeURIComponent(todo.id)}/handoff`, {
        method: "POST",
        body: JSON.stringify(context ? { context } : {}),
      });
      setMyDayPage((current) => current ? { ...current, todos: current.todos.map((item) => item.id === todo.id ? result.todo : item) } : current);
      toast.success("Handed off to Finn");
    } catch (error) {
      notifyError(error, "Could not hand off todo.");
    } finally {
      setMyDaySavingTodoIds((current) => {
        const next = new Set(current);
        next.delete(todo.id);
        return next;
      });
    }
  }

  async function updatePatternActive(pattern: Pattern, active: boolean) {
    if (showDemoData) {
      const nextUpdatedAt = new Date().toISOString();
      setPatterns((current) => current.map((item) => item.id === pattern.id ? { ...item, active, updatedAt: nextUpdatedAt } : item));
      return;
    }

    try {
      const result = await api<{ pattern: Pattern }>(`/patterns/${encodeURIComponent(pattern.id)}/toggle`, {
        method: "POST",
        body: JSON.stringify({ active }),
      });
      setPatterns((current) => current.map((item) => item.id === result.pattern.id ? result.pattern : item));
    } catch (error) {
      throw error;
    }
  }

  async function pausePattern(pattern: Pattern) {
    if (pausingPatternIds.has(pattern.id)) return;
    const nextActive = !pattern.active;
    setPausingPatternIds((current) => new Set(current).add(pattern.id));
    try {
      await toast.promise(updatePatternActive(pattern, nextActive), {
        loading: nextActive ? "Resuming pattern..." : "Pausing pattern...",
        success: nextActive ? "Pattern resumed" : "Pattern paused",
        error: (error) => getErrorMessage(error, nextActive ? "Could not resume pattern." : "Could not pause pattern."),
      });
    } catch {
      // toast.promise owns user-facing error display.
    } finally {
      setPausingPatternIds((current) => {
        const next = new Set(current);
        next.delete(pattern.id);
        return next;
      });
    }
  }

  async function deletePattern(id: string) {
    if (showDemoData) {
      setPatterns((current) => current.filter((pattern) => pattern.id !== id));
      return;
    }

    try {
      await api<{ ok: true }>(`/patterns/${encodeURIComponent(id)}`, { method: "DELETE" });
      setPatterns((current) => current.filter((pattern) => pattern.id !== id));
      toast.success("Pattern deleted");
    } catch (error) {
      notifyError(error, "Could not delete pattern.");
    }
  }

  async function loadPatternRuns(id: string, options: { silent?: boolean } = {}) {
    if (showDemoData) {
      const nextRuns = demoPatternRuns(id).slice(0, 11);
      setPatternRuns((current) => patternRunsEqual(current[id], nextRuns) ? current : { ...current, [id]: nextRuns });
      return;
    }

    if (!options.silent) {
      setPatternRunsLoading((current) => ({ ...current, [id]: true }));
    }
    try {
      const result = await api<PatternRunPage>(`/patterns/${encodeURIComponent(id)}/runs?limit=11`);
      const nextRuns = result.runs.slice(0, 11);
      setPatternRuns((current) => patternRunsEqual(current[id], nextRuns) ? current : { ...current, [id]: nextRuns });
    } catch (error) {
      if (!options.silent) {
        notifyError(error, "Could not load Pattern runs.");
      }
    } finally {
      if (!options.silent) {
        setPatternRunsLoading((current) => ({ ...current, [id]: false }));
      }
    }
  }

  function showPatternActivity(pattern: Pattern) {
    triggerHapticFeedback();
    setActivityPattern(pattern);
    void loadPatternRuns(pattern.id);
  }

  function closePatternActivitySheet() {
    triggerHapticFeedback();
    setActivityPattern(null);
  }

  async function saveConnectorConfig(patch: ConnectorConfigPatch, slugOverride?: string) {
    const targetSlug = slugOverride ?? selectedConnectorSlug;
    if (!targetSlug) return;

    setConnectorConfigSaving(true);
    try {
      const result = await api<{ config: ConnectorConfig; connector?: Connector }>(`/connectors/${encodeURIComponent(targetSlug)}/config`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      if (targetSlug === "puter" && !puterPatchMatchesConfig(patch.puter, result.config)) {
        throw new Error("Puter settings did not update. Refresh and try again.");
      }

      setSelectedConnector((current) => current?.slug === targetSlug
        ? result.connector ?? { ...current, config: result.config }
        : current);
      setConnectors((current) => current.map((connector) => connector.slug === targetSlug
        ? result.connector ?? { ...connector, config: result.config }
        : connector));
      toast.success("Connector settings updated");
    } catch (error) {
      notifyError(error, "Could not save connector settings.");
    } finally {
      setConnectorConfigSaving(false);
    }
  }

  async function createMcpServer(draft: McpServerDraft) {
    setMcpServerSaving(true);

    if (showDemoData) {
      const now = new Date().toISOString();
      const created: McpServer = {
        id: `demo-${draft.name || "mcp"}-${Date.now()}`,
        name: draft.name || "New MCP server",
        description: draft.description || null,
        authMode: draft.authMode,
        transport: {
          type: "http",
          url: draft.url || "https://example.com/mcp",
          hasAuthToken: draft.authMode === "api_key" && Boolean(draft.authToken),
        },
        alwaysOn: true,
        active: true,
        connected: true,
        toolCount: 4,
        resourceCount: 0,
        createdAt: now,
        updatedAt: now,
      };
      setMcpServers((current) => [created, ...current]);
      setSelectedMcpServerId(created.id);
      setAddingMcpServer(false);
      setMcpServerSaving(false);
      toast.success("MCP server connected");
      return;
    }

    try {
      const result = await toast.promise(
        api<{ server: McpServer; redirectUrl?: string }>("/mcp-servers", {
          method: "POST",
          body: JSON.stringify({
            name: draft.name,
            url: draft.url,
            description: draft.description || undefined,
            authMode: draft.authMode,
            authHeaderName: draft.authMode === "api_key" ? draft.authHeaderName || undefined : undefined,
            authHeaderValue: draft.authMode === "api_key" ? draft.authHeaderValue || undefined : undefined,
          }),
        }),
        {
          loading: "Connecting MCP server...",
          success: "MCP server connected",
          error: (error) => getErrorMessage(error, "Could not add MCP server."),
        },
      );
      setMcpServers((current) => [result.server, ...current]);
      if (result.redirectUrl) {
        window.location.href = result.redirectUrl;
        return;
      }
      setSelectedMcpServerId(result.server.id);
      setAddingMcpServer(false);
      void loadMcpServers();
    } catch {
    } finally {
      setMcpServerSaving(false);
    }
  }

  async function toggleMcpServer(id: string, active: boolean) {
    setMcpServerSaving(true);

    if (showDemoData) {
      setMcpServers((current) => current.map((server) => server.id === id
        ? { ...server, active, connected: active, updatedAt: new Date().toISOString() }
        : server));
      setMcpServerSaving(false);
      toast.success(active ? "MCP server resumed" : "MCP server paused");
      return;
    }

    try {
      const result = await api<{ server: McpServer }>(`/mcp-servers/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify({ active }),
      });
      setMcpServers((current) => current.map((server) => server.id === id ? result.server : server));
      void loadMcpServers();
      toast.success(active ? "MCP server resumed" : "MCP server paused");
    } catch (error) {
      notifyError(error, "Could not update MCP server.");
    } finally {
      setMcpServerSaving(false);
    }
  }

  async function deleteMcpServer(id: string) {
    setMcpServerSaving(true);

    if (showDemoData) {
      setMcpServers((current) => current.filter((server) => server.id !== id));
      setSelectedMcpServerId(null);
      setMcpServerSaving(false);
      toast.success("MCP server disconnected");
      return;
    }

    try {
      await api<{ ok: true }>(`/mcp-servers/${encodeURIComponent(id)}`, { method: "DELETE" });
      setMcpServers((current) => current.filter((server) => server.id !== id));
      setSelectedMcpServerId(null);
      toast.success("MCP server disconnected");
    } catch (error) {
      notifyError(error, "Could not disconnect MCP server.");
    } finally {
      setMcpServerSaving(false);
    }
  }

  async function reconnectConnector(slug: string, previousConnectedAccountId?: string) {
    try {
      const result = await api<{ redirectUrl: string }>(`/connectors/${encodeURIComponent(slug)}/reconnect`, {
        method: "POST",
        ...(previousConnectedAccountId ? { body: JSON.stringify({ previousConnectedAccountId }) } : {}),
      });
      const connector = selectedConnector?.slug === slug
        ? selectedConnector
        : connectors.find((item) => item.slug === slug);
      window.sessionStorage.setItem("pendingConnectorSlug", slug);
      const pendingAccountId = previousConnectedAccountId ?? connector?.connectedAccountId;
      if (pendingAccountId) {
        window.sessionStorage.setItem("pendingConnectorAccountId", pendingAccountId);
      } else {
        window.sessionStorage.removeItem("pendingConnectorAccountId");
      }
      window.location.href = result.redirectUrl;
    } catch (error) {
      notifyError(error, "Could not reconnect connector.");
    }
  }

  async function deleteConnector(slug: string) {
    try {
      const result = await api<{ ok: true; connector?: Connector }>(`/connectors/${encodeURIComponent(slug)}`, { method: "DELETE" });
      setSelectedConnector(null);
      setSelectedConnectorSlug(null);
      setConnectors((current) => current.map((connector) => connector.slug === slug
        ? result.connector ?? {
            ...connector,
            connected: false,
            connectionStatus: undefined,
          }
        : connector));
      await loadConnectors();
      await loadPatterns();
      toast.success("Connector disconnected");
    } catch (error) {
      notifyError(error, "Could not delete connector.");
    }
  }

  useEffect(() => {
    if (!user) return;
    void loadConnectors();
    void loadMcpServers();
    void loadPatterns();
    void loadLibrary(null);
  }, [user]);

  useEffect(() => {
    if (!user || screen !== "dashboard") return;

    if (user.onboarding.completedAt) {
      if (sheet === "onboarding") {
        setSheet(null);
        setMountedSheet(null);
      }
      return;
    }

    const pendingConnectorAuth = Boolean(window.sessionStorage.getItem("pendingOnboardingConnectorSlug"));
    if (sheet !== "onboarding") {
      resetSheetViewState("onboarding");
      setOnboardingStep(getInitialOnboardingStep(user, connectors, pendingConnectorAuth));
      setSheetRenderKey((current) => current + 1);
      setMountedSheet("onboarding");
      setSheet("onboarding");
      return;
    }

    if (pendingConnectorAuth && onboardingStep !== "connect") {
      setOnboardingStep("connect");
    }
  }, [connectors, onboardingStep, screen, sheet, user]);

  useEffect(() => {
    if (!user || sheet !== "my-day" || !currentMyDayDate || myDayLoading) return;
    if (myDayPage?.day.userLocalDate === currentMyDayDate) return;
    void loadMyDay();
  }, [currentMyDayDate, myDayLoading, myDayPage?.day.userLocalDate, sheet, user]);

  useEffect(() => {
    if (!user || (sheet !== "connectors" && sheet !== "onboarding") || connectorLoading) return;

    const pendingSlug = window.sessionStorage.getItem("pendingConnectorSlug");
    if (!pendingSlug) return;
    const previousConnectedAccountId = window.sessionStorage.getItem("pendingConnectorAccountId") ?? undefined;

    let cancelled = false;
    const notify = async () => {
      for (let attempt = 0; attempt < 5 && !cancelled; attempt += 1) {
        const result = await api<{ notified: boolean }>("/connectors/notify", {
          method: "POST",
          body: JSON.stringify({ slug: pendingSlug, previousConnectedAccountId }),
        }).catch(() => null);

        if (result) {
          window.sessionStorage.removeItem("pendingConnectorSlug");
          window.sessionStorage.removeItem("pendingConnectorAccountId");
          window.sessionStorage.removeItem("pendingOnboardingConnectorSlug");
          void loadConnectors();
          void loadPatterns();
          toast.success("Connector connected");
          return;
        }

        await new Promise<void>((resolve) => window.setTimeout(resolve, 1500));
      }
    };

    void notify();
    return () => {
      cancelled = true;
    };
  }, [connectorLoading, sheet, user]);

  useEffect(() => {
    if (!user || (sheet !== "connectors" && sheet !== "onboarding") || showDemoData) return;
    const interval = window.setInterval(() => {
      void loadConnectors({ silent: true });
    }, 2500);
    return () => window.clearInterval(interval);
  }, [sheet, user?.id, showDemoData]);

  useEffect(() => {
    if (showOnboardingDemo) return;
    const path = appPathForSheet(sheet);
    if (window.location.pathname !== path) {
      window.history.replaceState({}, "", path);
    }
  }, [sheet, showOnboardingDemo]);

  function openSheet(nextSheet: ActiveSheet) {
    triggerHapticFeedback();

    resetSheetViewState(nextSheet);

    if (nextSheet === "patterns" && user) {
      void loadPatterns();
    }

    if (nextSheet === "my-day" && user) {
      void loadMyDay();
    }

    if (nextSheet === "library" && user) {
      void loadLibrary(libraryFolderId);
    }

    if (nextSheet === "connectors" && user) {
      void loadConnectors();
      void loadMcpServers();
    }

    setSheetRenderKey((current) => current + 1);
    setMountedSheet(nextSheet);
    setSheet(nextSheet);
  }

  function closeSheet() {
    if (onboardingRequired && sheet === "onboarding") {
      setSheet("onboarding");
      setMountedSheet("onboarding");
      return;
    }

    triggerHapticFeedback();
    resetSheetViewState(null);
    setSheet(null);
  }

  function resetSheetViewState(nextSheet: ActiveSheet) {
    setPendingDeletePattern(null);
    setPendingConnectorDelete(null);
    setPendingMyDayTodoAction(null);
    setActivityPattern(null);

    if (nextSheet !== "connectors") {
      setSelectedConnector(null);
      setSelectedConnectorSlug(null);
      setSelectedMcpServerId(null);
      setAddingMcpServer(false);
    }
  }

  function openTimeZoneSheet(options: { value: string; onSelect: (timezone: string) => void }) {
    triggerHapticFeedback();
    setTimeZoneSheet(options);
  }

  function closeTimeZoneSheet() {
    triggerHapticFeedback();
    setTimeZoneSheet(null);
  }

  function requestDeletePattern(pattern: Pattern) {
    triggerHapticFeedback();
    setPendingDeletePattern(pattern);
  }

  function closeDeleteConfirmSheet() {
    triggerHapticFeedback();
    setPendingDeletePattern(null);
  }

  function requestDeleteMcpServer(server: McpServer) {
    triggerHapticFeedback();
    connectorImpactRequestRef.current += 1;
    setConnectorDisconnectImpact(null);
    setConnectorDisconnectImpactLoading(false);
    setConnectorDisconnectImpactSlug(null);
    setConnectorDisconnectImpactError(false);
    setPendingConnectorDelete({ type: "mcp", id: server.id, name: server.name });
  }

  function requestDeleteConnector(connector: ConnectorDetails) {
    triggerHapticFeedback();
    setPendingConnectorDelete({ type: "connector", slug: connector.slug, name: connector.name });
    void loadConnectorDisconnectImpact(connector.slug);
  }

  async function loadConnectorDisconnectImpact(slug: string) {
    const requestId = connectorImpactRequestRef.current + 1;
    connectorImpactRequestRef.current = requestId;
    setConnectorDisconnectImpactLoading(true);
    setConnectorDisconnectImpact(null);
    setConnectorDisconnectImpactSlug(slug);
    setConnectorDisconnectImpactError(false);
    try {
      const result = await api<{ impact: ConnectorDisconnectImpact }>(`/connectors/${encodeURIComponent(slug)}/disconnect-impact`);
      if (connectorImpactRequestRef.current !== requestId) return;
      setConnectorDisconnectImpact(result.impact);
    } catch (error) {
      if (connectorImpactRequestRef.current !== requestId) return;
      setConnectorDisconnectImpactError(true);
      notifyError(error, "Could not check connector impact.");
    } finally {
      if (connectorImpactRequestRef.current === requestId) {
        setConnectorDisconnectImpactLoading(false);
      }
    }
  }

  function closeConnectorDeleteConfirmSheet() {
    triggerHapticFeedback();
    connectorImpactRequestRef.current += 1;
    setPendingConnectorDelete(null);
    setConnectorDisconnectImpact(null);
    setConnectorDisconnectImpactLoading(false);
    setConnectorDisconnectImpactSlug(null);
    setConnectorDisconnectImpactError(false);
  }

  function closeMyDayTodoActionSheet() {
    triggerHapticFeedback();
    setPendingMyDayTodoAction(null);
  }

  async function requestCode() {
    const normalizedPhoneNumber = normalizePhoneForCountry(phoneNumber, countryCode);

    if (!normalizedPhoneNumber) {
      toast.error("Enter your phone number.");
      return;
    }

    setAuthLoading(true);
    try {
      const result = await api<RequestCodeResponse>("/auth/request", {
        method: "POST",
        body: JSON.stringify({ phoneNumber: normalizedPhoneNumber }),
      });
      setSubmittedPhoneNumber(normalizedPhoneNumber);
      setAuthFlowIsNewUser(result.isNewUser);
      setScreen("verify");
    } catch (error) {
      notifyError(error, "Could not send a code.");
    } finally {
      setAuthLoading(false);
    }
  }

  function changeCountry(nextCode: CountryCode) {
    setCountryCode(nextCode);
    setPhoneNumber((current) => formatPhoneForCountry(current, nextCode));
  }

  async function verifyCode() {
    const normalizedPhoneNumber = submittedPhoneNumber || normalizePhoneForCountry(phoneNumber, countryCode);

    setAuthLoading(true);
    try {
      const result = await api<SessionResponse>("/auth/verify", {
        method: "POST",
        body: JSON.stringify({ phoneNumber: normalizedPhoneNumber, code }),
      });
      setFinnPhoneNumber(result.finnPhoneNumber);
      setUser(result.user);
      setScreen("dashboard");
    } catch (error) {
      notifyError(error, "Could not verify that code.");
    } finally {
      setAuthLoading(false);
    }
  }

  async function saveProfile(
    patch: ProfilePatch,
    field: ProfileFieldName,
  ): Promise<boolean> {
    if (!user) {
      return false;
    }

    const normalizedPhoneNumber = patch.phoneNumber === undefined
      ? undefined
      : normalizePhoneForCountry(patch.phoneNumber, inferCountryCodeFromPhone(patch.phoneNumber));

    if (patch.phoneNumber !== undefined && !normalizedPhoneNumber) {
      toast.error("Enter your phone number.");
      return false;
    }

    const normalizedPatch = normalizedPhoneNumber === undefined
      ? patch
      : {
          ...patch,
          phoneNumber: normalizedPhoneNumber,
        };
    const nextUser = {
      ...user,
      ...normalizedPatch,
    };

    if (
      nextUser.displayName === user.displayName
      && nextUser.phoneNumber === user.phoneNumber
      && nextUser.timezone === user.timezone
      && nextUser.timezoneSource === user.timezoneSource
      && nextUser.location === user.location
      && nextUser.kidsMode === user.kidsMode
    ) {
      return true;
    }

    setProfileSaving(true);
    setProfileSavingField(field);
    try {
      const result = await toast.promise(
        api<{ user: UserProfile }>("/profile", {
          method: "PATCH",
          body: JSON.stringify(nextUser),
        }),
        {
          loading: toastMessages.profileSaving,
          success: toastMessages.profileSaved,
          error: (error) => getErrorMessage(error, "Could not save your profile."),
        },
      );
      setUser(result.user);
      return true;
    } catch {
      return false;
    } finally {
      setProfileSaving(false);
      setProfileSavingField(null);
    }
  }

  async function saveOnboardingProfile(
    patch: ProfilePatch,
    field: ProfileFieldName,
  ): Promise<boolean> {
    if (!user) {
      return false;
    }

    const nextUser = {
      ...user,
      ...patch,
    };

    if (
      nextUser.displayName === user.displayName
      && nextUser.phoneNumber === user.phoneNumber
      && nextUser.timezone === user.timezone
      && nextUser.timezoneSource === user.timezoneSource
      && nextUser.location === user.location
      && nextUser.kidsMode === user.kidsMode
    ) {
      return true;
    }

    if (showOnboardingDemo) {
      setProfileSaving(true);
      setProfileSavingField(field);
      setUser(nextUser);
      setProfileSaving(false);
      setProfileSavingField(null);
      return true;
    }

    setProfileSaving(true);
    setProfileSavingField(field);
    try {
      const result = await api<{ user: UserProfile }>("/profile", {
        method: "PATCH",
        body: JSON.stringify(nextUser),
      });
      setUser(result.user);
      return true;
    } catch (error) {
      notifyError(error, "Could not save that yet.");
      return false;
    } finally {
      setProfileSaving(false);
      setProfileSavingField(null);
    }
  }

  async function completeOnboardingAndMessageFinn() {
    if (!user || !finnPhoneNumber) {
      return;
    }

    const firstMessage = "hey finn, i'm here. help me settle in and keep an eye on what matters today.";
    setOnboardingCompleting(true);
    if (showOnboardingDemo) {
      const completedAt = new Date().toISOString();
      setUser({
        ...user,
        onboarding: {
          ...user.onboarding,
          completedAt,
        },
      });
      window.sessionStorage.removeItem("pendingOnboardingConnectorSlug");
      setSheet(null);
      setMountedSheet(null);
      triggerHapticFeedback();
      window.location.href = buildTextFinnHref(finnPhoneNumber, firstMessage);
      setOnboardingCompleting(false);
      return;
    }

    try {
      const result = await api<{ user: UserProfile }>("/onboarding/complete", {
        method: "POST",
        body: JSON.stringify({
          firstMessageContext: "The user has just completed first-run setup and may be sending their first text from the welcome screen. Treat it naturally; do not mention onboarding unless they bring it up.",
        }),
      });
      setUser(result.user);
      window.sessionStorage.removeItem("pendingOnboardingConnectorSlug");
      setSheet(null);
      setMountedSheet(null);
      triggerHapticFeedback();
      window.location.href = buildTextFinnHref(finnPhoneNumber, firstMessage);
    } catch (error) {
      notifyError(error, "Could not finish setup yet.");
    } finally {
      setOnboardingCompleting(false);
    }
  }

  async function uploadProfileImage(file: File) {
    if (!user) {
      return;
    }

    setProfileImageUploading(true);
    try {
      const formData = new FormData();
      formData.append("image", file);
      const response = await fetch("/api/web/profile/image", {
        method: "POST",
        body: formData,
      });
      const body = await response.json().catch(() => null) as { user?: UserProfile; error?: string } | null;
      if (!response.ok || !body?.user) {
        throw new Error(body?.error || "Could not upload your profile image.");
      }
      setUser(body.user);
      preloadImageSource(body.user.profileImageUrl);
      toast.success(toastMessages.profileImageSaved);
    } catch (error) {
      notifyError(error, "Could not upload your profile image.");
    } finally {
      setProfileImageUploading(false);
    }
  }

  async function logout() {
    try {
      await toast.promise(
        api<{ ok: true }>("/auth/logout", { method: "POST" }),
        {
          loading: "Signing out...",
          success: "Signed out",
          error: (error) => getErrorMessage(error, "Could not sign out."),
        },
      );
      setUser(null);
      setSheet(null);
      setAuthFlowIsNewUser(false);
      window.sessionStorage.removeItem("pendingOnboardingConnectorSlug");
      setScreen("login");
    } catch {
      // toast.promise renders the actionable error for this terminal auth flow.
    }
  }

  async function authorizeConnector(slug: string, options: { onboarding?: boolean } = {}) {
    try {
      if (showOnboardingDemo) {
        const connectedAt = `demo-${slug}-account`;
        setConnectors((current) => current.map((connector) => connector.slug === slug
          ? {
              ...connector,
              connected: true,
              enabled: true,
              connectionStatus: "connected",
              connectedAccountId: connector.connectedAccountId ?? connectedAt,
              config: {
                ...connector.config,
                myDayEnabled: true,
                personalIntelligenceEnabled: true,
              },
            }
          : connector));
        setSelectedConnector((current) => current && current.slug === slug
          ? {
              ...current,
              connected: true,
              enabled: true,
              connectionStatus: "connected",
              connectedAccountId: current.connectedAccountId ?? connectedAt,
              config: {
                ...current.config,
                myDayEnabled: true,
                personalIntelligenceEnabled: true,
              },
            }
          : current);
        if (options.onboarding) {
          setOnboardingStep("connect");
        }
        toast.success(`${connectorNameForSlug(slug)} connected`);
        return;
      }

      const result = await api<{ redirectUrl: string }>("/connectors/authorize", {
        method: "POST",
        body: JSON.stringify({ slug, ...(options.onboarding ? { returnTo: "onboarding" } : {}) }),
      });
      const connector = connectors.find((item) => item.slug === slug);
      window.sessionStorage.setItem("pendingConnectorSlug", slug);
      if (options.onboarding) {
        window.sessionStorage.setItem("pendingOnboardingConnectorSlug", slug);
      } else {
        window.sessionStorage.removeItem("pendingOnboardingConnectorSlug");
      }
      if (connector?.connectedAccountId) {
        window.sessionStorage.setItem("pendingConnectorAccountId", connector.connectedAccountId);
      } else {
        window.sessionStorage.removeItem("pendingConnectorAccountId");
      }
      window.location.href = result.redirectUrl;
    } catch (error) {
      notifyError(error, "Could not start connector auth.");
    }
  }

  const connectorDeleteImpactReady = !pendingConnectorDelete
    || pendingConnectorDelete.type === "mcp"
    || (
      connectorDisconnectImpactSlug === pendingConnectorDelete.slug
      && !connectorDisconnectImpactLoading
      && !connectorDisconnectImpactError
      && connectorDisconnectImpact?.toolkitSlug === pendingConnectorDelete.slug
    );

  return (
    <>
      <AppToaster />
      <SilkSheetStack.Root className="silk-sheet-stack">
      <SilkSheet.Root
        className="silk-root"
        license="non-commercial"
        forComponent="closest"
        presented={sheet !== null}
        onPresentedChange={(presented) => {
          if (!presented) {
            if (onboardingRequired && sheet === "onboarding") {
              setSheet("onboarding");
              setMountedSheet("onboarding");
              return;
            }
            closeSheet();
          }
        }}
        onSafeToUnmountChange={(safeToUnmount) => {
          if (safeToUnmount && sheet === null) {
            setMountedSheet(null);
          }
        }}
        sheetRole="dialog"
      >
        <SilkSheet.Outlet asChild>
          <div className={`app-shell app-shell-${screen}`} data-silk-sheet-wrapper="">
            <AppBackground />
            {screen === "loading" ? <LoadingView label="Loading Finn..." /> : null}
            {screen === "login" ? (
              <LoginScreen
                phoneNumber={phoneNumber}
                countryCode={countryCode}
                greeting={authGreeting}
                loading={authLoading}
                AuthTopBarComponent={AuthTopBar}
                onPhoneChange={setPhoneNumber}
                onCountryChange={changeCountry}
                onSubmit={requestCode}
              />
            ) : null}
            {screen === "verify" ? (
              <VerifyScreen
                code={code}
                loading={authLoading}
                phoneNumber={submittedPhoneNumber || normalizePhoneForCountry(phoneNumber, countryCode)}
                AuthTopBarComponent={AuthTopBar}
                onCodeChange={setCode}
                onSubmit={verifyCode}
                onBack={() => setScreen("login")}
              />
            ) : null}
            {screen === "signup-handoff" && user ? (
              <SignupHandoffScreen
                finnPhoneNumber={finnPhoneNumber}
                AuthTopBarComponent={AuthTopBar}
                onOpenMessages={triggerHapticFeedback}
                onContinue={() => setScreen("dashboard")}
              />
            ) : null}
            {screen === "dashboard" && user ? (
              <Dashboard
                user={user}
                theme={appTheme}
                dayLabel={dayLabel}
                greeting={greeting}
                weatherText={weatherText}
                weatherLoading={weatherLoading}
                finnPhoneNumber={finnPhoneNumber}
                onOpenSheet={openSheet}
                onTextFinnClick={triggerHapticFeedback}
              />
            ) : null}
          </div>
        </SilkSheet.Outlet>
        {mountedSheet === "settings" && user ? (
          <Suspense fallback={null}>
            <SettingsSheet
              key={`settings-${sheetRenderKey}`}
              user={user}
              saving={profileSaving}
              savingField={profileSavingField}
              profileImageUploading={profileImageUploading}
              SheetComponent={Sheet}
              onHapticFeedback={triggerHapticFeedback}
              onSave={saveProfile}
              onProfileImageUpload={uploadProfileImage}
              onLogout={logout}
              onOpenTimeZonePicker={openTimeZoneSheet}
            />
          </Suspense>
        ) : null}
        {mountedSheet === "onboarding" && user ? (
          <Suspense fallback={null}>
            <OnboardingSheet
              key={`onboarding-${sheetRenderKey}`}
              user={user}
              step={onboardingStep}
              connectors={sortedConnectors}
              connectorLoading={connectorLoading}
              profileSaving={profileSaving}
              completing={onboardingCompleting}
              finnPhoneNumber={finnPhoneNumber}
              SheetComponent={Sheet}
              onStepChange={setOnboardingStep}
              onSaveProfile={saveOnboardingProfile}
              onSuggestHomeLocation={suggestHomeLocation}
              onAuthorizeConnector={(slug) => void authorizeConnector(slug, { onboarding: true })}
              onReloadConnectors={() => void loadConnectors()}
              onMessageFinn={() => void completeOnboardingAndMessageFinn()}
            />
          </Suspense>
        ) : null}
        {mountedSheet === "my-day" && user ? (
          <Suspense fallback={null}>
            <MyDaySheet
              key={`my-day-${sheetRenderKey}`}
              SheetComponent={Sheet}
              page={myDayPage}
              loading={myDayLoading}
              savingTodoIds={myDaySavingTodoIds}
              onCreateTodo={(title) => void createMyDayTodo(title)}
              onUpdateTodo={(todo, patch) => void updateMyDayTodo(todo, patch)}
              onHandoff={(todo, context) => {
                triggerHapticFeedback();
                void handoffMyDayTodo(todo, context);
              }}
              onRequestDelete={(todo) => {
                triggerHapticFeedback();
                setPendingMyDayTodoAction({ type: "delete", todo });
              }}
              onHaptic={triggerHapticFeedback}
            />
          </Suspense>
        ) : null}
        {mountedSheet === "patterns" && user ? (
          <Suspense fallback={null}>
            <PatternsSheet
              key={`patterns-${sheetRenderKey}`}
              patterns={sortedPatterns}
              connectors={sortedConnectors}
              loading={patternLoading}
              pausingPatternIds={pausingPatternIds}
              onPause={(pattern) => void pausePattern(pattern)}
              onReconnectConnector={reconnectConnector}
              onShowActivity={showPatternActivity}
              onRequestDelete={requestDeletePattern}
              SheetComponent={Sheet}
              onHapticFeedback={triggerHapticFeedback}
            />
          </Suspense>
        ) : null}
        {mountedSheet === "library" && user ? (
          <Suspense fallback={null}>
            <LibrarySheet
              key={`library-${sheetRenderKey}`}
              page={libraryPage}
              loading={libraryLoading}
              saving={librarySaving}
              onOpenFolder={(folderId) => void loadLibrary(folderId)}
              onCreateFolder={(name, parentId) => void createLibraryFolder(name, parentId)}
              onUploadFile={(file, folderId) => void uploadLibraryFile(file, folderId)}
              onMoveFile={(fileId, folderId) => void moveLibraryFile(fileId, folderId)}
              onDeleteFile={(file) => void deleteLibraryFile(file)}
              onDeleteFolder={(folder) => void deleteLibraryFolder(folder)}
              SheetComponent={Sheet}
            />
          </Suspense>
        ) : null}
        {mountedSheet === "connectors" && user ? (
          <Suspense fallback={null}>
            <ConnectorsSheet
              key={`connectors-${sheetRenderKey}`}
              connectors={sortedConnectors}
              mcpServers={sortedMcpServers}
              loading={connectorLoading}
              mcpLoading={mcpLoading}
              selectedConnector={selectedConnector}
              selectedMcpServer={selectedMcpServer}
              addingMcpServer={addingMcpServer}
              selectedLoading={selectedConnectorLoading}
              savingConfig={connectorConfigSaving}
              savingMcpServer={mcpServerSaving}
              hasMore={Boolean(connectorCursor)}
              loadingMore={connectorLoadingMore}
              onAuthorize={authorizeConnector}
              onSelect={loadConnectorDetails}
              onSelectMcpServer={(id) => {
                setSelectedConnector(null);
                setSelectedConnectorSlug(null);
                setAddingMcpServer(false);
                setSelectedMcpServerId(id);
              }}
              onStartAddMcpServer={() => {
                setSelectedConnector(null);
                setSelectedConnectorSlug(null);
                setSelectedMcpServerId(null);
                setAddingMcpServer(true);
              }}
              onCreateMcpServer={createMcpServer}
              onToggleMcpServer={toggleMcpServer}
              onRequestDeleteMcpServer={requestDeleteMcpServer}
              onBackToList={() => {
                setSelectedConnector(null);
                setSelectedConnectorSlug(null);
                setSelectedMcpServerId(null);
                setAddingMcpServer(false);
              }}
              onSaveConfig={saveConnectorConfig}
              onReconnect={reconnectConnector}
              onRequestDelete={requestDeleteConnector}
              onLoadMore={() => loadConnectors({ append: true })}
              SheetComponent={Sheet}
              onHapticFeedback={triggerHapticFeedback}
            />
          </Suspense>
        ) : null}
      </SilkSheet.Root>
      {timeZoneSheet ? (
        <Suspense fallback={null}>
          <TimeZoneSheet
            value={timeZoneSheet.value}
            onClose={closeTimeZoneSheet}
            onSelect={(timezone) => {
              timeZoneSheet.onSelect(timezone);
              closeTimeZoneSheet();
            }}
          />
        </Suspense>
      ) : null}
      {pendingDeletePattern ? (
        <ConfirmSheet
          title="Delete pattern?"
          message={`${pendingDeletePattern.name} will be removed from Finn.`}
          confirmLabel="Delete"
          onCancel={closeDeleteConfirmSheet}
          onConfirm={() => {
            triggerHapticFeedback();
            void deletePattern(pendingDeletePattern.id);
            setPendingDeletePattern(null);
          }}
        />
      ) : null}
      {activityPattern ? (
        <Suspense fallback={null}>
          <PatternActivitySheet
            pattern={activityPattern}
            runs={patternRuns[activityPattern.id] ?? []}
            loading={Boolean(patternRunsLoading[activityPattern.id])}
            onClose={closePatternActivitySheet}
            StandaloneSheetComponent={StandaloneSheet}
            fallbackRuns={showDemoData ? demoPatternRuns : undefined}
          />
        </Suspense>
      ) : null}
      {pendingConnectorDelete ? (
        <ConfirmSheet
          title={pendingConnectorDelete.type === "mcp" ? "Disconnect server?" : "Disconnect connector?"}
          message={`${pendingConnectorDelete.name} will be disconnected from Finn.`}
          confirmLabel="Disconnect"
          confirmDisabled={!connectorDeleteImpactReady}
          onCancel={closeConnectorDeleteConfirmSheet}
          onConfirm={() => {
            if (!connectorDeleteImpactReady) return;
            triggerHapticFeedback();
            if (pendingConnectorDelete.type === "mcp") {
              void deleteMcpServer(pendingConnectorDelete.id);
            } else {
              void deleteConnector(pendingConnectorDelete.slug);
            }
            setPendingConnectorDelete(null);
            setConnectorDisconnectImpact(null);
            setConnectorDisconnectImpactSlug(null);
            setConnectorDisconnectImpactError(false);
          }}
        >
          {pendingConnectorDelete.type === "connector" ? (
            <ConnectorDisconnectImpactCard impact={connectorDisconnectImpact} loading={connectorDisconnectImpactLoading} />
          ) : null}
        </ConfirmSheet>
      ) : null}
      {pendingMyDayTodoAction ? (
        <ConfirmSheet
          title="Archive todo?"
          message={`"${pendingMyDayTodoAction.todo.title}" will be archived from My Day.`}
          confirmLabel="Archive"
          onCancel={closeMyDayTodoActionSheet}
          onConfirm={() => {
            triggerHapticFeedback();
            void deleteMyDayTodo(pendingMyDayTodoAction.todo);
            setPendingMyDayTodoAction(null);
          }}
        />
      ) : null}
      </SilkSheetStack.Root>
    </>
  );
}

installDisplayModeAttribute();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  });
}
