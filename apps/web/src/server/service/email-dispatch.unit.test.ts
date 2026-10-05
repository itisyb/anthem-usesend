import { beforeEach, describe, expect, it, vi } from "vitest";
const tx = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
  email: { findUniqueOrThrow: vi.fn() },
  emailEvent: { findFirst: vi.fn(), create: vi.fn() },
}));
vi.mock("~/server/db", () => ({
  db: { $transaction: (run: (value: typeof tx) => unknown) => run(tx) },
}));
import { claimDispatch } from "./email-dispatch";
beforeEach(() => {
  tx.email.findUniqueOrThrow.mockResolvedValue({
    latestStatus: "QUEUED",
    sesEmailId: null,
    teamId: 1,
  });
  tx.emailEvent.findFirst.mockResolvedValue(null);
  tx.emailEvent.create.mockResolvedValue({ id: "attempt-1" });
});
describe("durable dispatch claim", () => {
  it("locks the row before checking and persisting a claim", async () => {
    await expect(claimDispatch("mail-1")).resolves.toEqual({ id: "attempt-1" });
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.email.findUniqueOrThrow.mock.invocationCallOrder[0]!,
    );
    expect(tx.emailEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ data: { dispatchState: "started" } }),
      }),
    );
  });
  it("requires reconciliation after an interrupted send", async () => {
    tx.emailEvent.findFirst.mockResolvedValue({ id: "interrupted" });
    await expect(claimDispatch("mail-1")).rejects.toThrow("outcome unknown");
    expect(tx.emailEvent.create).not.toHaveBeenCalled();
  });
  it("rechecks cancellation after acquiring the row lock", async () => {
    tx.email.findUniqueOrThrow.mockResolvedValue({ latestStatus: "CANCELLED" });
    await expect(claimDispatch("mail-1")).resolves.toBeNull();
    expect(tx.emailEvent.create).not.toHaveBeenCalled();
  });
});
