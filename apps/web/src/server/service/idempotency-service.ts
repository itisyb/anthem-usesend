import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { db } from "../db";
import { getRedis, redisKey } from "~/server/redis";
import { canonicalizePayload } from "~/server/utils/idempotency";
import { UnsendApiError } from "~/server/public-api/api-error";
import { logger } from "~/server/logger/log";

const IDEMPOTENCY_RESULT_TTL_SECONDS = 24 * 60 * 60; // 24h
const IDEMPOTENCY_LOCK_TTL_SECONDS = 60; // 60s

export type IdempotencyRecord = {
  bodyHash: string;
  emailIds: string[];
};

export type IdempotencyHandlerOptions<TPayload, TResult> = {
  teamId: number;
  idemKey: string | undefined;
  payload: TPayload;
  operation: (requestId?: string) => Promise<TResult>;
  extractEmailIds: (result: TResult) => string[];
  formatCachedResponse: (emailIds: string[]) => TResult;
  logContext: string;
};

function resultKey(teamId: number, key: string) {
  return redisKey(`idem:${teamId}:${key}`);
}

function lockKey(teamId: number, key: string) {
  return redisKey(`idemlock:${teamId}:${key}`);
}

export const IdempotencyService = {
  async getResult(
    teamId: number,
    key: string,
  ): Promise<IdempotencyRecord | null> {
    const redis = getRedis();
    const raw = await redis.get(resultKey(teamId, key));
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      if (
        parsed &&
        typeof parsed === "object" &&
        typeof (parsed as any).bodyHash === "string" &&
        Array.isArray((parsed as any).emailIds)
      ) {
        return parsed as IdempotencyRecord;
      }
      return null;
    } catch {
      return null;
    }
  },

  async setResult(
    teamId: number,
    key: string,
    record: IdempotencyRecord,
  ): Promise<void> {
    const redis = getRedis();
    await redis.setex(
      resultKey(teamId, key),
      IDEMPOTENCY_RESULT_TTL_SECONDS,
      JSON.stringify(record),
    );
  },

  async acquireLock(teamId: number, key: string): Promise<boolean> {
    const redis = getRedis();
    const ok = await redis.set(
      lockKey(teamId, key),
      "1",
      "EX",
      IDEMPOTENCY_LOCK_TTL_SECONDS,
      "NX",
    );
    return ok === "OK";
  },

  async releaseLock(teamId: number, key: string): Promise<void> {
    const redis = getRedis();
    await redis.del(lockKey(teamId, key));
  },

  async withIdempotency<TPayload, TResult>(
    options: IdempotencyHandlerOptions<TPayload, TResult>,
  ): Promise<TResult> {
    const {
      teamId,
      idemKey,
      payload,
      operation,
      extractEmailIds,
      formatCachedResponse,
      logContext,
    } = options;

    // Validate idempotency key length
    if (idemKey !== undefined && (idemKey.length < 1 || idemKey.length > 256)) {
      throw new UnsendApiError({
        code: "BAD_REQUEST",
        message: "Invalid Idempotency-Key length",
      });
    }

    // If no idempotency key, just execute the operation
    if (!idemKey) {
      return await operation();
    }

    const { bodyHash: payloadHash } = canonicalizePayload(payload);
    const keyHash = createHash("sha256").update(idemKey).digest("hex");
    const where = { teamId_keyHash: { teamId, keyHash } };
    const replay = (record: {
      bodyHash: string;
      status: string;
      emailIds: string[];
    }): TResult => {
      if (record.bodyHash !== payloadHash)
        throw new UnsendApiError({
          code: "NOT_UNIQUE",
          message: "Idempotency-Key already used with a different payload",
        });
      if (record.status !== "COMPLETED")
        throw new UnsendApiError({
          code: "NOT_UNIQUE",
          message:
            "Request is in progress or its outcome needs reconciliation. Do not resend with a new key.",
        });
      return formatCachedResponse(record.emailIds);
    };
    const existing = await db.emailRequest.findUnique({ where });
    if (existing) return replay(existing);

    // Honor pre-fork results during the 24-hour cutover window. Redis failure
    // fails closed here, before any side effect, rather than risking a duplicate.
    const legacy = await this.getResult(teamId, idemKey);
    if (legacy) {
      const record = await db.emailRequest.upsert({
        where,
        create: {
          teamId,
          keyHash,
          bodyHash: legacy.bodyHash,
          emailIds: legacy.emailIds,
          status: "COMPLETED",
        },
        update: {},
      });
      return replay(record);
    }
    const redis = getRedis();
    if (await redis.exists(lockKey(teamId, idemKey)))
      throw new UnsendApiError({
        code: "NOT_UNIQUE",
        message:
          "A pre-cutover request is still in progress. Retry with the same key later.",
      });

    let request;
    try {
      request = await db.emailRequest.create({
        data: { teamId, keyHash, bodyHash: payloadHash, emailIds: [] },
      });
    } catch (error) {
      if (
        !(error instanceof Prisma.PrismaClientKnownRequestError) ||
        error.code !== "P2002"
      )
        throw error;
      return replay(await db.emailRequest.findUniqueOrThrow({ where }));
    }
    // Never remove this fence on an exception: the provider/queue may already
    // have accepted work. Linked Email rows give operators exact evidence.
    try {
      const result = await operation(request.id);
      await db.emailRequest.update({
        where: { id: request.id },
        data: { status: "COMPLETED", emailIds: extractEmailIds(result) },
      });
      // Keep old-version results warm for a controlled rollback. PostgreSQL is
      // authoritative; losing this cache write must not repeat a completed send.
      await this.setResult(teamId, idemKey, {
        bodyHash: payloadHash,
        emailIds: extractEmailIds(result),
      }).catch((error) => {
        logger.error(
          { err: error, requestId: request.id },
          "Legacy idempotency cache was not updated",
        );
      });
      return result;
    } catch (error) {
      await db.emailRequest
        .update({ where: { id: request.id }, data: { status: "RECONCILE" } })
        .catch((persistError) => {
          logger.error(
            { err: persistError, requestId: request.id },
            "Email request remains fenced after a failed completion write",
          );
        });
      throw error;
    }
  },
};

export const IDEMPOTENCY_CONSTANTS = {
  RESULT_TTL_SECONDS: IDEMPOTENCY_RESULT_TTL_SECONDS,
  LOCK_TTL_SECONDS: IDEMPOTENCY_LOCK_TTL_SECONDS,
};
