import { beforeEach, describe, expect, it, vi } from "vitest";
import { DelayedError, UnrecoverableError } from "bullmq";

const m = vi.hoisted(() => ({
  db: {
    email: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    domain: { findUnique: vi.fn() },
    sesSetting: { findUnique: vi.fn(), findMany: vi.fn() },
    emailEvent: { create: vi.fn(), update: vi.fn() },
  },
  send: vi.fn(),
  budget: vi.fn(),
  claim: vi.fn(),
  configuration: vi.fn(),
  limit: vi.fn(),
  emit: vi.fn(),
}));
vi.mock("~/server/db", () => ({ db: m.db }));
vi.mock("~/server/aws/ses", () => ({ sendRawEmail: m.send }));
vi.mock("~/server/redis", () => ({ getRedis: vi.fn(), BULL_PREFIX: "test" }));
vi.mock("~/server/service/ses-send-budget", async (original) => ({
  ...(await original<object>()),
  reserveSendBudget: m.budget,
}));
vi.mock("~/server/service/email-dispatch", () => ({ claimDispatch: m.claim }));
vi.mock("~/server/service/limit-service", () => ({
  LimitService: { checkEmailLimit: m.limit },
}));
vi.mock("~/server/service/webhook-service", () => ({
  WebhookService: { emit: m.emit },
}));
vi.mock("~/utils/ses-utils", () => ({
  getConfigurationSetName: m.configuration,
}));
vi.mock("~/server/logger/log", () => ({
  logger: { info: vi.fn(), error: vi.fn() },
}));
import { executeEmail, EmailQueueService } from "./email-queue-service";

const email = {
  id: "mail-1",
  teamId: 1,
  domainId: null,
  from: "sender@example.test",
  to: ["a@example.test"],
  cc: ["b@example.test"],
  bcc: ["c@example.test"],
  replyTo: [],
  subject: "Test",
  html: "hello",
  text: "hello",
  headers: null,
  attachments: null,
  campaignId: null,
  inReplyToId: null,
  latestStatus: "QUEUED",
  sesEmailId: null,
};
const job = () =>
  ({
    data: { emailId: email.id, timestamp: Date.now() },
    attemptsMade: 0,
    token: "token",
    moveToDelayed: vi.fn(),
  }) as unknown as Parameters<typeof executeEmail>[0];
