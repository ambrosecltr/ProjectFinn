import { describe, expect, it } from "bun:test";
import type { UserContext } from "@finn/core";
import { PuterBridge, type PuterBridgeSocket } from "./puter-bridge.js";

const user: UserContext = {
  tenantId: "tenant_test",
  userId: "usr_test",
  phoneNumber: "+15551234567",
  timezone: "UTC",
  timezoneSource: "server",
  kidsMode: false,
};

const otherUser: UserContext = {
  ...user,
  userId: "usr_other",
  phoneNumber: "+15557654321",
};

class FakeSocket implements PuterBridgeSocket {
  readonly sent: string[] = [];
  closed: { code?: number; reason?: string } | null = null;

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
  }

  sentCommands() {
    return this.sent
      .map((message) => JSON.parse(message) as { type: string; command?: { id: string; toolset: string; command: string; args: unknown } })
      .filter((message) => message.type === "command")
      .map((message) => message.command!);
  }
}

const grantedAccess = {
  imessage: { granted: true, message: "iMessage access is ready." },
  contacts: { granted: true, message: "Contacts access is ready." },
  notes: { granted: true, message: "Notes access is ready." },
};

function reportGrantedAccess(bridge: PuterBridge, deviceId = "mac"): void {
  bridge.handleSocketMessage(user, deviceId, JSON.stringify({
    type: "access_status",
    access: grantedAccess,
  }));
}

