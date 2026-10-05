import { db } from "~/server/db";
import { getRedis } from "~/server/redis";

export const dynamic = "force-dynamic";
export async function GET() {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.all([
        db.emailRequest.findFirst({ select: { id: true } }),
        getRedis().ping(),
      ]),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Health check timeout")),
          5000,
        );
      }),
    ]);
    return Response.json({
      status: "ok",
      commit: process.env.NEXT_PUBLIC_GIT_SHA ?? "unknown",
    });
  } catch {
    return Response.json({ status: "unavailable" }, { status: 503 });
  } finally {
    if (timer) clearTimeout(timer);
  }
}
