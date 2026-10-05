import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "~/server/db";
import { createTeam } from "~/test/factories/core";
import {
  closeIntegrationConnections,
  integrationEnabled,
  resetDatabase,
  resetRedis,
} from "~/test/integration/helpers";
import { claimDispatch } from "./email-dispatch";
import { IdempotencyService } from "./idempotency-service";

const describeIntegration = integrationEnabled ? describe : describe.skip;

describeIntegration("email reliability against PostgreSQL and Redis", () => {
  let teamId: number;

  beforeEach(async () => {
    await resetDatabase();
    await resetRedis();
    teamId = (await createTeam({ name: "Email reliability test" })).id;
  });

  afterAll(closeIntegrationConnections);

  const createEmail = (requestId?: string) =>
    db.email.create({
      data: {
        teamId,
        requestId,
        from: "sender@example.test",
        to: ["buyer@example.test"],
        cc: [],
        bcc: [],
        replyTo: [],
        subject: "Concurrency test",
      },
    });

  const requestOptions = (
    operation: (requestId?: string) => Promise<{ id: string }>,
  ) => ({
    teamId,
    idemKey: "same-logical-send",
    payload: { to: "buyer@example.test", subject: "Concurrency test" },
    operation,
    extractEmailIds: (email: { id: string }) => [email.id],
    formatCachedResponse: (ids: string[]) => ({ id: ids[0]! }),
    logContext: "reliability-integration",
  });

  it("creates one linked email when concurrent clients submit the same key", async () => {
    const operation = vi.fn(createEmail);
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        IdempotencyService.withIdempotency(requestOptions(operation)),
      ),
    );
    expect(operation).toHaveBeenCalledTimes(1);
    expect(results.some((result) => result.status === "fulfilled")).toBe(true);
    expect(await db.email.count()).toBe(1);
    const request = await db.emailRequest.findFirstOrThrow({
      include: { emails: true },
    });
    expect(request.status).toBe("COMPLETED");
    expect(request.emails).toHaveLength(1);
    expect(request.emailIds).toEqual([request.emails[0]!.id]);
  });

  it("replays the durable result after the entire Redis test cache is lost", async () => {
    const operation = vi.fn(createEmail);
    const first = await IdempotencyService.withIdempotency(
      requestOptions(operation),
    );
    await resetRedis();
    const replay = await IdempotencyService.withIdempotency(
      requestOptions(operation),
    );
    expect(replay.id).toBe(first.id);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("keeps a partially completed request fenced with exact linked email evidence", async () => {
    const operation = vi.fn(async (requestId?: string) => {
      await createEmail(requestId);
      throw new Error("Queue acknowledgement lost");
    });
    await expect(
      IdempotencyService.withIdempotency(requestOptions(operation)),
    ).rejects.toThrow("Queue acknowledgement lost");
    await expect(
      IdempotencyService.withIdempotency(requestOptions(operation)),
    ).rejects.toThrow("needs reconciliation");
    const request = await db.emailRequest.findFirstOrThrow({
      include: { emails: true },
    });
    expect(request.status).toBe("RECONCILE");
    expect(request.emails).toHaveLength(1);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("allows only one worker to claim the same row under real concurrent transactions", async () => {
    const email = await createEmail();
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () => claimDispatch(email.id)),
    );
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    for (const result of results) {
      if (result.status === "rejected")
        expect(result.reason.message).toContain("outcome unknown");
    }
    expect(await db.emailEvent.count({ where: { emailId: email.id } })).toBe(1);
  });

  it("allows another claim only after the previous claim records an explicit rejection", async () => {
    const email = await createEmail();
    const first = await claimDispatch(email.id);
    await db.emailEvent.update({
      where: { id: first!.id },
      data: { data: { dispatchState: "rejected", reason: "SES throttled" } },
    });
    const second = await claimDispatch(email.id);
    expect(second?.id).not.toBe(first!.id);
    await expect(claimDispatch(email.id)).rejects.toThrow("outcome unknown");
  });

  it.each(["accepted", "cancelled"])(
    "does not claim an %s message",
    async (state) => {
      const email = await createEmail();
      await db.email.update({
        where: { id: email.id },
        data:
          state === "accepted"
            ? { sesEmailId: "ses-test" }
            : { latestStatus: "CANCELLED" },
      });
      await expect(claimDispatch(email.id)).resolves.toBeNull();
      expect(await db.emailEvent.count({ where: { emailId: email.id } })).toBe(
        0,
      );
    },
  );
});
