import { db } from "~/server/db";
import { logger } from "~/server/logger/log";
import { SesHookParser } from "~/server/service/ses-hook-parser";
import { SesSettingsService } from "~/server/service/ses-settings-service";
import { confirmSubscription } from "~/server/aws/sns";
import { InvalidSnsMessage, verifySnsMessage } from "~/server/aws/verify-sns";

export const dynamic = "force-dynamic";
export async function GET() {
  return Response.json({ data: "Hello" });
}

export async function POST(req: Request) {
  try {
    // Bound the body even when Content-Length is absent or dishonest.
    const reader = req.body?.getReader();
    if (!reader)
      return Response.json({ error: "Missing body" }, { status: 400 });
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 300000)
          return Response.json({ error: "Body too large" }, { status: 413 });
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    let input: unknown;
    try {
      input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      return Response.json({ error: "Invalid JSON" }, { status: 400 });
    }
    const message = await verifySnsMessage(
      input,
      await SesSettingsService.getTopicArns(),
    );
    if (message.Type === "SubscriptionConfirmation") {
      const setting = await db.sesSetting.findFirst({
        where: { topicArn: message.TopicArn },
      });
      if (!setting) throw new InvalidSnsMessage("Unknown SNS topic");
      await confirmSubscription(
        message.TopicArn!,
        message.Token!,
        setting.region,
      );
      await db.sesSetting.update({
        where: { id: setting.id },
        data: { callbackSuccess: true },
      });
      SesSettingsService.invalidateCache();
    } else {
      let event;
      try {
        event = JSON.parse(message.Message!);
      } catch {
        return Response.json({ error: "Invalid event JSON" }, { status: 400 });
      }
      if (
        !event ||
        typeof event !== "object" ||
        typeof event.eventType !== "string" ||
        !event.mail?.messageId
      )
        return Response.json({ error: "Invalid SES event" }, { status: 400 });
      const queued = await SesHookParser.queue({
        event,
        messageId: message.MessageId!,
      });
      if (!queued) throw new Error("SES event could not be queued");
    }
    return Response.json({ data: "Success" });
  } catch (error) {
    if (error instanceof InvalidSnsMessage)
      return Response.json({ error: error.message }, { status: 403 });
    logger.error({ err: error }, "SES callback temporarily unavailable");
    return Response.json(
      { error: "Callback temporarily unavailable" },
      { status: 503 },
    );
  }
}
