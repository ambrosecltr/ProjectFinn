import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

export function createDb(connectionString: string) {
  const client = postgres(connectionString);

  return drizzle(client, { schema });
}

export type Database = ReturnType<typeof createDb>;
export type SqlClient = ReturnType<typeof postgres>;

let singletonConnectionString: string | undefined;
let singletonClient: SqlClient | undefined;
let singletonDb: Database | undefined;

export function getDb(connectionString: string): Database {
  if (!singletonDb) {
    singletonConnectionString = connectionString;
    singletonClient = postgres(connectionString);
    singletonDb = drizzle(singletonClient, { schema });
    return singletonDb;
  }

  if (singletonConnectionString !== connectionString) {
    throw new Error("Database singleton already initialized with a different connection string.");
  }

  return singletonDb;
}

export function getDbClient(connectionString: string): SqlClient {
  getDb(connectionString);

  if (!singletonClient) {
    throw new Error("Database client failed to initialize.");
  }

  return singletonClient;
}