beforeEach(() => {
  m.db.email.findUnique.mockResolvedValue({ ...email });
  m.db.email.updateMany.mockResolvedValue({ count: 1 });
  m.db.sesSetting.findUnique.mockResolvedValue({ sesEmailRateLimit: 10 });
  m.configuration.mockResolvedValue("config");
  m.limit.mockResolvedValue({ isLimitReached: false });
  m.claim.mockResolvedValue({ id: "attempt-1" });
  m.budget.mockResolvedValue(0);
  m.send.mockResolvedValue("ses-1");
});
describe("safe dispatch", () => {
  it("counts To, CC and BCC in the shared budget and persists the provider ID", async () => {
    await executeEmail(job());
    expect(m.budget).toHaveBeenCalledWith(expect.any(String), 10, 3);
    expect(m.db.email.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ sesEmailId: "ses-1" }),
      }),
    );
  });
  it.each(["DELIVERED", "CANCELLED", "FAILED", "SUPPRESSED"])(
    "does not resend %s",
    async (latestStatus) => {
      m.db.email.findUnique.mockResolvedValue({ ...email, latestStatus });
      await executeEmail(job());
      expect(m.send).not.toHaveBeenCalled();
    },
  );
  it("does not resend an accepted message before the SENT callback", async () => {
    m.db.email.findUnique.mockResolvedValue({
      ...email,
      sesEmailId: "ses-existing",
    });
    await executeEmail(job());
    expect(m.send).not.toHaveBeenCalled();
  });
  it("delays exhausted budgets without claiming or recording failure", async () => {
    m.budget.mockResolvedValue(350);
    const item = job();
    await expect(executeEmail(item)).rejects.toBeInstanceOf(DelayedError);
    expect(item.moveToDelayed).toHaveBeenCalled();
    expect(m.claim).not.toHaveBeenCalled();
    expect(m.db.emailEvent.create).not.toHaveBeenCalled();
  });
  it("retries explicit throttling and closes the rejected claim", async () => {
    const throttle = Object.assign(new Error("rate"), {
      name: "TooManyRequestsException",
      $metadata: { httpStatusCode: 429 },
    });
    m.send.mockRejectedValue(throttle);
    await expect(executeEmail(job())).rejects.toBe(throttle);
    expect(m.db.emailEvent.update).toHaveBeenCalledWith({
      where: { id: "attempt-1" },
      data: {
        data: {
          dispatchState: "rejected",
          reason: "SES throttled the request",
        },
      },
    });
    expect(m.db.email.updateMany).not.toHaveBeenCalled();
  });
  it("reports exhausted throttling attempts", async () => {
    m.send.mockRejectedValue({
      name: "TooManyRequestsException",
      $metadata: { httpStatusCode: 429 },
    });
    const item = job();
    item.attemptsMade = 5;
    await expect(executeEmail(item)).rejects.toBeInstanceOf(UnrecoverableError);
    expect(m.emit).toHaveBeenCalled();
  });
  it("keeps an uncertain claim and refuses blind retries after a timeout", async () => {
    m.send.mockRejectedValue(new Error("socket closed after write"));
    await expect(executeEmail(job())).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    expect(m.db.emailEvent.update).not.toHaveBeenCalled();
    expect(m.emit).toHaveBeenCalledWith(
      1,
      "email.failed",
      expect.objectContaining({
        failed: { reason: expect.stringContaining("unknown") },
      }),
      expect.any(Object),
    );
  });
  it("exposes missing configuration instead of silently completing", async () => {
    m.configuration.mockResolvedValue(null);
    await expect(executeEmail(job())).rejects.toThrow("configuration set");
    expect(m.send).not.toHaveBeenCalled();
    expect(m.emit).toHaveBeenCalled();
  });
  it("retries a Redis failure before dispatch without recording a send", async () => {
    m.budget.mockRejectedValue(new Error("Redis connection lost"));
    await expect(executeEmail(job())).rejects.toThrow("Redis connection lost");
    expect(m.claim).not.toHaveBeenCalled();
    expect(m.send).not.toHaveBeenCalled();
    expect(m.db.emailEvent.create).not.toHaveBeenCalled();
  });
  it("shows the actual reason for a definite SES rejection", async () => {
    m.send.mockRejectedValue(
      Object.assign(new Error("Email address is not verified"), {
        name: "MessageRejected",
        $metadata: { httpStatusCode: 400 },
      }),
    );
    await expect(executeEmail(job())).rejects.toThrow(
      "Email address is not verified",
    );
    expect(m.emit).toHaveBeenCalledWith(
      1,
      "email.failed",
      expect.objectContaining({
        failed: { reason: "Email address is not verified" },
      }),
      expect.any(Object),
    );
  });
  it("protects concurrent delivery evidence when a local write fails", async () => {
    m.db.email.update.mockRejectedValue(new Error("db unavailable"));
    m.db.email.updateMany.mockResolvedValue({ count: 0 });
    await expect(executeEmail(job())).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    expect(m.db.email.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "mail-1",
          sesEmailId: null,
          latestStatus: { in: ["QUEUED", "SCHEDULED"] },
        },
      }),
    );
    expect(m.emit).not.toHaveBeenCalled();
  });
  it("does not swallow Redis bulk enqueue errors", async () => {
    m.db.sesSetting.findMany.mockResolvedValue([]);
    EmailQueueService.transactionalQueue.set("test-region", {
      name: "test",
      addBulk: vi.fn().mockRejectedValue(new Error("redis unavailable")),
    } as never);
    await expect(
      EmailQueueService.queueBulk([
        {
          emailId: "mail-1",
          teamId: 1,
          region: "test-region",
          transactional: true,
        },
      ]),
    ).rejects.toThrow("queue writes failed");
  });
});
