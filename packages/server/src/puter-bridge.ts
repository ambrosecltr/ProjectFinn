import { createLogger, generateId, type UserContext } from "@finn/core";
import type { ToolsetExecuteInput, ToolsetExecutionOptions } from "@finn/toolsets";
import { getUnavailablePuterToolsetMessage, type PuterLocalAccessStatus } from "./puter-connector.js";

const logger = createLogger("puter-bridge");
const commandTimeoutMs = 60_000;
const socketTokenTtlMs = 60_000;
const maxInFlightCommandsPerDevice = 1;
const maxQueuedCommandsPerDevice = 25;
const maxSocketTokensPerDevice = 3;
const maxSocketTokensTotal = 500;

function isAbortReason(reason: unknown): reason is Error {
  return reason instanceof Error && reason.name === "AbortError";
}

function getAbortReasonMessage(reason: unknown, fallback: string): string {
  if (reason instanceof Error) {
    return reason.message || fallback;
  }
  if (typeof reason === "string" && reason.length > 0) {
    return reason;
  }
  return fallback;
}

function createAbortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (isAbortReason(reason)) {
    return reason;
  }

  const error = new Error(getAbortReasonMessage(reason, "Finn Puter command cancelled."));
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw createAbortError(signal);
  }
}

export interface PuterBridgeSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

type PuterBridgeMessage =
  | {
      type: "result";
      commandId: string;
      ok: boolean;
      result?: unknown;
      error?: string;
    }
  | {
      type: "access_status";
      access: PuterLocalAccessStatus;
    }
  | {
      type: "ping";
    }
  | {
      type: "config_request";
    };

interface PendingCommand {
  id: string;
  leaseId?: string;
  toolset: string;
  command: string;
  args: unknown;
  windowStart: string;
  windowEnd: string;
  excludedHandles: string[];
}

interface PendingExecution extends PendingCommand {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface PuterLease {
  id: string;
  runId: string;
  enabledTools: Set<string>;
  createdAt: number;
}

interface DeviceState {
  lastSeenAt: number;
  socket: PuterBridgeSocket | null;
  access: PuterLocalAccessStatus | null;
  pending: PendingExecution[];
  inFlight: Map<string, PendingExecution>;
  leases: Map<string, PuterLease>;
}

interface SocketToken {
  user: UserContext;
  deviceId: string;
  expiresAt: number;
}

export interface PuterBridgeCommand extends PendingCommand {}

export interface PuterBridgeStatus {
  active: boolean;
  lastSeenAt: string | null;
  access: PuterLocalAccessStatus | null;
}

export interface PuterBridgeSocketToken {
  token: string;
  expiresAt: string;
}

export interface PuterBridgeConnection {
  user: UserContext;
  deviceId: string;
}

export interface PuterBridgeAccessStatus {
  user: UserContext;
  deviceId: string;
  access: PuterLocalAccessStatus;
}

type PuterBridgeConnectHandler = (connection: PuterBridgeConnection) => void | Promise<void>;
type PuterBridgeAccessStatusHandler = (status: PuterBridgeAccessStatus) => void | Promise<void>;

export class PuterBridge {
  private readonly devices = new Map<string, DeviceState>();
  private readonly socketTokens = new Map<string, SocketToken>();
  private readonly connectHandlers = new Set<PuterBridgeConnectHandler>();
  private readonly accessStatusHandlers = new Set<PuterBridgeAccessStatusHandler>();

  onConnect(handler: PuterBridgeConnectHandler): () => void {
    this.connectHandlers.add(handler);
    return () => {
      this.connectHandlers.delete(handler);
    };
  }

  onAccessStatus(handler: PuterBridgeAccessStatusHandler): () => void {
    this.accessStatusHandlers.add(handler);
    return () => {
      this.accessStatusHandlers.delete(handler);
    };
  }

