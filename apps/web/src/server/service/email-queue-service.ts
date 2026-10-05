import { DelayedError, Queue, UnrecoverableError, Worker } from "bullmq";
import { env } from "~/env";
import { EmailAttachment } from "~/types";
import { convert as htmlToText } from "html-to-text";
import { getConfigurationSetName } from "~/utils/ses-utils";
import { db } from "../db";
import { sendRawEmail } from "../aws/ses";
import { getRedis, BULL_PREFIX } from "../redis";
import { DEFAULT_QUEUE_OPTIONS } from "../queue/queue-constants";
import { logger } from "../logger/log";
import { createWorkerHandler, TeamJob } from "../queue/bullmq-context";
import { LimitService } from "./limit-service";
import { reserveSendBudget, isExplicitSesThrottle } from "./ses-send-budget";
import { claimDispatch } from "./email-dispatch";
import { WebhookService } from "./webhook-service";

const SEND_ATTEMPTS = 6;
const SEND_QUEUE_OPTIONS = {
  ...DEFAULT_QUEUE_OPTIONS,
  attempts: SEND_ATTEMPTS,
  backoff: { type: "exponential", delay: 1000 },
};
import {
  BUILT_IN_CONTACT_VARIABLES,
  replaceContactVariables,
} from "../utils/contact-variable-replacement";
// Notifications about limits are handled inside LimitService.

type QueueEmailJob = TeamJob<{
  emailId: string;
  timestamp: number;
  unsubUrl?: string;
  isBulk?: boolean;
}>;

function createQueueAndWorker(region: string, quota: number, suffix: string) {
  const connection = getRedis();

  const queueName = `${region}-${suffix}`;

  const queue = new Queue(queueName, {
    connection,
    prefix: BULL_PREFIX,
    skipVersionCheck: true,
  });

  // TODO: Add team context to job data when queueing
  const worker = new Worker(queueName, createWorkerHandler(executeEmail), {
    concurrency: quota,
    connection,
    prefix: BULL_PREFIX,
    skipVersionCheck: true,
  });

  return { queue, worker };
}

export class EmailQueueService {
  private static initialized = false;
  public static transactionalQueue = new Map<string, Queue<QueueEmailJob>>();
  private static transactionalWorker = new Map<string, Worker>();
  public static marketingQueue = new Map<string, Queue<QueueEmailJob>>();
  private static marketingWorker = new Map<string, Worker>();

  public static initializeQueue(
    region: string,
    quota: number,
    transactionalQuotaPercentage: number,
  ) {
    logger.info(
      { region },
      `[EmailQueueService]: Initializing queue for region`,
    );

    const transactionalQuota = Math.floor(
      (quota * transactionalQuotaPercentage) / 100,
    );
    const marketingQuota = quota - transactionalQuota;

    if (this.transactionalQueue.has(region)) {
      logger.info(
        { region, transactionalQuota },
        `[EmailQueueService]: Updating transactional quota for region`,
      );
      const transactionalWorker = this.transactionalWorker.get(region);
      if (transactionalWorker) {
        transactionalWorker.concurrency =
          transactionalQuota !== 0 ? transactionalQuota : 1;
      }
    } else {
      logger.info(
        { region, transactionalQuota },
        `[EmailQueueService]: Creating transactional queue for region`,
      );
      const { queue: transactionalQueue, worker: transactionalWorker } =
        createQueueAndWorker(
          region,
          transactionalQuota !== 0 ? transactionalQuota : 1,
          "transaction",
        );
      this.transactionalQueue.set(region, transactionalQueue);
      this.transactionalWorker.set(region, transactionalWorker);
    }

    if (this.marketingQueue.has(region)) {
      logger.info(
        { region, marketingQuota },
        `[EmailQueueService]: Updating marketing quota for region`,
      );
      const marketingWorker = this.marketingWorker.get(region);
      if (marketingWorker) {
        marketingWorker.concurrency = marketingQuota !== 0 ? marketingQuota : 1;
      }
    } else {
      logger.info(
        { region, marketingQuota },
        `[EmailQueueService]: Creating marketing queue for region`,
      );
      const { queue: marketingQueue, worker: marketingWorker } =
        createQueueAndWorker(
          region,
          marketingQuota !== 0 ? marketingQuota : 1,
          "marketing",
        );
      this.marketingQueue.set(region, marketingQueue);
      this.marketingWorker.set(region, marketingWorker);
    }
  }

