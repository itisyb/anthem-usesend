import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ database: vi.fn(), ping: vi.fn() }));
vi.mock("~/server/db", () => ({
  db: { emailRequest: { findFirst: m.database } },
}));
vi.mock("~/server/redis", () => ({ getRedis: () => ({ ping: m.ping }) }));
import { GET } from "./route";
beforeEach(() => {
  m.database.mockResolvedValue(null);
  m.ping.mockResolvedValue("PONG");
});
describe("email service readiness", () => {
  it("requires the migrated database and Redis to be reachable", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "ok" });
  });
  it("fails readiness for an unavailable database without exposing errors", async () => {
    m.database.mockRejectedValue(
      new Error("private database connection details"),
    );
    const response = await GET();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "unavailable" });
  });
  it("fails readiness when Redis is unavailable", async () => {
    m.ping.mockRejectedValue(new Error("Redis down"));
    expect((await GET()).status).toBe(503);
  });
});
