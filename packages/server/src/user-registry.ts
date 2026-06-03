import {
  createLogger,
  generateId,
  normalizePhoneNumber,
  resolveTimeZone,
  type AppConfig,
  type UserContext,
  type UserTimezoneSource,
} from "@finn/core";
import type { Database, StoredUser } from "@finn/db";
import * as schema from "@finn/db";
import type { SpectrumClient, SpectrumCloudUser } from "@finn/messaging";
import { and, desc, eq } from "drizzle-orm";

const logger = createLogger("user-registry");

const defaultTenantId = "tenant_default";
const defaultTenantName = "Default Finn";

type SpectrumChannelMetadata = {
  spectrumUserId?: string;
  assignedPhoneNumber?: string;
  type?: "shared" | "dedicated";
};

function createBlankIdentity(phoneNumber: string): string {
  return [
    "# USER",
    "",
    `phone: ${phoneNumber}`,
    "",
    "## Profile",
    "",
    "- no durable user profile has been set yet. learn naturally from conversation and memory.",
  ].join("\n");
}

function toUserContext(user: StoredUser, defaultTimezone: string): UserContext {
  const profile = user.metadata?.profile;
  const rawTimezoneSource = typeof profile === "object" && profile !== null && "timezoneSource" in profile
    ? profile.timezoneSource
    : null;
  const timezoneSource: UserTimezoneSource = rawTimezoneSource === "manual" || rawTimezoneSource === "browser"
    ? rawTimezoneSource
    : "server";

  return {
    tenantId: user.tenantId,
    userId: user.id,
    phoneNumber: user.phoneNumber,
    displayName: user.displayName,
    timezone: resolveTimeZone(timezoneSource === "server" ? defaultTimezone : user.timezone, defaultTimezone),
    timezoneSource,
    location: user.location,
    kidsMode: user.kidsMode,
  };
}

export interface GetOrCreateUserResult {
  user: UserContext;
  created: boolean;
}

export class UserRegistry {
  private readonly defaultTimezone: string;

  constructor(
    private readonly deps: {
      db: Database;
      config: AppConfig;
      spectrumClient?: Pick<SpectrumClient, "provisionUser" | "rememberRecipientLine">;
    },
  ) {
    this.defaultTimezone = deps.config.userTimezone;
  }

  async ensureBootstrapUser(): Promise<UserContext | null> {
    await this.ensureDefaultTenant();

    const bootstrapPhone = this.deps.config.userPhoneNumber;
    if (!bootstrapPhone) {
      return null;
    }

    const result = await this.getOrCreateByPhone(bootstrapPhone);

    return result.user;
  }

  async ensureAllowedUsers(): Promise<UserContext[]> {
    const allowedNumbers = this.deps.config.spectrum.allowedNumbers ?? [];
    const users: UserContext[] = [];

    for (const phoneNumber of allowedNumbers) {
      const { user } = await this.getOrCreateByPhone(phoneNumber);
      users.push(user);
    }

    return users;
  }

  async getOrCreateByPhone(
    rawPhoneNumber: string,
  ): Promise<GetOrCreateUserResult> {
    const phoneNumber = normalizePhoneNumber(rawPhoneNumber);
    await this.ensureDefaultTenant();

    const existing = await this.findByPhone(phoneNumber);
    if (existing) {
      await this.ensureSpectrumChannel(existing.id, phoneNumber);
      return { user: toUserContext(existing, this.defaultTimezone), created: false };
    }

    const now = new Date();
    const id = generateId("usr");
    const identity = createBlankIdentity(phoneNumber);

    const [created] = await this.deps.db
      .insert(schema.users)
      .values({
        id,
        tenantId: defaultTenantId,
        phoneNumber,
        displayName: null,
        timezone: this.defaultTimezone,
        identity,
        metadata: { profile: { timezoneSource: "server" } },
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    await this.ensureSpectrumChannel(id, phoneNumber);

    logger.info({ userId: id, tenantId: defaultTenantId, phoneNumber }, "Created Finn user");

    return { user: toUserContext(created, this.defaultTimezone), created: true };
  }

  async requireUser(userId: string): Promise<UserContext> {
    const [user] = await this.deps.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);

    if (!user) {
      throw new Error(`User not found: ${userId}`);
    }

    return toUserContext(user, this.defaultTimezone);
  }

  async listExistingUsers(limit?: number): Promise<UserContext[]> {
    const query = this.deps.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.tenantId, defaultTenantId))
      .orderBy(desc(schema.users.updatedAt));