  public static async queueEmail(
    emailId: string,
    teamId: number,
    region: string,
    transactional: boolean,
    unsubUrl?: string,
    delay?: number,
  ) {
    if (!this.initialized) {
      await this.init();
    }
    const queue = transactional
      ? this.transactionalQueue.get(region)
      : this.marketingQueue.get(region);
    const isBulk = !transactional;
    if (!queue) {
      throw new Error(`Queue for region ${region} not found`);
    }
    await queue.add(
      emailId,
      {
        emailId,
        timestamp: Date.now(),
        unsubUrl,
        isBulk,
        teamId,
      },
      { jobId: emailId, delay, ...SEND_QUEUE_OPTIONS },
    );
  }

  /**
   * Efficiently queues multiple pre-defined email jobs using BullMQ's addBulk.
   * Jobs are grouped by region and type (transactional/marketing) before queuing.
   *
   * @param jobs - Array of job details to queue.
   * @returns A promise that resolves when all bulk additions are attempted.
   */
  public static async queueBulk(
    jobs: {
      emailId: string;
      teamId: number;
      region: string;
      transactional: boolean;
      unsubUrl?: string;
      delay?: number;
      timestamp?: number; // Optional: pass timestamp if needed for data
    }[],
  ): Promise<void> {
    if (jobs.length === 0) {
      logger.info("[EmailQueueService]: No jobs provided for bulk queue.");
      return;
    }

    if (!this.initialized) {
      await this.init();
    }

    logger.info(
      { count: jobs.length },
      `[EmailQueueService]: Starting bulk queue for jobs.`,
    );

    // Group jobs by region and type
    const groupedJobs = jobs.reduce(
      (acc, job) => {
        const key = `${job.region}-${job.transactional ? "transactional" : "marketing"}`;
        if (!acc[key]) {
          acc[key] = {
            queue: job.transactional
              ? this.transactionalQueue.get(job.region)
              : this.marketingQueue.get(job.region),
            region: job.region,
            transactional: job.transactional,
            jobDetails: [],
          };
        }
        acc[key]?.jobDetails.push(job);
        return acc;
      },
      {} as Record<
        string,
        {
          queue: Queue | undefined;
          region: string;
          transactional: boolean;
          jobDetails: typeof jobs;
        }
      >,
    );

    const bulkAddPromises: Promise<any>[] = [];

    // Validate all destinations before starting any asynchronous queue write.
    for (const [groupKey, group] of Object.entries(groupedJobs)) {
      if (!group.queue) throw new Error(`Queue unavailable for ${groupKey}`);
    }

    for (const groupKey in groupedJobs) {
      const group = groupedJobs[groupKey];
      if (!group || !group.queue) {
        logger.error(
          { groupKey, count: group?.jobDetails?.length ?? 0 },
          `[EmailQueueService]: Queue not found for group during bulk add. Skipping jobs.`,
        );
        throw new Error(`Queue unavailable for ${groupKey}`);
      }

      const queue = group.queue;
      const isBulk = !group.transactional;
      const bulkData = group.jobDetails.map((job) => ({
        name: job.emailId, // Use emailId as job name (matches single queue logic)
        data: {
          emailId: job.emailId,
          timestamp: job.timestamp ?? Date.now(),
          unsubUrl: job.unsubUrl,
          isBulk,
          teamId: job.teamId,
        },
        opts: {
          jobId: job.emailId, // Use emailId as jobId
          delay: job.delay,
          ...SEND_QUEUE_OPTIONS, // Apply default options (attempts, backoff)
        },
      }));

      logger.info(
        { count: bulkData.length, queue: queue.name },
        `[EmailQueueService]: Adding jobs to queue`,
      );
      bulkAddPromises.push(
        queue.addBulk(bulkData).catch((error) => {
          logger.error(
            { err: error, queue: queue.name },
            `[EmailQueueService]: Failed to add bulk jobs to queue`,
          );
          throw error;
        }),
      );
    }

    const results = await Promise.allSettled(bulkAddPromises);
    if (results.some((result) => result.status === "rejected")) {
      throw new Error(
        "One or more email queue writes failed; reconcile the created email IDs before retrying",
      );
    }
    logger.info(
      "[EmailQueueService]: Finished processing bulk queue requests.",
    );
  }

