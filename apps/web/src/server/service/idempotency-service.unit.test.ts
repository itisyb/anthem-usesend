import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
const m = vi.hoisted(() => ({
  db: {
    emailRequest: {
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      upsert: vi.fn(),
    },
  },
  redis: { get: vi.fn(), exists: vi.fn() },
}));
vi.mock("~/server/db", () => ({ db: m.db }));
vi.mock("~/server/redis", () => ({
  getRedis: () => m.redis,
  redisKey: (key: string) => key,
}));
vi.mock("~/server/logger/log", () => ({
  logger: { info: vi.fn(), error: vi.fn() },
}));
import { IdempotencyService } from "./idempotency-service";
import { canonicalizePayload } from "../utils/idempotency";
const payload = { to: "buyer@example.test", subject: "Test" };
const bodyHash = canonicalizePayload(payload).bodyHash;
const options = () => ({
  teamId: 1,
  idemKey: "send-1",
  payload,
  operation: vi.fn(async () => ({ emailIds: ["mail-1"] })),
  extractEmailIds: (value: { emailIds: string[] }) => value.emailIds,
  formatCachedResponse: (emailIds: string[]) => ({ emailIds }),
  logContext: "test",
});
beforeEach(() => {
  m.db.emailRequest.findUnique.mockResolvedValue(null);
  m.redis.get.mockResolvedValue(null);
  m.redis.exists.mockResolvedValue(0);
  m.db.emailRequest.create.mockResolvedValue({ id: "request-1" });
});
describe("durable API idempotency", () => {
  it("fences before side effects and links email creation to the request", async () => {
    const input = options();
    input.operation.mockImplementation(async (requestId?: string) => {
      expect(requestId).toBe("request-1");
      return { emailIds: ["mail-1"] };
    });
    await IdempotencyService.withIdempotency(input);
    expect(m.db.emailRequest.create.mock.invocationCallOrder[0]).toBeLessThan(
      input.operation.mock.invocationCallOrder[0]!,
    );
    expect(m.db.emailRequest.update).toHaveBeenCalledWith({
      where: { id: "request-1" },
      data: { status: "COMPLETED", emailIds: ["mail-1"] },
    });
  });
  it("replays completed requests even if Redis is unavailable", async () => {
    m.db.emailRequest.findUnique.mockResolvedValue({
      bodyHash,
      status: "COMPLETED",
      emailIds: ["mail-1"],
    });
    m.redis.get.mockRejectedValue(new Error("Redis down"));
    const input = options();
    await expect(IdempotencyService.withIdempotency(input)).resolves.toEqual({
      emailIds: ["mail-1"],
    });
    expect(input.operation).not.toHaveBeenCalled();
    expect(m.redis.get).not.toHaveBeenCalled();
  });
  it.each(["PROCESSING", "RECONCILE"])(
    "does not re-run a %s request",
    async (status) => {
      m.db.emailRequest.findUnique.mockResolvedValue({
        bodyHash,
        status,
        emailIds: [],
      });
      const input = options();
      await expect(IdempotencyService.withIdempotency(input)).rejects.toThrow(
        "reconciliation",
      );
      expect(input.operation).not.toHaveBeenCalled();
    },
  );
  it("rejects a changed payload for an existing key", async () => {
    m.db.emailRequest.findUnique.mockResolvedValue({
      bodyHash: "other",
      status: "COMPLETED",
      emailIds: ["mail-1"],
    });
    await expect(IdempotencyService.withIdempotency(options())).rejects.toThrow(
      "different payload",
    );
  });
  it("retains the fence after a lost completion acknowledgement", async () => {
    m.db.emailRequest.update.mockRejectedValue(
      new Error("database unavailable"),
    );
    const input = options();
    await expect(IdempotencyService.withIdempotency(input)).rejects.toThrow(
      "database unavailable",
    );
    expect(input.operation).toHaveBeenCalledTimes(1);
    expect(m.db.emailRequest.update).toHaveBeenLastCalledWith({
      where: { id: "request-1" },
      data: { status: "RECONCILE" },
    });
  });
  it("resolves a uniqueness race without repeating the operation", async () => {
    m.db.emailRequest.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("duplicate", {
        code: "P2002",
        clientVersion: "test",
      }),
    );
    m.db.emailRequest.findUniqueOrThrow.mockResolvedValue({
      bodyHash,
      status: "COMPLETED",
      emailIds: ["mail-1"],
    });
    const input = options();
    await expect(IdempotencyService.withIdempotency(input)).resolves.toEqual({
      emailIds: ["mail-1"],
    });
    expect(input.operation).not.toHaveBeenCalled();
  });
  it("honors legacy Redis results at cutover", async () => {
    m.redis.get.mockResolvedValue(
      JSON.stringify({ bodyHash, emailIds: ["legacy-mail"] }),
    );
    m.db.emailRequest.upsert.mockResolvedValue({
      bodyHash,
      status: "COMPLETED",
      emailIds: ["legacy-mail"],
    });
    const input = options();
    await expect(IdempotencyService.withIdempotency(input)).resolves.toEqual({
      emailIds: ["legacy-mail"],
    });
    expect(input.operation).not.toHaveBeenCalled();
  });
  it("fails closed on missing database or legacy Redis evidence", async () => {
    m.redis.get.mockRejectedValue(new Error("Redis down"));
    const input = options();
    await expect(IdempotencyService.withIdempotency(input)).rejects.toThrow(
      "Redis down",
    );
    expect(input.operation).not.toHaveBeenCalled();
  });
});