    const rows = limit ? await query.limit(limit) : await query;
    return rows.map((user) => toUserContext(user, this.defaultTimezone));
  }

  async getSpectrumAssignedPhoneNumber(userId: string): Promise<string | null> {
    const [channel] = await this.deps.db
      .select()
      .from(schema.userChannels)
      .where(and(
        eq(schema.userChannels.tenantId, defaultTenantId),
        eq(schema.userChannels.userId, userId),
        eq(schema.userChannels.provider, "spectrum"),
      ))
      .limit(1);

    return getSpectrumChannelMetadata(channel?.metadata).assignedPhoneNumber ?? null;
  }

  async updateSpectrumChannelPhone(userId: string, phoneNumber: string): Promise<void> {
    await this.ensureSpectrumChannel(userId, normalizePhoneNumber(phoneNumber));
  }

  private async ensureDefaultTenant(): Promise<void> {
    const now = new Date();
    await this.deps.db
      .insert(schema.tenants)
      .values({
        id: defaultTenantId,
        name: defaultTenantName,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing();
  }

  private async findByPhone(phoneNumber: string): Promise<StoredUser | null> {
    const [user] = await this.deps.db
      .select()
      .from(schema.users)
      .where(and(
        eq(schema.users.tenantId, defaultTenantId),
        eq(schema.users.phoneNumber, phoneNumber),
      ))
      .limit(1);

    return user ?? null;
  }

  private async ensureSpectrumChannel(userId: string, phoneNumber: string): Promise<void> {
    const existing = await this.findSpectrumChannel(userId);
    const cloudUser = await this.provisionSpectrumUser(phoneNumber, existing);
    const metadata = cloudUser ? toSpectrumChannelMetadata(cloudUser) : getSpectrumChannelMetadata(existing?.metadata);
    const now = new Date();

    this.deps.spectrumClient?.rememberRecipientLine(phoneNumber, metadata.assignedPhoneNumber);

    if (existing) {
      await this.deps.db
        .update(schema.userChannels)
        .set({
          externalAddress: phoneNumber,
          metadata,
          updatedAt: now,
        })
        .where(eq(schema.userChannels.id, existing.id));
      return;
    }

    await this.deps.db
      .insert(schema.userChannels)
      .values({
        id: generateId("uch"),
        tenantId: defaultTenantId,
        userId,
        provider: "spectrum",
        externalAddress: phoneNumber,
        metadata,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing();
  }

  private async findSpectrumChannel(userId: string): Promise<schema.UserChannel | null> {
    const [channel] = await this.deps.db
      .select()
      .from(schema.userChannels)
      .where(and(
        eq(schema.userChannels.tenantId, defaultTenantId),
        eq(schema.userChannels.userId, userId),
        eq(schema.userChannels.provider, "spectrum"),
      ))
      .limit(1);

    return channel ?? null;
  }

  private async provisionSpectrumUser(phoneNumber: string, channel: schema.UserChannel | null): Promise<SpectrumCloudUser | null> {
    if (!this.deps.spectrumClient) {
      return null;
    }

    const metadata = getSpectrumChannelMetadata(channel?.metadata);
    if (channel?.externalAddress !== phoneNumber) {
      return this.deps.spectrumClient.provisionUser(phoneNumber);
    }

    if (metadata.spectrumUserId && metadata.assignedPhoneNumber) {
      return null;
    }

    return this.deps.spectrumClient.provisionUser(phoneNumber);
  }

}

function getSpectrumChannelMetadata(metadata: Record<string, unknown> | null | undefined): SpectrumChannelMetadata {
  return {
    spectrumUserId: typeof metadata?.spectrumUserId === "string" ? metadata.spectrumUserId : undefined,
    assignedPhoneNumber: typeof metadata?.assignedPhoneNumber === "string" ? metadata.assignedPhoneNumber : undefined,
    type: metadata?.type === "shared" || metadata?.type === "dedicated" ? metadata.type : undefined,
  };
}

function toSpectrumChannelMetadata(user: SpectrumCloudUser): SpectrumChannelMetadata {
  return {
    spectrumUserId: user.id,
    assignedPhoneNumber: user.assignedPhoneNumber,
    type: user.type,
  };
}