  createSocketToken(user: UserContext, deviceId: string): PuterBridgeSocketToken {
    this.pruneExpiredSocketTokens();
    this.pruneSocketTokensForDevice(user, deviceId, maxSocketTokensPerDevice - 1);
    this.pruneOldestSocketTokens(maxSocketTokensTotal - 1);
    const token = generateId("ptok");
    const expiresAt = Date.now() + socketTokenTtlMs;
    this.socketTokens.set(token, {
      user,
      deviceId,
      expiresAt,
    });
    return {
      token,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  getStatus(user: UserContext, deviceId: string): PuterBridgeStatus {
    const state = this.devices.get(deviceKey(user, deviceId));
    if (!state?.socket) {
      return {
        active: false,
        lastSeenAt: state ? new Date(state.lastSeenAt).toISOString() : null,
        access: state?.access ?? null,
      };
    }
    return {
      active: true,
      lastSeenAt: new Date(state.lastSeenAt).toISOString(),
      access: state.access,
    };
  }

  hasLiveDevice(user: UserContext, deviceId: string): boolean {
    return this.getStatus(user, deviceId).active;
  }

  sendConfigUpdate(user: UserContext, deviceId: string, config: unknown): boolean {
    const state = this.devices.get(deviceKey(user, deviceId));
    if (!state?.socket) {
      return false;
    }
    state.lastSeenAt = Date.now();
    try {
      state.socket.send(JSON.stringify({
        type: "config_update",
        config,
      }));
    } catch (error) {
      state.socket = null;
      this.rejectAllCommands(state, new Error("Finn Puter socket could not receive a config update."));
      logger.warn({ error, deviceId, tenantId: user.tenantId, userId: user.userId }, "Failed to send Finn Puter config update");
      return false;
    }
    return true;
  }

  connectSocket(token: string, socket: PuterBridgeSocket): { user: UserContext; deviceId: string } | null {
    this.pruneExpiredSocketTokens();
    const socketToken = this.socketTokens.get(token);
    if (!socketToken || socketToken.expiresAt <= Date.now()) {
      this.socketTokens.delete(token);
      return null;
    }
    this.socketTokens.delete(token);

    const state = this.getOrCreateDevice(socketToken.user, socketToken.deviceId);
    if (state.socket) {
      this.rejectInFlightCommands(state, new Error("Finn Puter reconnected before the command completed."));
      state.socket.close(4000, "Finn Puter reconnected.");
    }
    state.socket = socket;
    state.lastSeenAt = Date.now();
    this.flushQueue(state);
    logger.info({ deviceId: socketToken.deviceId, tenantId: socketToken.user.tenantId, userId: socketToken.user.userId }, "Finn Puter socket connected");
    const connection = { user: socketToken.user, deviceId: socketToken.deviceId };
    this.notifyConnectHandlers(connection);
    return connection;
  }

  disconnectSocket(user: UserContext, deviceId: string, socket: PuterBridgeSocket): void {
    const state = this.devices.get(deviceKey(user, deviceId));
    if (!state || state.socket !== socket) {
      return;
    }

    state.socket = null;
    state.lastSeenAt = Date.now();
    this.rejectAllCommands(state, new Error("Finn Puter disconnected before the command completed."));
    logger.info({ deviceId, tenantId: user.tenantId, userId: user.userId }, "Finn Puter socket disconnected");
  }

  handleSocketMessage(user: UserContext, deviceId: string, rawMessage: string): void {
    const state = this.devices.get(deviceKey(user, deviceId));
    if (!state) {
      return;
    }

    state.lastSeenAt = Date.now();
    const message = parseSocketMessage(rawMessage);
    if (!message) {
      logger.warn({ deviceId }, "Ignoring malformed Puter socket message");
      return;
    }

    if (message.type === "ping") {
      state.socket?.send(JSON.stringify({ type: "pong" }));
      return;
    }
    if (message.type === "config_request") {
      return;
    }
    if (message.type === "access_status") {
      state.access = {
        ...message.access,
        updatedAt: message.access.updatedAt ?? new Date(state.lastSeenAt).toISOString(),
      };
      this.notifyAccessStatusHandlers({
        user,
        deviceId,
        access: state.access,
      });
      return;
    }

    this.completeCommand(user, {
      deviceId,
      commandId: message.commandId,
      ok: message.ok,
      result: message.result,
      error: message.error,
    });
  }

  createLease(user: UserContext, input: {
    deviceId: string;
    runId: string;
    enabledTools: Iterable<string>;
  }): string {
    const status = this.getStatus(user, input.deviceId);
    if (!status.active) {
      throw new Error("Finn Puter is not actively connected. Open Finn Puter on the Mac and try again.");
    }

    const state = this.getOrCreateDevice(user, input.deviceId);
    const id = generateId("plse");
    state.leases.set(id, {
      id,
      runId: input.runId,
      enabledTools: new Set(input.enabledTools),
      createdAt: Date.now(),
    });
    return id;
  }

  releaseLease(user: UserContext, deviceId: string, leaseId: string): void {
    const state = this.devices.get(deviceKey(user, deviceId));
    if (!state) {
      return;
    }

    state.leases.delete(leaseId);
    for (const pending of [...state.pending, ...state.inFlight.values()]) {
      if (pending.leaseId === leaseId) {
        this.rejectCommand(state, pending, new Error("Finn Puter command was cancelled because the requesting run ended."));
      }
    }
  }

  async executeCommand(user: UserContext, input: {
    deviceId: string;
    leaseId?: string;
    windowStart: Date;
    windowEnd: Date;
    excludedHandles?: string[];
  } & ToolsetExecuteInput, options: ToolsetExecutionOptions = {}): Promise<unknown> {
    const abortSignal = options.abortSignal;
    throwIfAborted(abortSignal);
    const state = this.devices.get(deviceKey(user, input.deviceId));
    if (!state?.socket) {
      throw new Error("Finn Puter is not actively connected. Open Finn Puter on the Mac and try again.");
    }
    if (!input.leaseId) {
      throw new Error("Finn Puter access requires a run lease.");
    }
    const lease = state.leases.get(input.leaseId);
    if (!lease) {
      throw new Error("Finn Puter access is not leased to this run.");
    }
    if (!lease.enabledTools.has(input.toolset)) {
      throw new Error(`Finn Puter toolset is not enabled for this run: ${input.toolset}`);
    }
    const unavailableMessage = getUnavailablePuterToolsetMessage(input.toolset, state.access ?? undefined);
    if (unavailableMessage) {
      throw new Error(unavailableMessage);
    }
    if (state.pending.length + state.inFlight.size >= maxQueuedCommandsPerDevice) {
      throw new Error("Finn Puter has too many queued commands for this device.");
    }

    const id = generateId("pcmd");
    const result = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = state.pending.find((candidate) => candidate.id === id);
        if (pending) {
          removeArrayItem(state.pending, pending);
          pending.reject(new Error(`Finn Puter command timed out: ${input.toolset}/${input.command}`));
          this.flushQueue(state);
          return;
        }
        const inFlight = state.inFlight.get(id);
        if (inFlight) {
          state.inFlight.delete(id);
          inFlight.reject(new Error(`Finn Puter command timed out: ${input.toolset}/${input.command}`));
          this.flushQueue(state);
        }
      }, commandTimeoutMs);

      const execution: PendingExecution = {
        id,
        leaseId: input.leaseId,
        toolset: input.toolset,
        command: input.command,
        args: input.args,
        windowStart: input.windowStart.toISOString(),
        windowEnd: input.windowEnd.toISOString(),
        excludedHandles: input.excludedHandles ?? [],
        timeout,
        resolve,
        reject,
      };
      const bridge = this;
      const activeState = state;
      function abort(): void {
        if (abortSignal) {
          bridge.rejectCommand(activeState, execution, createAbortError(abortSignal));
        }
      }
      if (abortSignal?.aborted) {
        clearTimeout(timeout);
        reject(createAbortError(abortSignal));
        return;
      }
      abortSignal?.addEventListener("abort", abort, { once: true });
      function cleanupAbort(): void {
        abortSignal?.removeEventListener("abort", abort);
      }
      execution.resolve = (value) => {
        cleanupAbort();
        resolve(value);
      };
      execution.reject = (error) => {
        cleanupAbort();
        reject(error);
      };
      state.pending.push(execution);
    });
    this.flushQueue(state);
    return result;
  }

  completeCommand(user: UserContext, input: {
    deviceId: string;
    commandId: string;
    ok: boolean;
    result?: unknown;
    error?: string;
  }): boolean {
    const state = this.devices.get(deviceKey(user, input.deviceId));
    if (!state) {
      return false;
    }

    state.lastSeenAt = Date.now();
    const pending = state.inFlight.get(input.commandId);
    if (!pending) {
      logger.warn({ commandId: input.commandId, deviceId: input.deviceId }, "Puter command result did not match a pending command");
      return false;
    }

    state.inFlight.delete(input.commandId);
    clearTimeout(pending.timeout);
    if (input.ok) {
      pending.resolve(input.result ?? null);
    } else {
      pending.reject(new Error(input.error || "Finn Puter command failed."));
    }
    this.flushQueue(state);
    return true;
  }

  private getOrCreateDevice(user: UserContext, deviceId: string): DeviceState {
    const key = deviceKey(user, deviceId);
    const existing = this.devices.get(key);
    if (existing) {
      return existing;
    }

    const state: DeviceState = {
      lastSeenAt: Date.now(),
      socket: null,
      access: null,
      pending: [],
      inFlight: new Map(),
      leases: new Map(),
    };
    this.devices.set(key, state);
    return state;
  }

  private notifyConnectHandlers(connection: PuterBridgeConnection): void {
    for (const handler of this.connectHandlers) {
      try {
        void Promise.resolve(handler(connection)).catch((error: unknown) => {
          logger.warn({ error, deviceId: connection.deviceId, tenantId: connection.user.tenantId, userId: connection.user.userId }, "Finn Puter connect handler failed");
        });
      } catch (error) {
        logger.warn({ error, deviceId: connection.deviceId, tenantId: connection.user.tenantId, userId: connection.user.userId }, "Finn Puter connect handler failed");
      }
    }
  }

  private notifyAccessStatusHandlers(status: PuterBridgeAccessStatus): void {
    for (const handler of this.accessStatusHandlers) {
      try {
        void Promise.resolve(handler(status)).catch((error: unknown) => {
          logger.warn({ error, deviceId: status.deviceId, tenantId: status.user.tenantId, userId: status.user.userId }, "Finn Puter access-status handler failed");
        });
      } catch (error) {
        logger.warn({ error, deviceId: status.deviceId, tenantId: status.user.tenantId, userId: status.user.userId }, "Finn Puter access-status handler failed");
      }
    }
  }

  private flushQueue(state: DeviceState): void {
    while (state.socket && state.pending.length > 0 && state.inFlight.size < maxInFlightCommandsPerDevice) {
      const pending = state.pending.shift();
      if (pending) {
        state.inFlight.set(pending.id, pending);
        try {
          state.socket.send(JSON.stringify({
            type: "command",
            command: toSocketCommand(pending),
          }));
        } catch (error) {
          state.inFlight.delete(pending.id);
          this.rejectCommand(state, pending, new Error(`Finn Puter socket send failed: ${getErrorMessage(error)}`));
        }
      }
    }
  }

  private rejectAllCommands(state: DeviceState, error: Error): void {
    for (const pending of [...state.pending, ...state.inFlight.values()]) {
      this.rejectCommand(state, pending, error);
    }
  }

  private rejectInFlightCommands(state: DeviceState, error: Error): void {
    for (const command of [...state.inFlight.values()]) {
      this.rejectCommand(state, command, error);
    }
  }

  private rejectCommand(state: DeviceState, command: PendingExecution, error: Error): void {
    removeArrayItem(state.pending, command);
    state.inFlight.delete(command.id);
    clearTimeout(command.timeout);
    command.reject(error);
  }

  private pruneExpiredSocketTokens(): void {
    const now = Date.now();
    for (const [token, socketToken] of this.socketTokens) {
      if (socketToken.expiresAt <= now) {
        this.socketTokens.delete(token);
      }
    }
  }

  private pruneSocketTokensForDevice(user: UserContext, deviceId: string, keepCount: number): void {
    const key = deviceKey(user, deviceId);
    const tokens = [...this.socketTokens.entries()]
      .filter(([, socketToken]) => deviceKey(socketToken.user, socketToken.deviceId) === key);
    while (tokens.length > keepCount) {
      const oldestToken = tokens.shift();
      if (!oldestToken) {
        return;
      }
      const [token] = oldestToken;
      this.socketTokens.delete(token);
    }
  }

  private pruneOldestSocketTokens(keepCount: number): void {
    while (this.socketTokens.size > keepCount) {
      const oldestToken = this.socketTokens.keys().next().value;
      if (!oldestToken) {
        return;
      }
      this.socketTokens.delete(oldestToken);
    }
  }
}