  public static async changeDelay(
    emailId: string,
    region: string,
    transactional: boolean,
    delay: number,
  ) {
    if (!this.initialized) {
      await this.init();
    }
    const queue = transactional
      ? this.transactionalQueue.get(region)
      : this.marketingQueue.get(region);
    if (!queue) {
      throw new Error(`Queue for region ${region} not found`);
    }

    const job = await queue.getJob(emailId);
    if (!job) {
      throw new Error(`Job ${emailId} not found`);
    }
    await job.changeDelay(delay);
  }

  public static async chancelEmail(
    emailId: string,
    region: string,
    transactional: boolean,
  ) {
    if (!this.initialized) {
      await this.init();
    }
    const queue = transactional
      ? this.transactionalQueue.get(region)
      : this.marketingQueue.get(region);
    if (!queue) {
      throw new Error(`Queue for region ${region} not found`);
    }

    const job = await queue.getJob(emailId);
    if (!job) {
      throw new Error(`Job ${emailId} not found`);
    }
    await job.remove();
  }

  public static async init() {
    const sesSettings = await db.sesSetting.findMany();
    for (const sesSetting of sesSettings) {
      this.initializeQueue(
        sesSetting.region,
        sesSetting.sesEmailRateLimit,
        sesSetting.transactionalQuota,
      );
    }
    this.initialized = true;
  }
}

