# Anthem email control: first release

This fork starts from upstream `bcf7e07e92b11f00fade54ff9a636ca7b5416b0c` and keeps the existing REST API, dashboard, sending domains, suppression handling, and Reply-To routing. Cherry supplies the application delivery history. A shared inbound inbox is a separate implementation; this release does not receive, store, or display customer replies.

## Why these changes

A read-only deployment audit found that the existing delivery webhook subscribed only to bounces. This establishes a visibility gap, not proof that every reported missing message came from a queue failure. Operational counts and deployment identifiers remain outside this public repository.

Source review confirmed swallowed bulk queue errors, no recipient-aware rate limiter, failures swallowed by the sending worker, Redis-only API idempotency, and SNS callbacks authenticated only by topic name. The fork fixes those paths. It does not claim that SES acceptance guarantees inbox placement.

## Behavior

- PostgreSQL `EmailRequest` records fence idempotency keys per team. The email row references the request in its creation write. A repeated completed request returns its original IDs; an interrupted request requires reconciliation. Keep the original key. Do not automatically delete these records or retry with a new key.
- Existing Redis results are honored during cutover. New completed results also populate the legacy cache for a controlled rollback.
- A transaction locks the email row and records a dispatch claim before contacting SES. An unresolved claim prevents a stalled worker from sending the message twice. This favors avoiding duplicate customer mail over automatically recovering every uncertain send.
- Both queue types and every replica share a rolling, regional Redis budget. To, CC, and BCC count against the same budget. The configured quota must remain within the SES account's limit. A message with more recipients than the configured per-second budget fails visibly; split it deliberately or change the setting within the verified AWS quota.
- Pre-dispatch infrastructure failures and explicit SES 429 throttling receive at most six worker attempts. SDK retries are disabled for the non-idempotent SES send itself. Uncertain outcomes and permanent rejections require attention.
- Authenticated SES evidence can resolve a locally failed/uncertain send. SNS signatures v1/v2 use a bounded certificate cache, exact regional HTTPS certificate hosts, a 30-day replay window, and retained queue IDs. Callback queue failures return 503. Subscription confirmation uses the AWS API rather than a supplied URL.
- `/api/health` remains the upstream liveness response. `/api/ready` checks the migrated database and Redis and exposes the built commit SHA.

## Verification and remaining release gates

Run the focused tests and the upstream unit, API, and tRPC suites. The recipient budget has an additional real-Redis test using only `127.0.0.1:16379` and random test keys:

```sh
cd apps/web
bun x prisma generate
bun x tsc --noEmit --pretty false
bun x vitest run --config vitest.unit.config.ts
bun x vitest run --config vitest.api.config.ts
bun x vitest run --config vitest.trpc.config.ts
RUN_EMAIL_REDIS_TESTS=true bun x vitest run --config vitest.config.ts src/server/service/ses-send-budget.integration.test.ts
```

The additive PostgreSQL migration is `20261005120000_durable_email_requests`: one request table, one nullable email reference, and indexes. It has been prepared, not applied. Per this repository's AGENTS.md, running migrations and builds requires an explicit request. The database integration workflow is therefore manual with `database_integration=true`. It uses disposable CI PostgreSQL; its reset helper rejects nonlocal databases and Redis databases other than local test DB 15.

Before production, explicitly authorize and complete the disposable database migration/integration suite and the container build. Inspect the generated image, run `/api/ready`, and exercise signed callbacks with local fixtures. Do not use production databases, queues, API keys, or mail recipients for staging.

## Production activation

1. Complete the Anthem application's release workflow for the reviewed email changes. Its schema and `/webhooks/email/delivery` endpoint must be live before changing subscriptions. Do not include unrelated `dev` commits without their owner's approval.
2. Approve the exact service, commit SHA, image digest, additive migration, and webhook configuration change. Publish with the manual `Publish Anthem email image` workflow; deploy the resulting `ghcr.io/itisyb/anthem-usesend` digest, never a floating `latest` tag.
3. Inspect backups and record the existing active image digest, region settings, queue counts, and webhook configuration in the access-controlled operations workspace. Do not commit customer/provider row exports or secrets.
4. Quiesce outbound producers and stop the old workers before the new workers start. Do not overlap old and new sending versions against the same queues: the old API does not honor PostgreSQL fences and the old worker does not share the new rate budget. Account for scheduled work and in-flight requests.
5. Apply the additive migration as an approved release step. The container's default startup checks migration status and refuses to serve with unapplied migrations. `RUN_DATABASE_MIGRATIONS=true` explicitly enables migration execution; return it to false after the approved apply.
6. Configure readiness against `/api/ready`; verify both readiness and liveness, the exact built commit, database accessibility, Redis, SES settings, and SNS callback permissions. Use the verified sending domain's region; do not silently substitute a legacy default-region variable.
7. Update the existing bounce subscription to the Anthem `/webhooks/email/delivery` endpoint and all 13 email events: queued, sent, delivery_delayed, delivered, bounced, rejected, rendering_failure, complained, failed, cancelled, suppressed, opened, clicked. Preserve its signing secret; this endpoint uses the same configured verification secret as the existing bounce handler. Leave the contact subscription in place. This production configuration write requires its own approved dry run and confirmation.
8. After an explicitly approved canary recipient is supplied, verify one send from application intent through provider acceptance, SES delivery callback, and Cherry history; replay the same key and callback to confirm no duplicate send or event. Resume producers only after this check passes.
9. Monitor pending requests/claims, BullMQ failures, unmatched application messages, callback failures, and bounces/complaints. Cherry's live status lookup is read-only and provides a fallback for missing callbacks. No automatic historical resend/backfill is included.

## Rollback

Quiesce producers and workers again. Inspect all PROCESSING/RECONCILE requests and open dispatch claims. Do not blindly roll back to a version that ignores these fences while ambiguous sends are still outstanding. Preserve the additive tables, original keys, and event evidence. If a rollback is appropriate, use the previously recorded immutable image and verify its readiness/liveness plus callback behavior. Historical repairs and resends need a separate, recipient-scoped operation with provider evidence and explicit approval.

## Reply follow-up

Keep current mailboxes and MX records during this release. A Cherry inbox should be a separate, reviewable change: dedicated reply subdomain, opaque per-thread addresses, SES receiving into encrypted S3, bounded MIME parsing, authenticated ingestion with replay protection, staff permissions, plain-text previews, attachment isolation, and replies linked to customers/orders with durable send keys. Confirm mailbox ownership and retention requirements before activating that pipeline.

## Upstream maintenance

Keep `upstream/main` available, record each reviewed upstream SHA, and periodically review releases plus sending/security fixes. Cherry-specific business workflows belong in Anthem. This fork should remain focused on transport correctness and operational controls. Preserve upstream attribution and the AGPL license; expose source for the version being served.

AWS references: [SNS signature verification](https://docs.aws.amazon.com/sns/latest/dg/sns-verify-signature-of-message-verify-message-signature.html), [SES recipient-based sending quotas](https://docs.aws.amazon.com/ses/latest/dg/manage-sending-quotas.html).
