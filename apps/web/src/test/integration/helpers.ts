import { Prisma } from "@prisma/client";
import { db } from "~/server/db";
import { getRedis } from "~/server/redis";

export const integrationEnabled = process.env.RUN_INTEGRATION === "true";

function requireLocalTestDatabase(kind: "DATABASE_URL" | "REDIS_URL") {
  const url = new URL(process.env[kind] ?? "");
  if (
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    (kind === "DATABASE_URL"
      ? !url.pathname.endsWith("_test")
      : url.pathname !== "/15")
  ) {
    throw new Error(
      `Refusing destructive test reset outside a local test database: ${kind}`,
    );
  }
}

export async function resetDatabase() {
  requireLocalTestDatabase("DATABASE_URL");
  const rows = await db.$queryRaw<Array<{ tablename: string }>>(Prisma.sql`
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename != '_prisma_migrations'
  `);

  if (rows.length === 0) {
    return;
  }

  const tables = rows.map((row) => `"public"."${row.tablename}"`).join(", ");

  await db.$executeRawUnsafe(
    `TRUNCATE TABLE ${tables} RESTART IDENTITY CASCADE;`,
  );
}

export async function resetRedis() {
  requireLocalTestDatabase("REDIS_URL");
  await getRedis().flushdb();
}

export async function closeIntegrationConnections() {
  await db.$disconnect();

  const redis = getRedis();
  if (redis.status !== "end") {
    await redis.quit();
  }
}
