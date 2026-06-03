import { describe, expect, it, mock } from "bun:test";
import { getTableName, type Table } from "drizzle-orm";

import { UserRegistry } from "./user-registry.js";

type Row = Record<string, unknown>;

function createDb() {
  const tenants: Record<string, Row> = {};
  const users: Record<string, Row> = {};
  const channels: Record<string, Row> = {};

  const db = {
    insert(table: Table) {
      return {
        values(value: Row) {
          return {
            onConflictDoNothing: async () => {
              const name = getTableName(table);
              if (name === "tenants") tenants[value.id as string] ??= value;
              if (name === "user_channels") channels[value.id as string] ??= value;
            },
            returning: async () => {
              if (getTableName(table) === "users") users[value.id as string] = value;
              return [value];
            },
          };
        },
      };
    },
    select() {
      return {
        from(table: Table) {
          return createSelectQuery(getTableName(table), users, channels);
        },
      };
    },
    update(table: Table) {
      return {
        set(patch: Row) {
          return {
            where: async () => {
              if (getTableName(table) === "user_channels") {
                const channel = Object.values(channels)[0];
                if (channel) Object.assign(channel, patch);
              }
            },
          };
        },
      };
    },
  };

  return { db, users, channels };
}

function createSelectQuery(tableName: string, users: Record<string, Row>, channels: Record<string, Row>) {
  const rows = () => {
    if (tableName === "users") return Object.values(users);
    if (tableName === "user_channels") return Object.values(channels);
    return [];
  };

  return {
    where() {
      return this;
    },
    orderBy() {
      return this;
    },
    limit: async () => rows().slice(0, 1),
    then(resolve: (value: Row[]) => unknown) {
      return Promise.resolve(resolve(rows()));
    },
  };
}

describe("UserRegistry", () => {
  it("provisions configured allowed numbers as Finn and Spectrum users", async () => {
    const { db, users, channels } = createDb();
    const provisionUser = mock(async (phoneNumber: string) => ({
      id: `sp_${phoneNumber.slice(-4)}`,
      type: "shared" as const,
      phoneNumber,
      assignedPhoneNumber: "+15550001111",
    }));
    const rememberRecipientLine = mock(() => undefined);
    const registry = new UserRegistry({
      db: db as never,
      config: { userTimezone: "UTC", spectrum: { allowedNumbers: ["+1 (555) 123-4567"] } } as never,
      spectrumClient: { provisionUser, rememberRecipientLine },
    });

    const created = await registry.ensureAllowedUsers();

    expect(created).toHaveLength(1);
    expect(created[0]?.phoneNumber).toBe("+15551234567");
    expect(Object.values(users)).toHaveLength(1);
    expect(Object.values(channels)[0]).toMatchObject({
      provider: "spectrum",
      externalAddress: "+15551234567",
      metadata: {
        spectrumUserId: "sp_4567",
        assignedPhoneNumber: "+15550001111",
        type: "shared",
      },
    });
    expect(rememberRecipientLine).toHaveBeenCalledWith("+15551234567", "+15550001111");
  });

  it("re-provisions Spectrum when a user's phone number changes", async () => {
    const { db, channels } = createDb();
    const provisionUser = mock(async (phoneNumber: string) => ({
      id: "sp_new",
      type: "shared" as const,
      phoneNumber,
      assignedPhoneNumber: "+15550002222",
    }));
    const registry = new UserRegistry({
      db: db as never,
      config: { userTimezone: "UTC", spectrum: { allowedNumbers: [] } } as never,
      spectrumClient: { provisionUser, rememberRecipientLine: mock(() => undefined) },
    });

    channels.channel_1 = {
      id: "channel_1",
      tenantId: "tenant_default",
      userId: "usr_123",
      provider: "spectrum",
      externalAddress: "+15551234567",
      metadata: {
        spectrumUserId: "sp_old",
        assignedPhoneNumber: "+15550001111",
        type: "shared",
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await registry.updateSpectrumChannelPhone("usr_123", "+15557654321");

    expect(provisionUser).toHaveBeenCalledWith("+15557654321");
    expect(channels.channel_1).toMatchObject({
      externalAddress: "+15557654321",
      metadata: {
        spectrumUserId: "sp_new",
        assignedPhoneNumber: "+15550002222",
        type: "shared",
      },
    });
  });
});