describe("PuterBridge", () => {
  it("requires an active socket device before executing commands", async () => {
    const bridge = new PuterBridge();

    await expect(bridge.executeCommand(user, {
      deviceId: "mac",
      toolset: "puter.notes",
      command: "list_notes",
      args: {},
      windowStart: new Date("2026-05-01T00:00:00.000Z"),
      windowEnd: new Date("2026-05-17T00:00:00.000Z"),
    })).rejects.toThrow("not actively connected");
  });

  it("delivers one command to the paired Mac socket and resolves with its result", async () => {
    const bridge = new PuterBridge();
    const socket = new FakeSocket();
    const token = bridge.createSocketToken(user, "mac");
    expect(bridge.connectSocket(token.token, socket)).toEqual({ user, deviceId: "mac" });
    reportGrantedAccess(bridge);
    const leaseId = bridge.createLease(user, {
      deviceId: "mac",
      runId: "run_1",
      enabledTools: ["puter.imessage"],
    });

    const result = bridge.executeCommand(user, {
      deviceId: "mac",
      leaseId,
      toolset: "puter.imessage",
      command: "search_messages",
      args: { query: "project" },
      windowStart: new Date("2026-05-01T00:00:00.000Z"),
      windowEnd: new Date("2026-05-17T00:00:00.000Z"),
      excludedHandles: ["+15550001111"],
    });
    const [command] = socket.sentCommands();

    expect(command).toEqual(expect.objectContaining({
      toolset: "puter.imessage",
      command: "search_messages",
      args: { query: "project" },
      excludedHandles: ["+15550001111"],
    }));
    expect(command?.id).toMatch(/^pcmd_/);

    bridge.handleSocketMessage(user, "mac", JSON.stringify({
      type: "result",
      commandId: command!.id,
      ok: true,
      result: { messages: [{ sourceId: "msg_1" }] },
    }));

    await expect(result).resolves.toEqual({ messages: [{ sourceId: "msg_1" }] });
  });

  it("requires a run lease before executing commands on an active socket", async () => {
    const bridge = new PuterBridge();
    const socket = new FakeSocket();
    bridge.connectSocket(bridge.createSocketToken(user, "mac").token, socket);

    await expect(bridge.executeCommand(user, {
      deviceId: "mac",
      toolset: "puter.imessage",
      command: "search_messages",
      args: { query: "project" },
      windowStart: new Date("2026-05-01T00:00:00.000Z"),
      windowEnd: new Date("2026-05-17T00:00:00.000Z"),
    })).rejects.toThrow("requires a run lease");
  });

  it("rejects leased commands when the Mac reports missing source access", async () => {
    const bridge = new PuterBridge();
    const socket = new FakeSocket();
    bridge.connectSocket(bridge.createSocketToken(user, "mac").token, socket);
    bridge.handleSocketMessage(user, "mac", JSON.stringify({
      type: "access_status",
      access: {
        ...grantedAccess,
        notes: { granted: false, message: "Grant Full Disk Access for Notes." },
      },
    }));
    const leaseId = bridge.createLease(user, {
      deviceId: "mac",
      runId: "run_1",
      enabledTools: ["puter.notes"],
    });

    await expect(bridge.executeCommand(user, {
      deviceId: "mac",
      leaseId,
      toolset: "puter.notes",
      command: "search_notes",
      args: { query: "project" },
      windowStart: new Date("2026-05-01T00:00:00.000Z"),
      windowEnd: new Date("2026-05-17T00:00:00.000Z"),
    })).rejects.toThrow("Full Disk Access is required in Finn Puter.");
  });

  it("caps outstanding socket tokens per device", () => {
    const bridge = new PuterBridge();
    const first = bridge.createSocketToken(user, "mac");
    bridge.createSocketToken(user, "mac");
    bridge.createSocketToken(user, "mac");
    const latest = bridge.createSocketToken(user, "mac");

    expect(bridge.connectSocket(first.token, new FakeSocket())).toBeNull();
    expect(bridge.connectSocket(latest.token, new FakeSocket())).toEqual({ user, deviceId: "mac" });
  });

  it("pushes config updates to an active paired Mac socket", () => {
    const bridge = new PuterBridge();
    const socket = new FakeSocket();
    bridge.connectSocket(bridge.createSocketToken(user, "mac").token, socket);

    expect(bridge.sendConfigUpdate(user, "mac", { puter: { notesEnabled: true } })).toBe(true);
    expect(JSON.parse(socket.sent.at(-1)!)).toEqual({
      type: "config_update",
      config: { puter: { notesEnabled: true } },
    });
  });

  it("rejects commands already sent to an old socket when the Mac reconnects", async () => {
    const bridge = new PuterBridge();
    const firstSocket = new FakeSocket();
    bridge.connectSocket(bridge.createSocketToken(user, "mac").token, firstSocket);
    reportGrantedAccess(bridge);
    const leaseId = bridge.createLease(user, {
      deviceId: "mac",
      runId: "run_1",
      enabledTools: ["puter.imessage"],
    });

    const sentToOldSocket = bridge.executeCommand(user, {
      deviceId: "mac",
      leaseId,
      toolset: "puter.imessage",
      command: "search_messages",
      args: { query: "shopping list" },
      windowStart: new Date("2026-05-01T00:00:00.000Z"),
      windowEnd: new Date("2026-05-17T00:00:00.000Z"),
    });
    const queuedForNewSocket = bridge.executeCommand(user, {
      deviceId: "mac",
      leaseId,
      toolset: "puter.imessage",
      command: "read_thread",
      args: { threadId: "chat_1" },
      windowStart: new Date("2026-05-01T00:00:00.000Z"),
      windowEnd: new Date("2026-05-17T00:00:00.000Z"),
    });
    expect(firstSocket.sentCommands()).toHaveLength(1);

    const secondSocket = new FakeSocket();
    bridge.connectSocket(bridge.createSocketToken(user, "mac").token, secondSocket);
    reportGrantedAccess(bridge);

    expect(firstSocket.closed).toEqual({ code: 4000, reason: "Finn Puter reconnected." });
    await expect(sentToOldSocket).rejects.toThrow("reconnected");
    expect(secondSocket.sentCommands()).toHaveLength(1);
    const [command] = secondSocket.sentCommands();

    bridge.handleSocketMessage(user, "mac", JSON.stringify({
      type: "result",
      commandId: command!.id,
      ok: true,
      result: { messages: [{ sourceId: "msg_2" }] },
    }));

    await expect(queuedForNewSocket).resolves.toEqual({ messages: [{ sourceId: "msg_2" }] });
  });

  it("notifies subscribers when a Mac socket connects", () => {
    const bridge = new PuterBridge();
    const socket = new FakeSocket();
    const connections: Array<{ userId: string; deviceId: string }> = [];
    const unsubscribe = bridge.onConnect((connection) => {
      connections.push({
        userId: connection.user.userId,
        deviceId: connection.deviceId,
      });
    });

    bridge.connectSocket(bridge.createSocketToken(user, "mac").token, socket);
    unsubscribe();
    bridge.connectSocket(bridge.createSocketToken(user, "mac").token, new FakeSocket());

    expect(connections).toEqual([{ userId: "usr_test", deviceId: "mac" }]);
  });

  it("notifies subscribers when a Mac reports local access status", () => {
    const bridge = new PuterBridge();
    const socket = new FakeSocket();
    const reports: Array<{ userId: string; deviceId: string; notesGranted: boolean }> = [];
    const unsubscribe = bridge.onAccessStatus((status) => {
      reports.push({
        userId: status.user.userId,
        deviceId: status.deviceId,
        notesGranted: status.access.notes?.granted ?? false,
      });
    });

    bridge.connectSocket(bridge.createSocketToken(user, "mac").token, socket);
    reportGrantedAccess(bridge);
    unsubscribe();
    bridge.handleSocketMessage(user, "mac", JSON.stringify({
      type: "access_status",
      access: {
        ...grantedAccess,
        notes: { granted: false, message: "Notes access is missing." },
      },
    }));

    expect(reports).toEqual([{ userId: "usr_test", deviceId: "mac", notesGranted: true }]);
  });

  it("keeps commands isolated by user and device", async () => {
    const bridge = new PuterBridge();
    const socket = new FakeSocket();
    const token = bridge.createSocketToken(user, "mac");
    bridge.connectSocket(token.token, socket);

    await expect(bridge.executeCommand(otherUser, {
      deviceId: "mac",
      toolset: "puter.imessage",
      command: "search_messages",
      args: { query: "project" },
      windowStart: new Date("2026-05-01T00:00:00.000Z"),
      windowEnd: new Date("2026-05-17T00:00:00.000Z"),
    })).rejects.toThrow("not actively connected");
  });

  it("multiplexes concurrent run commands over one socket with per-device queueing", async () => {
    const bridge = new PuterBridge();
    const socket = new FakeSocket();
    bridge.connectSocket(bridge.createSocketToken(user, "mac").token, socket);
    reportGrantedAccess(bridge);
    const firstLease = bridge.createLease(user, {
      deviceId: "mac",
      runId: "run_1",
      enabledTools: ["puter.imessage"],
    });
    const secondLease = bridge.createLease(user, {
      deviceId: "mac",
      runId: "run_2",
      enabledTools: ["puter.notes"],
    });

    const first = bridge.executeCommand(user, {
      deviceId: "mac",
      leaseId: firstLease,
      toolset: "puter.imessage",
      command: "search_messages",
      args: { query: "project" },
      windowStart: new Date("2026-05-01T00:00:00.000Z"),
      windowEnd: new Date("2026-05-17T00:00:00.000Z"),
    });
    const second = bridge.executeCommand(user, {
      deviceId: "mac",
      leaseId: secondLease,
      toolset: "puter.notes",
      command: "search_notes",
      args: { query: "brief" },
      windowStart: new Date("2026-05-01T00:00:00.000Z"),
      windowEnd: new Date("2026-05-17T00:00:00.000Z"),
    });

    expect(socket.sentCommands()).toHaveLength(1);
    const [firstCommand] = socket.sentCommands();
    bridge.handleSocketMessage(user, "mac", JSON.stringify({
      type: "result",
      commandId: firstCommand!.id,
      ok: true,
      result: { messages: [{ sourceId: "msg_1" }] },
    }));

    await expect(first).resolves.toEqual({ messages: [{ sourceId: "msg_1" }] });
    expect(socket.sentCommands()).toHaveLength(2);
    const secondCommand = socket.sentCommands()[1];
    bridge.handleSocketMessage(user, "mac", JSON.stringify({
      type: "result",
      commandId: secondCommand!.id,
      ok: true,
      result: { notes: [{ sourceId: "note_1" }] },
    }));

    await expect(second).resolves.toEqual({ notes: [{ sourceId: "note_1" }] });
  });

  it("caps queued commands per device", async () => {
    const bridge = new PuterBridge();
    const socket = new FakeSocket();
    bridge.connectSocket(bridge.createSocketToken(user, "mac").token, socket);
    reportGrantedAccess(bridge);
    const leaseId = bridge.createLease(user, {
      deviceId: "mac",
      runId: "run_1",
      enabledTools: ["puter.notes"],
    });
    const commands: Array<Promise<unknown>> = [];

    for (let index = 0; index < 25; index += 1) {
      commands.push(bridge.executeCommand(user, {
        deviceId: "mac",
        leaseId,
        toolset: "puter.notes",
        command: "search_notes",
        args: { query: `brief ${index}` },
        windowStart: new Date("2026-05-01T00:00:00.000Z"),
        windowEnd: new Date("2026-05-17T00:00:00.000Z"),
      }).catch((error) => error));
    }

    await expect(bridge.executeCommand(user, {
      deviceId: "mac",
      leaseId,
      toolset: "puter.notes",
      command: "search_notes",
      args: { query: "overflow" },
      windowStart: new Date("2026-05-01T00:00:00.000Z"),
      windowEnd: new Date("2026-05-17T00:00:00.000Z"),
    })).rejects.toThrow("too many queued commands");

    bridge.releaseLease(user, "mac", leaseId);
    await Promise.all(commands);
  });

  it("rejects commands outside a run lease's enabled toolsets", async () => {
    const bridge = new PuterBridge();
    const socket = new FakeSocket();
    bridge.connectSocket(bridge.createSocketToken(user, "mac").token, socket);
    const leaseId = bridge.createLease(user, {
      deviceId: "mac",
      runId: "run_1",
      enabledTools: ["puter.notes"],
    });

    await expect(bridge.executeCommand(user, {
      deviceId: "mac",
      leaseId,
      toolset: "puter.imessage",
      command: "search_messages",
      args: { query: "project" },
      windowStart: new Date("2026-05-01T00:00:00.000Z"),
      windowEnd: new Date("2026-05-17T00:00:00.000Z"),
    })).rejects.toThrow("not enabled");
  });
});
