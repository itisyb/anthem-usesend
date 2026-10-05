import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  queue: vi.fn(),
  verify: vi.fn(),
  confirm: vi.fn(),
  update: vi.fn(),
  setting: vi.fn(),
}));
vi.mock("~/server/db", () => ({
  db: { sesSetting: { findFirst: m.setting, update: m.update } },
}));
vi.mock("~/server/logger/log", () => ({ logger: { error: vi.fn() } }));
vi.mock("~/server/service/ses-hook-parser", () => ({
  SesHookParser: { queue: m.queue },
}));
vi.mock("~/server/service/ses-settings-service", () => ({
  SesSettingsService: {
    getTopicArns: vi.fn(async () => ["topic"]),
    invalidateCache: vi.fn(),
  },
}));
vi.mock("~/server/aws/sns", () => ({ confirmSubscription: m.confirm }));
vi.mock("~/server/aws/verify-sns", async (original) => ({
  ...(await original<object>()),
  verifySnsMessage: m.verify,
}));
import { InvalidSnsMessage } from "~/server/aws/verify-sns";
import { POST } from "./route";
const request = () =>
  new Request("https://example.test/api/ses_callback", {
    method: "POST",
    body: "{}",
  });
beforeEach(() => {
  m.verify.mockResolvedValue({
    Type: "Notification",
    MessageId: "id-1",
    Message: JSON.stringify({
      eventType: "Delivery",
      mail: { messageId: "ses-1" },
    }),
  });
  m.queue.mockResolvedValue({ id: "job-1" });
});
describe("SES callback acknowledgements", () => {
  it("acknowledges only after durable queue acceptance", async () => {
    expect((await POST(request())).status).toBe(200);
    expect(m.queue).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: "id-1" }),
    );
  });
  it("asks SNS to retry a queue failure", async () => {
    m.queue.mockRejectedValue(new Error("Redis unavailable"));
    expect((await POST(request())).status).toBe(503);
  });
  it("rejects unsigned requests", async () => {
    m.verify.mockRejectedValue(new InvalidSnsMessage("bad signature"));
    expect((await POST(request())).status).toBe(403);
    expect(m.queue).not.toHaveBeenCalled();
  });
  it("confirms via AWS without fetching SubscribeURL", async () => {
    m.verify.mockResolvedValue({
      Type: "SubscriptionConfirmation",
      TopicArn: "topic",
      Token: "token",
      SubscribeURL: "http://127.0.0.1/private",
    });
    m.setting.mockResolvedValue({ id: 1, region: "us-west-1" });
    expect((await POST(request())).status).toBe(200);
    expect(m.confirm).toHaveBeenCalledWith("topic", "token", "us-west-1");
  });
  it("enforces a body size bound without Content-Length", async () => {
    const response = await POST(
      new Request("https://example.test", {
        method: "POST",
        body: "x".repeat(300001),
      }),
    );
    expect(response.status).toBe(413);
    expect(m.verify).not.toHaveBeenCalled();
  });
});
