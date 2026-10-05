import { db } from "../db";
import { UnrecoverableError } from "bullmq";

/** A durable claim survives a worker crash after SES may have accepted a send.
 * An unresolved claim requires reconciliation, never an automatic resend.
 * Existing EmailEvent storage keeps this fork compatible without migrations.
 */
export async function claimDispatch(emailId: string) {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Email" WHERE id = ${emailId} FOR UPDATE`;
    const email = await tx.email.findUniqueOrThrow({ where: { id: emailId } });
    if (
      email.sesEmailId ||
      !["QUEUED", "SCHEDULED"].includes(email.latestStatus)
    )
      return null;
    const pending = await tx.emailEvent.findFirst({
      where: { emailId, data: { path: ["dispatchState"], equals: "started" } },
    });
    if (pending)
      throw new UnrecoverableError(
        "Delivery outcome unknown after an interrupted send; reconcile SES events before resending",
      );
    return tx.emailEvent.create({
      data: {
        emailId,
        teamId: email.teamId,
        status: "QUEUED",
        data: { dispatchState: "started" },
      },
    });
  });
}
