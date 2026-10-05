import IORedis from "ioredis";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { RESERVE_RECIPIENTS } from "./ses-send-budget";

// Explicitly local-only: never accepts a production Redis URL.
const enabled = process.env.RUN_EMAIL_REDIS_TESTS === "true";
const redis = enabled
  ? new IORedis("redis://127.0.0.1:16379", { maxRetriesPerRequest: 1 })
  : null;
const prefix = `email-budget-test:${crypto.randomUUID()}`;
let sequence = 0;
const reserve = (region: string, count: number) =>
  redis!.eval(
    RESERVE_RECIPIENTS,
    1,
    `${prefix}:${region}`,
    10,
    count,
    `attempt-${sequence++}`,
  );
(enabled ? describe : describe.skip)(
  "regional recipient budget with real Redis",
  () => {
    beforeEach(async () => {
      await redis!.del(`${prefix}:a`, `${prefix}:b`);
    });
    afterAll(async () => {
      await redis!.del(`${prefix}:a`, `${prefix}:b`);
      await redis!.quit();
    });
    it("atomically shares one budget across competing workers and queues", async () => {
      const results = await Promise.all(
        Array.from({ length: 40 }, () => reserve("a", 1)),
      );
      expect(results.filter((value) => value === 0)).toHaveLength(10);
      expect(results.filter((value) => Number(value) > 0)).toHaveLength(30);
    });
    it("counts recipients rather than jobs and keeps regions independent", async () => {
      expect(await reserve("a", 6)).toBe(0);
      expect(Number(await reserve("a", 5))).toBeGreaterThan(0);
      expect(await reserve("a", 4)).toBe(0);
      expect(await reserve("b", 10)).toBe(0);
    });
    it("releases capacity after a full rolling second", async () => {
      expect(await reserve("a", 10)).toBe(0);
      expect(Number(await reserve("a", 1))).toBeGreaterThan(0);
      await new Promise((resolve) => setTimeout(resolve, 1050));
      expect(await reserve("a", 10)).toBe(0);
    });
  },
);