function toSocketCommand(command: PendingCommand): PuterBridgeCommand {
  return {
    id: command.id,
    toolset: command.toolset,
    command: command.command,
    args: command.args,
    windowStart: command.windowStart,
    windowEnd: command.windowEnd,
    excludedHandles: command.excludedHandles,
  };
}

function deviceKey(user: UserContext, deviceId: string): string {
  return `${user.tenantId}:${user.userId}:${deviceId}`;
}

function removeArrayItem<T>(items: T[], item: T): void {
  const index = items.indexOf(item);
  if (index >= 0) {
    items.splice(index, 1);
  }
}

function parseSocketMessage(rawMessage: string): PuterBridgeMessage | null {
  try {
    const parsed = JSON.parse(rawMessage) as Partial<PuterBridgeMessage>;
    if (parsed.type === "ping") {
      return { type: "ping" };
    }
    if (parsed.type === "config_request") {
      return { type: "config_request" };
    }
    if (parsed.type === "access_status" && isPuterLocalAccessStatus(parsed.access)) {
      return {
        type: "access_status",
        access: parsed.access,
      };
    }
    if (parsed.type === "result" && typeof parsed.commandId === "string" && typeof parsed.ok === "boolean") {
      return {
        type: "result",
        commandId: parsed.commandId,
        ok: parsed.ok,
        result: parsed.result,
        error: typeof parsed.error === "string" ? parsed.error : undefined,
      };
    }
  } catch {
    return null;
  }
  return null;
}

function isPuterLocalAccessStatus(value: unknown): value is PuterLocalAccessStatus {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return ["imessage", "contacts", "notes"].every((key) => {
    const permission = record[key];
    return permission === undefined || isPuterPermissionStatus(permission);
  });
}

function isPuterPermissionStatus(value: unknown): value is { granted: boolean; message: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return typeof record.granted === "boolean" && typeof record.message === "string";
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