export async function executeEmail(job: QueueEmailJob) {
  logger.info(
    { emailId: job.data.emailId, elapsed: Date.now() - job.data.timestamp },
    `[EmailQueueService]: Executing email job`,
  );

  const email = await db.email.findUnique({
    where: { id: job.data.emailId },
  });

  const domain = email?.domainId
    ? await db.domain.findUnique({
        where: { id: email?.domainId },
      })
    : null;

  if (!email) {
    logger.info(
      { emailId: job.data.emailId },
      `[EmailQueueService]: Email not found, skipping`,
    );
    return;
  }

  // A redelivered/stalled job must not send an already accepted or cancelled email.
  if (email.sesEmailId || !["QUEUED", "SCHEDULED"].includes(email.latestStatus))
    return;
  let dispatchId: string | undefined;
  let requestStarted = false;
  try {
    const attachments: Array<EmailAttachment> = email.attachments
      ? JSON.parse(email.attachments)
      : [];

    const configurationSetName = await getConfigurationSetName(
      domain?.clickTracking ?? false,
      domain?.openTracking ?? false,
      domain?.region ?? env.AWS_DEFAULT_REGION,
    );

    if (!configurationSetName) {
      throw new UnrecoverableError(
        "SES configuration set is missing for the sending region",
      );
    }

    logger.info({ emailId: email.id }, `[EmailQueueService]: Sending email`);
    const unsubUrl = job.data.unsubUrl;
    const isBulk = job.data.isBulk;

    const text = email.text
      ? email.text
      : email.campaignId && email.html
        ? htmlToText(email.html)
        : undefined;
    let subject = email.subject;

    if (email.campaignId && email.contactId && subject.includes("{{")) {
      const contact = await db.contact.findUnique({
        where: { id: email.contactId },
        include: {
          contactBook: {
            select: { variables: true },
          },
        },
      });

      if (contact) {
        subject = replaceContactVariables(subject, contact, [
          ...BUILT_IN_CONTACT_VARIABLES,
          ...contact.contactBook.variables,
        ]);

        if (subject !== email.subject) {
          await db.email.update({
            where: { id: email.id },
            data: { subject },
          });
        }
      }
    }

    let inReplyToMessageId: string | undefined = undefined;

    if (email.inReplyToId) {
      const replyEmail = await db.email.findUnique({
        where: {
          id: email.inReplyToId,
        },
      });

      if (replyEmail && replyEmail.sesEmailId) {
        inReplyToMessageId = replyEmail.sesEmailId;
      }
    }

    // Check limits right before sending (cloud-only)
    const limitCheck = await LimitService.checkEmailLimit(email.teamId);
    logger.info({ limitCheck }, `[EmailQueueService]: Limit check`);
    if (limitCheck.isLimitReached) {
      throw new UnrecoverableError(
        `Email sending limit reached: ${limitCheck.reason}`,
      );
    }

    const customHeaders = email.headers ? JSON.parse(email.headers) : undefined;

    const region = domain?.region ?? env.AWS_DEFAULT_REGION;
    const setting = await db.sesSetting.findUnique({ where: { region } });
    if (!setting)
      throw new UnrecoverableError(
        "SES settings are missing for the sending region",
      );
    const waitMs = await reserveSendBudget(
      region,
      setting.sesEmailRateLimit,
      email.to.length + email.cc.length + email.bcc.length,
    );
    if (waitMs > 0) {
      await job.moveToDelayed(Date.now() + waitMs + 25, job.token);
      throw new DelayedError();
    }
    const dispatch = await claimDispatch(email.id);
    if (!dispatch) return;
    dispatchId = dispatch.id;
    requestStarted = true;
    const messageId = await sendRawEmail({
      to: email.to,
      from: email.from,
      subject,
      replyTo: email.replyTo ?? undefined,
      bcc: email.bcc,
      cc: email.cc,
      text,
      html: email.html ?? undefined,
      region: domain?.region ?? env.AWS_DEFAULT_REGION,
      configurationSetName,
      attachments: attachments.length > 0 ? attachments : undefined,
      unsubUrl,
      isBulk,
      inReplyToMessageId,
      emailId: email.id,
      sesTenantId: domain?.sesTenantId,
      headers: customHeaders,
    });

    if (!messageId)
      throw new Error("SES returned no message ID; delivery outcome unknown");
    logger.info(
      { emailId: email.id, sesEmailId: messageId },
      `[EmailQueueService]: Email sent`,
    );

    // Delete attachments and headers after sending the email
    await db.email.update({
      where: { id: email.id },
      data: { sesEmailId: messageId, text, attachments: null, headers: null },
    });
    await db.emailEvent.update({
      where: { id: dispatchId },
      data: { data: { dispatchState: "accepted", sesEmailId: messageId } },
    });
  } catch (error: unknown) {
    if (error instanceof DelayedError) throw error;
    if (
      !dispatchId &&
      !(error instanceof UnrecoverableError) &&
      !(error instanceof SyntaxError) &&
      job.attemptsMade + 1 < SEND_ATTEMPTS
    )
      throw error;
    if (dispatchId && isExplicitSesThrottle(error)) {
      await db.emailEvent.update({
        where: { id: dispatchId },
        data: {
          data: {
            dispatchState: "rejected",
            reason: "SES throttled the request",
          },
        },
      });
      if (job.attemptsMade + 1 < SEND_ATTEMPTS) throw error;
    }
    const httpStatus = (error as { $metadata?: { httpStatusCode?: number } })
      ?.$metadata?.httpStatusCode;
    const rejectedBySes =
      requestStarted &&
      httpStatus !== undefined &&
      httpStatus >= 400 &&
      httpStatus < 500;
    if (dispatchId && rejectedBySes && !isExplicitSesThrottle(error)) {
      await db.emailEvent.update({
        where: { id: dispatchId },
        data: {
          data: {
            dispatchState: "rejected",
            reason:
              error instanceof Error
                ? error.message
                : "SES rejected the request",
          },
        },
      });
    }
    const reason =
      requestStarted && !rejectedBySes
        ? "Send did not complete cleanly; reconcile SES events before resending (delivery outcome may be unknown)"
        : error instanceof Error
          ? error.message
          : "Email dispatch failed";
    logger.error(
      { err: error, emailId: email.id },
      "Email dispatch requires attention",
    );
    await db.emailEvent.create({
      data: {
        emailId: email.id,
        status: "FAILED",
        data: {
          error: reason,
        },
        teamId: email.teamId,
      },
    });
    // A concurrent SES callback is stronger evidence than a local error.
    const failed = await db.email.updateMany({
      where: {
        id: email.id,
        sesEmailId: null,
        latestStatus: { in: ["QUEUED", "SCHEDULED"] },
      },
      data: { latestStatus: "FAILED" },
    });
    if (failed.count) {
      let dispatchKey: string | undefined;
      try {
        dispatchKey = email.headers
          ? JSON.parse(email.headers)["X-Anthem-Dispatch-Key"]
          : undefined;
      } catch {
        /* Invalid headers are already recorded as a dispatch failure. */
      }
      await WebhookService.emit(
        email.teamId,
        "email.failed",
        {
          id: email.id,
          status: "FAILED",
          from: email.from,
          to: email.to,
          subject: email.subject,
          occurredAt: new Date().toISOString(),
          failed: { reason },
          ...(dispatchKey && /^[a-f0-9]{64}$/.test(dispatchKey)
            ? { metadata: { anthemDispatchKey: dispatchKey } }
            : {}),
        },
        { domainId: email.domainId },
      );
    }
    throw new UnrecoverableError(reason);
  }
}
