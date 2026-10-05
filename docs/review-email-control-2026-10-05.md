# Email reliability review — October 5, 2026

Scope: transport changes relative to upstream `bcf7e07e92b11f00fade54ff9a636ca7b5416b0c`, public API compatibility, worker concurrency, partial failures, callback authentication, and release isolation. This is a direct source and test review. No production writes or real sends were performed. Following explicit staging authorization, migrations and container validation ran against disposable CI services.

## Confirmed findings repaired

| Trigger | Evidence and repair | Regression evidence |
| --- | --- | --- |
| A send completes after an API response is lost or the Redis cache disappears. | `apps/web/src/server/service/idempotency-service.ts:89`: a team-scoped PostgreSQL request fence persists the payload hash and completed IDs. An uncertain request stays fenced. | Nine idempotency unit tests; seven PostgreSQL reliability cases passed against disposable PostgreSQL. |
| Two workers execute a stalled job, or a worker crashes after SES accepts. | `apps/web/src/server/service/email-dispatch.ts:8`: lock the email row and persist the claim before sending. `email-queue-service.ts:464`: uncertain outcomes cannot automatically resend. | Three claim tests and worker uncertainty/throttling cases. Real PostgreSQL row-lock validation passed. |
| Transactional and marketing workers across replicas exceed SES's recipient quota. | `apps/web/src/server/service/ses-send-budget.ts:6` and `email-queue-service.ts:453`: one atomic regional rolling budget counts To, CC, and BCC. | Three real-Redis cases, including 40 concurrent contenders and rolling expiry. |
| One batch destination fails after another queue already accepted its group. | `apps/web/src/server/service/email-queue-service.ts:168`: validate destinations first and inspect all settled writes. Preserve already accepted email rows for reconciliation. | Worker/queue tests assert partial errors propagate rather than returning success or cancelling unrelated accepted work. |
| A transient pre-send failure is swallowed, or an SDK retry duplicates a non-idempotent SES call. | `apps/web/src/server/service/email-queue-service.ts:505` and `apps/web/src/server/aws/ses.ts`: bounded retries only before dispatch or after an explicit SES throttle; SDK send attempts set to one. | Fifteen worker tests cover retry exhaustion, configuration errors, delayed jobs, failure reasons, accepted/cancelled jobs, and callback races. |
| An attacker posts a forged SES callback or certificate URL. | `apps/web/src/server/aws/verify-sns.ts:36` and `apps/web/src/app/api/ses_callback/route.ts:13`: signature verification, topic allowlist, certificate URL restrictions, bounded bodies, AWS subscription confirmation, and retryable infrastructure failures. | Real RSA signature fixtures, trust-boundary/cache tests, and five callback route cases. |
| A provider callback arrives after a local uncertain failure, or its API response was lost. | `apps/web/src/server/service/ses-hook-parser.ts:117`: authenticated provider evidence can resolve local failure; preserve actual event time and opaque dispatch correlation. | Parser tests cover event timestamp and correlation; Anthem covers the corresponding ledger race. |
| Async request context leaks into a long-lived worker initialized by an API request. | `apps/web/src/server/service/email-service.ts:143`: pass the server-owned request ID explicitly into each email creation instead of using ambient async context. | Single and batch API tests reject client-controlled request linkage. |

## Validation completed

From `apps/web` with the installed workspace dependencies:

```sh
bun x prisma generate
bun run typecheck
bun x vitest run --config vitest.unit.config.ts
bun x vitest run --config vitest.api.config.ts
bun x vitest run --config vitest.trpc.config.ts
RUN_EMAIL_REDIS_TESTS=true bun x vitest run --config vitest.config.ts src/server/service/ses-send-budget.integration.test.ts
```

- Unit: 177 passing tests across 27 files. The explicit request-ID review change was followed by the nine focused idempotency cases.
- Public API: 22 passing tests across seven files.
- tRPC: 10 passing tests across four files.
- Real Redis: three passing tests against isolated local Redis with random test keys.
- TypeScript: passed, including the prepared PostgreSQL integration cases.
- Whitespace validation: `git diff --check` passed.

## Accepted limits and release gates

No unresolved confirmed defect remains in the reviewed implementation. This is ready for draft review, not production activation.

- An ambiguous send requires reconciliation. There is no automatic repair, historical replay, or claim of exactly-once delivery.
- A single message exceeding the configured regional recipient budget fails visibly; changing the quota must respect AWS's verified account limit.
- The existing provider webhook emission mechanism can still fail separately from persisting the SES event. Cherry's read-only live lookup supplies diagnostic evidence; a transactional webhook outbox is a separate future change.
- Certificate caching is bounded to 32 entries and one hour. Simultaneous cold cache misses can fetch the same certificate more than once; requests remain timeout/body bounded. Request coalescing can be added if measurements warrant it.
- Additive migration and PostgreSQL concurrency/recovery tests **passed** after explicit staging authorization. The manual workflow uses disposable PostgreSQL and Redis services.
- Container build/publish, migrations through the image CLI, migration-status startup, readiness with exact commit identity, liveness, and unsigned-callback rejection **passed**. Valid signed callbacks are covered by unit/API tests; a real AWS callback and SES send are still required during an approved canary.
- Production activation needs a pinned image digest, approved migration/configuration operations, a canary recipient, and quiesced old workers. Mixed old/new versions do not share the new request and dispatch safeguards.
- Existing Reply-To mailboxes continue to receive replies. A shared inbound Cherry inbox remains separate work.

See [the activation and rollback runbook](anthem-email-control.md).

## Authorized staging validation

[Workflow 37324462092](https://github.com/itisyb/anthem-usesend/actions/runs/37324462092) passed on source commit `d1b072ae4e1bee111157332c3d32d499050e0881`.

- TypeScript; 177 unit, 10 tRPC, 22 API, 18 integration, and three real-Redis tests passed (230 total). Three Redis cases are skipped in the general integration job and run explicitly in the real-Redis step.
- All Prisma migrations applied to disposable PostgreSQL, including `20261005120000_durable_email_requests`; seven reliability cases exercise database idempotency and dispatch claims.
- Published Linux AMD64 image: `ghcr.io/itisyb/anthem-usesend:d1b072ae4e1bee111157332c3d32d499050e0881`.
- Verified digest: `sha256:dd242efa83e33d5c97148bd3b24ec7310d91803aa430191adabe85f8ab38babf`.
- The image was pulled by digest and booted against new disposable PostgreSQL/Redis containers. Readiness checked the migrated database, Redis, and exact source commit; liveness and unsigned-callback rejection passed.
- The preceding smoke run caught a missing Prisma runtime dependency (`@prisma/engines`). `docker/copy-prisma-runtime.cjs` now copies the installed dependency closure, preserving the lockfile-resolved versions. The corrected image passed the same previously failing smoke test. Images from earlier runs are not staging candidates.
- No Railway deployment, production migration/configuration change, real send, AWS ingress creation, or DNS/MX change occurred. This validates the provider artifact; it does not validate the separate Cherry inbox or an end-to-end AWS delivery/reply flow.
