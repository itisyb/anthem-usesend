import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  send: vi.fn(),
  batch: vi.fn(),
  auth: vi.fn(),
  redis: { incr: vi.fn(), expire: vi.fn(), ttl: vi.fn() },
}));
vi.mock("~/server/service/email-service", () => ({
  sendEmail: m.send,
  sendBulkEmails: m.batch,
}));
vi.mock("~/server/service/idempotency-service", () => ({
  IdempotencyService: {
    withIdempotency: ({
      operation,
    }: {
      operation: (requestId: string) => unknown;
    }) => operation("server-request-id"),
  },
}));
vi.mock("~/server/public-api/auth", () => ({ getTeamFromToken: m.auth }));
vi.mock("~/server/redis", () => ({
  getRedis: () => m.redis,
  redisKey: (key: string) => key,
}));
vi.mock("~/utils/common", () => ({ isSelfHosted: () => false }));
import { getApp } from "~/server/public-api/hono";
import registerSend from "./send-email";
import registerBatch from "./batch-email";
const message = {
  from: "sender@example.test",
  to: "buyer@example.test",
  subject: "Test",
  text: "Hello",
  requestId: "untrusted-client-value",
};
beforeEach(() => {
  m.auth.mockResolvedValue({
    id: 1,
    apiRateLimit: 20,
    apiKeyId: 11,
    apiKey: { domainId: null },
  });
  m.redis.incr.mockResolvedValue(1);
  m.redis.expire.mockResolvedValue(1);
  m.redis.ttl.mockResolvedValue(1);
  m.send.mockResolvedValue({ id: "mail-1" });
  m.batch.mockResolvedValue([{ id: "mail-1" }]);
});
describe("durable request linkage", () => {
  it("passes the server-owned request ID into single email creation", async () => {
    const app = getApp();
    registerSend(app);
    const response = await app.request("http://localhost/api/v1/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "key" },
      body: JSON.stringify(message),
    });
    expect(response.status).toBe(200);
    expect(m.send).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: "server-request-id", teamId: 1 }),
    );
  });
  it("links every email in a batch to the server-owned request ID", async () => {
    const app = getApp();
    registerBatch(app);
    const response = await app.request("http://localhost/api/v1/emails/batch", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "batch-key",
      },
      body: JSON.stringify([message]),
    });
    expect(response.status).toBe(200);
    expect(m.batch).toHaveBeenCalledWith([
      expect.objectContaining({ requestId: "server-request-id", teamId: 1 }),
    ]);
  });
});
