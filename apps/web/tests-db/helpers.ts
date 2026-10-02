/**
 * Throwaway databases for the integration tests. TEST_DATABASE_URL points
 * at an admin connection (any existing database); each call creates a
 * fresh `gauntlet_test_<random>` database and returns its URL and a
 * cleanup that drops it.
 */
import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { sslFor } from "@/lib/db";

export function adminUrl(): string {
  const url = process.env["TEST_DATABASE_URL"];
  if (!url) {
    throw new Error(
      "TEST_DATABASE_URL is not set. Point it at a disposable Postgres, e.g. " +
        "TEST_DATABASE_URL=postgresql://postgres@localhost:5432/postgres DATABASE_SSL=disable npm run test:db",
    );
  }
  return url;
}

export async function withAdmin<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const url = adminUrl();
  const client = new Client({ connectionString: url, ssl: sslFor(url) });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

export async function createTestDatabase(): Promise<{ url: string; drop: () => Promise<void> }> {
  const name = `gauntlet_test_${randomBytes(6).toString("hex")}`;
  await withAdmin((c) => c.query(`create database ${name}`));
  const url = new URL(adminUrl());
  url.pathname = `/${name}`;
  return {
    url: url.toString(),
    drop: () => withAdmin((c) => c.query(`drop database if exists ${name} with (force)`)).then(() => undefined),
  };
}

export async function connect(url: string): Promise<Client> {
  const client = new Client({ connectionString: url, ssl: sslFor(url) });
  await client.connect();
  return client;
}
