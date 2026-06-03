import {
  ArrowLeft01Icon,
  AuthorizedIcon,
  AiBrain01Icon,
  Calendar02Icon,
  Delete02Icon,
  LaptopIcon,
  Link01Icon,
  LockedIcon,
  Message02Icon,
  Note02Icon,
  PauseIcon,
  PlayIcon,
  Refresh01Icon,
  Refresh04Icon,
  Search01Icon,
  Share07Icon,
  Time02Icon,
  UserCircleIcon,
  ViewIcon,
  TouchInteraction02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import ContentLoader from "react-content-loader";

import { DashRing } from "./components/loading-ui/dash-ring";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { ConnectorGlyph, ConnectorLogo } from "./connector-glyph";
import { titleCaseStatus } from "./connector-status";
import { cn } from "./lib/utils";
import { LoadingView } from "./loading-view";
import { PageTransition, useOrderedPageDirection } from "./page-transition";
import { SegmentedControl, type SegmentedOption } from "./segmented-control";
import type { Connector, ConnectorConfig, ConnectorConfigPatch, ConnectorDetails, ConnectorPermissionMode, McpServer, McpServerDraft, PuterSourceAvailability } from "./web-types";

type ConnectorFilter = "apps" | "mcp" | "puter";
type ConnectorSheetView = "list" | "connector-detail" | "mcp-detail" | "add-mcp";

const defaultMcpServerDraft = (): McpServerDraft => ({
  name: "",
  url: "",
  description: "",
  authMode: "none",
  authHeaderName: "Authorization",
  authHeaderValue: "",
  authToken: "",
});

const connectorFilterOptions = [
  { value: "apps", label: "Apps", icon: <HugeiconsIcon icon={Share07Icon} size={15} strokeWidth={2} aria-hidden="true" /> },
  { value: "mcp", label: "MCP", icon: <HugeiconsIcon icon={Link01Icon} size={15} strokeWidth={2} aria-hidden="true" /> },
  { value: "puter", label: "Puter", icon: <HugeiconsIcon icon={LaptopIcon} size={15} strokeWidth={2} aria-hidden="true" /> },
] as const satisfies ReadonlyArray<SegmentedOption<ConnectorFilter>>;

const connectorFilterValues = ["apps", "mcp", "puter"] as const satisfies readonly ConnectorFilter[];
const primaryConnectorSlugs = new Set(["gmail", "outlook"]);

const mcpAuthOptions = [
  { value: "none", label: "None" },
  { value: "api_key", label: "API key", icon: <HugeiconsIcon icon={AuthorizedIcon} size={15} strokeWidth={2} aria-hidden="true" /> },
  { value: "oauth", label: "OAuth", icon: <HugeiconsIcon icon={UserCircleIcon} size={15} strokeWidth={2} aria-hidden="true" /> },
] as const satisfies ReadonlyArray<SegmentedOption<McpServerDraft["authMode"]>>;

const connectorPermissionOptions = [
  { value: "read_only", label: "Read only", icon: <HugeiconsIcon icon={ViewIcon} size={15} strokeWidth={2} aria-hidden="true" /> },
  { value: "all", label: "Read + actions", icon: <HugeiconsIcon icon={TouchInteraction02Icon} size={15} strokeWidth={2} aria-hidden="true" /> },
] as const satisfies ReadonlyArray<SegmentedOption<ConnectorPermissionMode>>;

const skeletonColors = {
  backgroundColor: "#f6f6f6",
  foregroundColor: "#ededed",
};

function isConnectorStatusOnline(connector: Pick<Connector, "slug" | "connected" | "connectionStatus">): boolean {
  return connector.slug === "puter"
    ? connector.connectionStatus === "connected"
    : connector.connected;
}

function isPrimaryConnectorSlug(slug: string): boolean {
  return primaryConnectorSlugs.has(slug.trim().toLowerCase());
}

function titleCasePermissionMode(mode: ConnectorPermissionMode): string {
  if (mode === "read_only") return "Read only";
  if (mode === "all") return "Read + actions";
  return "Custom";
}

function mcpServerEndpoint(server: McpServer): string {
  return server.transport.url ?? server.transport.command ?? server.transport.type;
}

function mcpServerLogoUrl(server: McpServer): string | undefined {
  return server.logo;
}

function mcpServerStatusLabel(server: McpServer): string {
  if (!server.active) return "Paused";
  if (server.error) return "Needs attention";
  if (server.connected) return "Connected";
  return "Needs attention";
}

function RailTabs<T extends string>(props: {
  value: T;
  options: readonly SegmentedOption<T>[];
  ariaLabel: string;
  disabled?: boolean;
  onValueChange: (value: T) => void;
  onHaptic?: () => void;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const buttonRefs = useRef(new Map<T, HTMLButtonElement>());
  const [indicator, setIndicator] = useState({ x: 0, width: 0, ready: false });

  useLayoutEffect(() => {
    const root = rootRef.current;
    const activeButton = buttonRefs.current.get(props.value);
    if (!root || !activeButton) {
      setIndicator((current) => current.ready ? { ...current, ready: false } : current);
      return;
    }

    const updateIndicator = () => {
      const rootRect = root.getBoundingClientRect();
      const buttonRect = activeButton.getBoundingClientRect();
      setIndicator({
        x: buttonRect.left - rootRect.left,
        width: buttonRect.width,
        ready: true,
      });
    };

    updateIndicator();

    const resizeObserver = new ResizeObserver(updateIndicator);
    resizeObserver.observe(root);
    resizeObserver.observe(activeButton);
    return () => {
      resizeObserver.disconnect();
    };
  }, [props.value]);

  return (
    <div
      ref={rootRef}
      className="rail-tabs"
      role="radiogroup"
      aria-label={props.ariaLabel}
      aria-disabled={props.disabled || undefined}
    >
      <div
        aria-hidden="true"
        className="rail-tabs-indicator"
        style={{
          width: indicator.width,
          transform: `translate3d(${indicator.x}px, 0, 0)`,
          opacity: indicator.ready ? 1 : 0,
        }}
      />
      {props.options.map((option) => {
        const active = option.value === props.value;
        return (
          <button
            key={option.value}
            ref={(node) => {
              if (node) {
                buttonRefs.current.set(option.value, node);
              } else {
                buttonRefs.current.delete(option.value);
              }
            }}
            className="rail-tabs-button"
            type="button"
            role="radio"
            aria-checked={active}
            disabled={props.disabled}
            onClick={() => {
              if (active || props.disabled) {
                return;
              }
              props.onHaptic?.();
              props.onValueChange(option.value);
            }}
          >
            <span className="rail-tabs-label">
              {option.icon}
              <span>{option.label}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function ConnectorsSheet(props: {
  connectors: Connector[];
  mcpServers: McpServer[];
  loading: boolean;
  mcpLoading: boolean;
  selectedConnector: ConnectorDetails | null;
  selectedMcpServer: McpServer | null;
  addingMcpServer: boolean;
  selectedLoading: boolean;
  savingConfig: boolean;
  savingMcpServer: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  onAuthorize: (slug: string) => void;
  onSelect: (slug: string) => void;
  onSelectMcpServer: (id: string) => void;
  onStartAddMcpServer: () => void;
  onCreateMcpServer: (draft: McpServerDraft) => void;
  onToggleMcpServer: (id: string, active: boolean) => void;
  onRequestDeleteMcpServer: (server: McpServer) => void;
  onBackToList: () => void;
  onSaveConfig: (patch: ConnectorConfigPatch, slug?: string) => void;
  onReconnect: (slug: string, previousConnectedAccountId?: string) => void;
  onRequestDelete: (connector: ConnectorDetails) => void;
  onLoadMore: () => void;
  SheetComponent: (props: { title: string; children: ReactNode; onBack?: () => void; backLabel?: string; locked?: boolean; className?: string }) => ReactNode;
  onHapticFeedback: () => void;
}) {
  const SheetComponent = props.SheetComponent;
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ConnectorFilter>("apps");
  const [mcpDraft, setMcpDraft] = useState<McpServerDraft>(defaultMcpServerDraft);

  const puterConnector = useMemo(
    () => props.connectors.find((connector) => connector.slug === "puter") ?? null,
    [props.connectors],
  );

  const visibleConnectors = useMemo(() => {
    const search = query.trim().toLowerCase();

    return props.connectors.filter((connector) => {
      if (connector.slug === "puter") {
        return false;
      }

      if (!search) {
        return true;
      }

      return connector.name.toLowerCase().includes(search) || connector.slug.toLowerCase().includes(search);
    });
  }, [props.connectors, query]);

  const visibleMcpServers = useMemo(() => {
    const search = query.trim().toLowerCase();

    return props.mcpServers.filter((server) => {
      if (!search) {
        return true;
      }

      return server.name.toLowerCase().includes(search)
        || mcpServerEndpoint(server).toLowerCase().includes(search);
    });
  }, [props.mcpServers, query]);

  const listLoading = filter === "apps" ? props.loading : filter === "mcp" ? props.mcpLoading : props.loading;
  const emptyMessage = filter === "apps"
    ? "No apps match this search."
    : filter === "mcp"
      ? "No MCP servers match this search."
      : "Puter is not available right now.";
  const showSearch = filter !== "puter";
  const showLoadMore = filter === "apps" && props.hasMore;
  const connectorView: ConnectorSheetView = props.addingMcpServer
    ? "add-mcp"
    : props.selectedMcpServer
      ? "mcp-detail"
      : props.selectedConnector || props.selectedLoading
        ? "connector-detail"
        : "list";
  const connectorViewDirection = connectorView === "list" ? "back" : "forward";
  const filterDirection = useOrderedPageDirection(filter, connectorFilterValues);

  useEffect(() => {
    if (props.addingMcpServer) {
      setMcpDraft(defaultMcpServerDraft());
    }
  }, [props.addingMcpServer]);

  if (props.addingMcpServer) {
    function handleBackToList() {
      props.onHapticFeedback();
      setMcpDraft(defaultMcpServerDraft());
      props.onBackToList();
    }

    return (
      <SheetComponent title="Add MCP" onBack={handleBackToList} backLabel="Back to connectors">
        <PageTransition pageKey={connectorView} direction={connectorViewDirection} className="sheet-view-slide">
          <form
            className="connector-detail"
            onSubmit={(event) => {
              event.preventDefault();
              props.onCreateMcpServer(mcpDraft);
            }}
          >
            <section className="connector-detail-section connector-card">
              <h3>Remote server</h3>
              <div className="mcp-form">
                <label className="pattern-field">
                  <span>Name</span>
                  <Input value={mcpDraft.name} onChange={(event) => setMcpDraft((current) => ({ ...current, name: event.target.value }))} placeholder="browser-use" required />
                </label>
                <label className="pattern-field">
                  <span>Server URL</span>
                  <Input value={mcpDraft.url} onChange={(event) => setMcpDraft((current) => ({ ...current, url: event.target.value }))} placeholder="https://example.com/mcp" required />
                </label>
                <label className="pattern-field">
                  <span>Description</span>
                  <textarea value={mcpDraft.description} onChange={(event) => setMcpDraft((current) => ({ ...current, description: event.target.value }))} placeholder="Optional notes" />
                </label>
                <div className="pattern-field">
                  <span>Authentication</span>
                  <RailTabs
                    ariaLabel="MCP authentication"
                    options={mcpAuthOptions}
                    value={mcpDraft.authMode}
                    onValueChange={(authMode) => setMcpDraft((current) => ({ ...current, authMode }))}
                  />
                </div>
                <div className="api-key-fields" data-state={mcpDraft.authMode === "api_key" ? "open" : "closed"} aria-hidden={mcpDraft.authMode !== "api_key"}>
                  <div className="api-key-fields-inner">
                    <label className="pattern-field">
                      <span>Header</span>
                      <Input disabled={mcpDraft.authMode !== "api_key"} value={mcpDraft.authHeaderName} onChange={(event) => setMcpDraft((current) => ({ ...current, authHeaderName: event.target.value }))} placeholder="Authorization" />
                    </label>
                    <label className="pattern-field">
                      <span>Value</span>
                      <Input disabled={mcpDraft.authMode !== "api_key"} value={mcpDraft.authHeaderValue} onChange={(event) => setMcpDraft((current) => ({ ...current, authHeaderValue: event.target.value }))} placeholder="Bearer token or API key" type="password" />
                    </label>
                  </div>
                </div>
              </div>
            </section>
            <Button className="load-more-connectors" type="submit" disabled={props.savingMcpServer}>
              {props.savingMcpServer ? "Connecting..." : "Add server"}
            </Button>
          </form>
        </PageTransition>
      </SheetComponent>
    );
  }

  if (props.selectedMcpServer) {
    const server = props.selectedMcpServer;

    function handleBackToList() {
      props.onHapticFeedback();
      props.onBackToList();
    }

    return (
      <SheetComponent title={server.name} onBack={handleBackToList} backLabel="Back to connectors">
        <PageTransition pageKey={connectorView} direction={connectorViewDirection} className="sheet-view-slide">
          <div className="connector-detail">
            <div className="connector-detail-section connector-detail-head">
              <span className="connector-identity">
                <ConnectorLogo src={mcpServerLogoUrl(server)} fallback={server.name.slice(0, 1)} large />
                <strong>{server.name}</strong>
              </span>
              <span className={`connector-status ${server.connected ? "connected" : ""}`}>{mcpServerStatusLabel(server)}</span>
            </div>
            {server.description ? (
              <section className="connector-detail-section connector-description-section">
                <p>{server.description}</p>
              </section>
            ) : null}
            <section className="connector-detail-section connector-card">
              <h3>Endpoint</h3>
              <p>{mcpServerEndpoint(server)}</p>
              <div className="mcp-chip-list">
                <span>{server.transport.type.toUpperCase()}</span>
                {server.authMode === "oauth" ? <span>OAuth</span> : null}
                <span>{server.toolCount} tools</span>
                {server.resourceCount ? <span>{server.resourceCount} resources</span> : null}
                {server.transport.hasAuthToken ? <span>Bearer auth</span> : null}
              </div>
            </section>
            <div className="connector-detail-section connector-list profile-option-list profile-stack connector-management-actions">
              <button className="connector-row profile-option-row profile-option-row-joins-next" type="button" disabled={props.savingMcpServer} onClick={() => props.onToggleMcpServer(server.id, !server.active)}>
                <span className="connector-row-top">
                  <span className="connector-row-head">
                    <HugeiconsIcon className="profile-option-icon" icon={server.active ? PauseIcon : PlayIcon} size={23} strokeWidth={1.9} aria-hidden="true" />
                    <strong className="profile-option-label">{server.active ? "Pause" : "Resume"}</strong>
                  </span>
                  <HugeiconsIcon className="connector-chevron" icon={ArrowLeft01Icon} size={18} strokeWidth={2.1} aria-hidden="true" />
                </span>
              </button>
              <button className="connector-row profile-option-row profile-option-row-joined connector-management-action-danger" type="button" disabled={props.savingMcpServer} onClick={() => props.onRequestDeleteMcpServer(server)}>
                <span className="connector-row-top">
                  <span className="connector-row-head">
                    <HugeiconsIcon className="profile-option-icon" icon={Delete02Icon} size={23} strokeWidth={1.9} aria-hidden="true" />
                    <strong className="profile-option-label">Disconnect</strong>
                  </span>
                  <HugeiconsIcon className="connector-chevron" icon={ArrowLeft01Icon} size={18} strokeWidth={2.1} aria-hidden="true" />
                </span>
              </button>
            </div>
          </div>
        </PageTransition>
      </SheetComponent>
    );
  }

  if (props.selectedConnector || props.selectedLoading) {
    const connector = props.selectedConnector;
    const puterNeedsSetup = connector?.slug === "puter" && !connector.connected;
    const puterOnline = connector?.slug === "puter" ? isConnectorStatusOnline(connector) : true;
    const primaryConnector = connector ? isPrimaryConnectorSlug(connector.slug) : false;

    function handleBackToList() {
      props.onHapticFeedback();
      props.onBackToList();
    }

    return (
      <SheetComponent title={connector?.name ?? "Connector"} onBack={handleBackToList} backLabel="Back to connectors">
        <PageTransition pageKey={connectorView} direction={connectorViewDirection} className="sheet-view-slide">
          <div className="connector-sheet-body">
            {props.selectedLoading ? <LoadingView label="Loading connector..." /> : null}
            {connector ? (
              <div className="connector-detail">
                <div className="connector-detail-section connector-detail-head">
                  <span className="connector-identity">
                    <ConnectorGlyph connector={connector} large />
                    <strong>{connector.name}</strong>
                  </span>
                  <span className={`connector-status ${isConnectorStatusOnline(connector) ? "connected" : ""}`}>{titleCaseStatus(connector.connectionStatus, connector.connected)}</span>
                </div>
                {connector.description ? (
                  <section className="connector-detail-section connector-description-section">
                    <p>{connector.description}</p>
                  </section>
                ) : null}
                {puterNeedsSetup ? (
                  <section className="connector-detail-section connector-card">
                    <h3>Set up Finn Puter</h3>
                    <p>Open Finn Puter on your Mac and sign in to this Finn account. Once the Mac is paired, iMessage and Notes controls will appear here.</p>
                  </section>
                ) : (
                  <section className="connector-detail-section connector-settings-section">
                    <h3 className="connector-settings-title">Settings</h3>
                    {connector.slug === "puter" ? (
                      <div className="connector-list profile-option-list profile-stack connector-settings-group">
                        {!puterOnline ? (
                          <p className="connector-settings-caption">Open Finn Puter on your Mac to change these settings.</p>
                        ) : null}
                        <PuterConnectorToolRow
                          icon={Message02Icon}
                          label="iMessage"
                          description={puterSourceDescription("Allow Finn to read your iMessages.", connector.config.puter?.sources?.imessage, puterOnline)}
                          enabled={connector.config.puter?.imessageEnabled ?? false}
                          personalIntelligenceEnabled={connector.config.puter?.imessagePersonalIntelligenceEnabled ?? false}
                          availability={connector.config.puter?.sources?.imessage}
                          disabled={props.savingConfig || !puterOnline}
                          joinsNext
                          onToggleEnabled={(imessageEnabled) => props.onSaveConfig({
                            puter: {
                              imessageEnabled,
                              imessagePersonalIntelligenceEnabled: imessageEnabled
                                ? connector.config.puter?.imessagePersonalIntelligenceEnabled ?? false
                                : false,
                            },
                          }, "puter")}
                          onTogglePersonalIntelligence={(imessagePersonalIntelligenceEnabled) => props.onSaveConfig({ puter: { imessagePersonalIntelligenceEnabled } }, "puter")}
                        />
                        <PuterConnectorToolRow
                          icon={Note02Icon}
                          label="Notes"
                          description={puterSourceDescription("Allow Finn to read your Notes.", connector.config.puter?.sources?.notes, puterOnline)}
                          enabled={connector.config.puter?.notesEnabled ?? false}
                          personalIntelligenceEnabled={connector.config.puter?.notesPersonalIntelligenceEnabled ?? false}
                          availability={connector.config.puter?.sources?.notes}
                          disabled={props.savingConfig || !puterOnline}
                          joined
                          onToggleEnabled={(notesEnabled) => props.onSaveConfig({
                            puter: {
                              notesEnabled,
                              notesPersonalIntelligenceEnabled: notesEnabled
                                ? connector.config.puter?.notesPersonalIntelligenceEnabled ?? false
                                : false,
                            },
                          }, "puter")}
                          onTogglePersonalIntelligence={(notesPersonalIntelligenceEnabled) => props.onSaveConfig({ puter: { notesPersonalIntelligenceEnabled } }, "puter")}
                        />
                      </div>
                    ) : (
                      <div className="connector-list profile-option-list profile-stack connector-settings-group">
                        {primaryConnector ? (
                          <p className="connector-settings-caption">{connector.name} is a primary connector for Finn, so My Day and Personal Intelligence stay enabled.</p>
                        ) : null}
                        <div className="connector-row profile-option-row profile-option-row-joins-next connector-setting-row connector-setting-row-stacked">
                          <span className="connector-row-top">
                            <span className="connector-row-head">
                              <HugeiconsIcon className="profile-option-icon" icon={LockedIcon} size={23} strokeWidth={1.9} aria-hidden="true" />
                              <strong className="profile-option-label">Permissions</strong>
                            </span>
                          </span>
                          <p>Read only limits Finn to browsing only. Read + actions allows Finn to perform actions on your behalf.</p>
                          <RailTabs
                            ariaLabel="Connector permissions"
                            options={connectorPermissionOptions}
                            value={connector.config.permissionMode}
                            disabled={props.savingConfig}
                            onValueChange={(permissionMode) => props.onSaveConfig({ permissionMode })}
                          />
                        </div>
                        <ConnectorSettingToggleRow
                          icon={Calendar02Icon}
                          label="My Day"
                          checked={primaryConnector || connector.config.myDayEnabled}
                          disabled={props.savingConfig || primaryConnector}
                          joined
                          joinsNext={connector.config.personalIntelligenceAvailable || (connector.connected && connector.config.personalIntelligenceIdentityStatus !== "unsupported")}
                          onChange={(myDayEnabled) => props.onSaveConfig({ myDayEnabled })}
                        />
                        {connector.config.personalIntelligenceAvailable ? (
                          <ConnectorSettingToggleRow
                            icon={AiBrain01Icon}
                            label="Personal intelligence"
                            checked={primaryConnector || connector.config.personalIntelligenceEnabled}
                            disabled={props.savingConfig || primaryConnector}
                            joined
                            onChange={(personalIntelligenceEnabled) => props.onSaveConfig({ personalIntelligenceEnabled })}
                          />
                        ) : connector.connected && connector.config.personalIntelligenceIdentityStatus !== "unsupported" ? (
                          <div className="connector-row profile-option-row profile-option-row-joined connector-setting-row">
                            <span className="connector-row-top">
                              <span className="connector-row-head">
                                <HugeiconsIcon className="profile-option-icon" icon={AiBrain01Icon} size={23} strokeWidth={1.9} aria-hidden="true" />
                                <strong className="profile-option-label">Personal intelligence</strong>
                              </span>
                            </span>
                            <p>{personalIntelligenceStatusMessage(connector.config.personalIntelligenceIdentityStatus)}</p>
                          </div>
                        ) : null}
                      </div>
                    )}
                  </section>
                )}
                {connector.slug !== "puter" ? <div className="connector-detail-section connector-list profile-option-list profile-stack connector-management-actions">
                  <button className="connector-row profile-option-row profile-option-row-joins-next" type="button" onClick={() => props.onReconnect(connector.slug)}>
                    <span className="connector-row-top">
                      <span className="connector-row-head">
                        <HugeiconsIcon className="profile-option-icon" icon={Refresh04Icon} size={23} strokeWidth={1.9} aria-hidden="true" />
                        <strong className="profile-option-label">Reconnect</strong>
                      </span>
                      <HugeiconsIcon className="connector-chevron" icon={ArrowLeft01Icon} size={18} strokeWidth={2.1} aria-hidden="true" />
                    </span>
                  </button>
                  <button className="connector-row profile-option-row profile-option-row-joined connector-management-action-danger" type="button" disabled={primaryConnector} onClick={() => props.onRequestDelete(connector)}>
                    <span className="connector-row-top">
                      <span className="connector-row-head">
                        <HugeiconsIcon className="profile-option-icon" icon={Delete02Icon} size={23} strokeWidth={1.9} aria-hidden="true" />
                        <strong className="profile-option-label">Disconnect</strong>
                      </span>
                      <HugeiconsIcon className="connector-chevron" icon={ArrowLeft01Icon} size={18} strokeWidth={2.1} aria-hidden="true" />
                    </span>
                    {primaryConnector ? <span className="connector-row-caption">Primary connector cannot be disabled.</span> : null}
                  </button>
                </div> : null}
              </div>
            ) : null}
          </div>
        </PageTransition>
      </SheetComponent>
    );
  }

  return (
    <SheetComponent title="Connectors">
      <PageTransition pageKey={connectorView} direction={connectorViewDirection} className="sheet-view-slide">
        <div className="connector-sheet-body">
          <div className="connector-toolbar">
            <SegmentedControl
              className="sheet-segmented-control"
              value={filter}
              options={connectorFilterOptions}
              ariaLabel="Filter connectors"
              onValueChange={(value) => {
                setFilter(value);
                setQuery("");
              }}
              onHaptic={props.onHapticFeedback}
            />
            <button
              className="add-mcp-button"
              type="button"
              aria-hidden={filter !== "mcp"}
              data-visible={filter === "mcp" || undefined}
              disabled={filter !== "mcp"}
              tabIndex={filter === "mcp" ? 0 : -1}
              onClick={props.onStartAddMcpServer}
            >
              <span>+ Add</span>
            </button>
          </div>
          {showSearch ? (
            <label className="connector-search">
              <Input
                className="connector-search-input"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={filter === "apps" ? "Search apps" : "Search MCP servers"}
                aria-label={filter === "apps" ? "Search apps" : "Search MCP servers"}
              />
            </label>
          ) : null}
          <PageTransition pageKey={filter} direction={filterDirection} className="sheet-tab-slide">
            {filter === "puter" ? (
              listLoading ? <LoadingView label="Loading Puter..." /> : (
                puterConnector ? (
                  <PuterConnectorDetail connector={puterConnector} savingConfig={props.savingConfig} onSaveConfig={props.onSaveConfig} />
                ) : <p className="empty-state">{emptyMessage}</p>
              )
            ) : (
              <div className="connector-list">
                {listLoading ? <ConnectorListSkeleton /> : null}
                {!listLoading && filter === "apps" && visibleConnectors.length === 0 ? <p className="empty-state">{emptyMessage}</p> : null}
                {!listLoading && filter === "mcp" && visibleMcpServers.length === 0 ? <p className="empty-state">{emptyMessage}</p> : null}
                {!listLoading && filter === "apps" && visibleConnectors.map((connector, index) => (
                  <button
                    className={cn(
                      "connector-row",
                      index > 0 && "connector-row-joined",
                      index < visibleConnectors.length - 1 && "connector-row-joins-next",
                    )}
                    type="button"
                    key={connector.slug}
                    onClick={() => {
                      props.onHapticFeedback();
                      if (connector.connected) {
                        props.onSelect(connector.slug);
                        return;
                      }
                      props.onAuthorize(connector.slug);
                    }}
                  >
                    <span className="connector-row-top">
                      <span className="connector-row-head">
                        <ConnectorGlyph connector={connector} />
                        <strong>{connector.name}</strong>
                        {connector.connected ? <span className="status-dot connected" /> : null}
                      </span>
                      <HugeiconsIcon className="connector-chevron" icon={ArrowLeft01Icon} size={20} strokeWidth={2.1} aria-hidden="true" />
                    </span>
                  </button>
                ))}
                {!listLoading && filter === "mcp" && visibleMcpServers.map((server, index) => (
                  <button
                    className={cn(
                      "connector-row mcp-row",
                      index > 0 && "connector-row-joined",
                      index < visibleMcpServers.length - 1 && "connector-row-joins-next",
                    )}
                    type="button"
                    key={server.id}
                    onClick={() => {
                      props.onHapticFeedback();
                      props.onSelectMcpServer(server.id);
                    }}
                  >
                    <span className="connector-row-top">
                      <span className="connector-row-head">
                        <ConnectorLogo src={mcpServerLogoUrl(server)} fallback={server.name.slice(0, 1)} />
                        <strong>{server.name}</strong>
                        {server.connected ? <span className="status-dot connected" /> : null}
                      </span>
                      <span className="mcp-overflow" aria-hidden="true">
                      <HugeiconsIcon className="connector-chevron" icon={ArrowLeft01Icon} size={18} strokeWidth={2.1} aria-hidden="true" />
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            )}
            {showLoadMore ? (
              <Button className="load-more-connectors" type="button" disabled={props.loadingMore} onClick={props.onLoadMore}>
                {props.loadingMore ? "Loading..." : "Load more"}
              </Button>
            ) : null}
          </PageTransition>
        </div>
      </PageTransition>
    </SheetComponent>
  );
}

function PuterConnectorDetail(props: {
  connector: ConnectorDetails;
  savingConfig: boolean;
  onSaveConfig: (patch: ConnectorConfigPatch, slug?: string) => void;
}) {
  const puterNeedsSetup = !props.connector.connected;
  const puterOnline = isConnectorStatusOnline(props.connector);

  return (
    <div className="connector-detail puter-tab-detail">
      <div className="connector-detail-section connector-detail-head">
        <span className="connector-identity">
          <ConnectorGlyph connector={props.connector} large />
          <strong>{props.connector.name}</strong>
        </span>
        <span className={`connector-status ${isConnectorStatusOnline(props.connector) ? "connected" : ""}`}>
          {titleCaseStatus(props.connector.connectionStatus, props.connector.connected)}
        </span>
      </div>
      {props.connector.description ? (
        <section className="connector-detail-section connector-description-section">
          <p>{props.connector.description}</p>
        </section>
      ) : null}
      {puterNeedsSetup ? (
        <section className="connector-detail-section connector-card">
          <h3>Set up Finn Puter</h3>
          <p>Open Finn Puter on your Mac and sign in to this Finn account. Once the Mac is paired, iMessage and Notes controls will appear here.</p>
        </section>
      ) : (
        <section className="connector-detail-section connector-settings-section">
          <h3 className="connector-settings-title">Settings</h3>
          {!puterOnline ? (
            <p className="connector-settings-caption">Open Finn Puter on your Mac to change these settings.</p>
          ) : null}
          <div className="connector-list profile-option-list profile-stack connector-settings-group">
            <PuterConnectorToolRow
              icon={Message02Icon}
              label="iMessage"
              description={puterSourceDescription("Allow Finn to read your iMessages.", props.connector.config.puter?.sources?.imessage, puterOnline)}
              enabled={props.connector.config.puter?.imessageEnabled ?? false}
              personalIntelligenceEnabled={props.connector.config.puter?.imessagePersonalIntelligenceEnabled ?? false}
              availability={props.connector.config.puter?.sources?.imessage}
              disabled={props.savingConfig || !puterOnline}
              joinsNext
              onToggleEnabled={(imessageEnabled) => props.onSaveConfig({
                puter: {
                  imessageEnabled,
                  imessagePersonalIntelligenceEnabled: imessageEnabled
                    ? props.connector.config.puter?.imessagePersonalIntelligenceEnabled ?? false
                    : false,
                },
              }, "puter")}
              onTogglePersonalIntelligence={(imessagePersonalIntelligenceEnabled) => props.onSaveConfig({ puter: { imessagePersonalIntelligenceEnabled } }, "puter")}
            />
            <PuterConnectorToolRow
              icon={Note02Icon}
              label="Notes"
              description={puterSourceDescription("Allow Finn to read your Notes.", props.connector.config.puter?.sources?.notes, puterOnline)}
              enabled={props.connector.config.puter?.notesEnabled ?? false}
              personalIntelligenceEnabled={props.connector.config.puter?.notesPersonalIntelligenceEnabled ?? false}
              availability={props.connector.config.puter?.sources?.notes}
              disabled={props.savingConfig || !puterOnline}
              joined
              onToggleEnabled={(notesEnabled) => props.onSaveConfig({
                puter: {
                  notesEnabled,
                  notesPersonalIntelligenceEnabled: notesEnabled
                    ? props.connector.config.puter?.notesPersonalIntelligenceEnabled ?? false
                    : false,
                },
              }, "puter")}
              onTogglePersonalIntelligence={(notesPersonalIntelligenceEnabled) => props.onSaveConfig({ puter: { notesPersonalIntelligenceEnabled } }, "puter")}
            />
          </div>
        </section>
      )}
    </div>
  );
}

function puterSourceDescription(defaultDescription: string, availability: PuterSourceAvailability | undefined, online: boolean): string {
  return online && availability?.available === false ? availability.message : defaultDescription;
}

function personalIntelligenceStatusMessage(status: ConnectorConfig["personalIntelligenceIdentityStatus"]): string {
  if (status === "failed") {
    return "Finn could not verify a stable account identity for this connector. Reconnect it and try again.";
  }
  return "Finn is verifying this connector's account identity before Personal Intelligence can be enabled.";
}

function PuterConnectorToolRow(props: {
  icon: IconSvgElement;
  label: string;
  description: string;
  enabled: boolean;
  personalIntelligenceEnabled: boolean;
  availability?: PuterSourceAvailability;
  disabled: boolean;
  joined?: boolean;
  joinsNext?: boolean;
  onToggleEnabled: (checked: boolean) => void;
  onTogglePersonalIntelligence: (checked: boolean) => void;
}) {
  const unavailable = props.availability?.available === false;
  const toggleDisabled = props.disabled || (!props.enabled && unavailable);
  const personalIntelligenceDisabled = props.disabled || !props.enabled || (!props.personalIntelligenceEnabled && unavailable);

  return (
    <div
      className={cn(
        "connector-row profile-option-row connector-setting-row connector-setting-row-stacked",
        props.joined && "profile-option-row-joined",
        props.joinsNext && "profile-option-row-joins-next",
      )}
    >
      <button
        className="connector-setting-button"
        type="button"
        role="switch"
        aria-checked={props.enabled}
        disabled={toggleDisabled}
        onClick={() => props.onToggleEnabled(!props.enabled)}
      >
        <span className="connector-row-top">
          <span className="connector-row-head">
            <HugeiconsIcon className="profile-option-icon" icon={props.icon} size={23} strokeWidth={1.9} aria-hidden="true" />
            <span className="connector-setting-copy">
              <strong className="profile-option-label">{props.label}</strong>
              <small>{props.description}</small>
            </span>
          </span>
          <span className="profile-toggle" aria-hidden="true" data-state={props.enabled ? "on" : "off"}>
            <span className="profile-toggle-thumb" />
          </span>
        </span>
      </button>
      <button
        className="connector-setting-subtoggle"
        type="button"
        role="switch"
        aria-checked={props.personalIntelligenceEnabled}
        disabled={personalIntelligenceDisabled}
        onClick={() => props.onTogglePersonalIntelligence(!props.personalIntelligenceEnabled)}
      >
        <span>Use for Personal Intelligence</span>
        <span className="profile-toggle" aria-hidden="true" data-state={props.personalIntelligenceEnabled ? "on" : "off"}>
          <span className="profile-toggle-thumb" />
        </span>
      </button>
    </div>
  );
}

function ConnectorSettingToggleRow(props: {
  icon: IconSvgElement;
  label: string;
  checked: boolean;
  disabled: boolean;
  joined?: boolean;
  joinsNext?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      className={cn(
        "connector-row profile-option-row connector-setting-row",
        props.joined && "profile-option-row-joined",
        props.joinsNext && "profile-option-row-joins-next",
      )}
      type="button"
      role="switch"
      aria-checked={props.checked}
      disabled={props.disabled}
      onClick={() => props.onChange(!props.checked)}
    >
      <span className="connector-row-top">
        <span className="connector-row-head">
          <HugeiconsIcon className="profile-option-icon" icon={props.icon} size={23} strokeWidth={1.9} aria-hidden="true" />
          <strong className="profile-option-label">{props.label}</strong>
        </span>
        <span className="profile-toggle" aria-hidden="true" data-state={props.checked ? "on" : "off"}>
          <span className="profile-toggle-thumb" />
        </span>
      </span>
    </button>
  );
}


function ConnectorListSkeleton() {
  return (
    <div className="skeleton-list" aria-hidden="true">
      {Array.from({ length: 5 }, (_, index) => (
        <div key={index} className="connector-row connector-skeleton-row">
          <ContentLoader
            className="skeleton-loader"
            speed={1.8}
            viewBox="0 0 420 74"
            preserveAspectRatio="none"
            title=""
            uniqueKey={`connector-list-skeleton-${index}`}
            {...skeletonColors}
          >
            <rect x="0" y="0" rx="18" ry="18" width="420" height="74" />
            <rect x="18" y="18" rx="14" ry="14" width="38" height="38" />
            <rect x="68" y="27" rx="6" ry="6" width={index % 2 === 0 ? 138 : 104} height="16" />
            <rect x="366" y="26" rx="9" ry="9" width="18" height="18" />
          </ContentLoader>
        </div>
      ))}
    </div>
  );
}
