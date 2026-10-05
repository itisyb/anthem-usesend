# Email reliability review — October 5, 2026

Scope: transport changes relative to upstream `bcf7e07e92b11f00fade54ff9a636ca7b5416b0c`, public API compatibility, worker concurrency, partial failures, callback authentication, and release isolation. This is a direct source and test review. No production writes, real sends, database migration, or container build were performed.

## Confirmed findings repaired

| Trigger | Evidence and repair | Regression evidence |
| --- | --- | --- |
| A send completes after an API response is lost or the Redis cache disappears. | `apps/web/src/server/service/idempotency-service.ts:89`: a team-scoped PostgreSQL request fence persists the payload hash and completed IDs. An uncertain request stays fenced. | Nine idempotency unit tests; seven additional PostgreSQL reliability cases are prepared for the migration gate. |
| Two workers execute a stalled job, or a worker crashes after SES accepts. | `apps/web/src/server/service/email-dispatch.ts:8`: lock the email row and persist the claim before sending. `email-queue-service.ts:464`: uncertain outcomes cannot automatically resend. | Three claim tests and worker uncertainty/throttling cases. Real PostgreSQL row-lock validation remains pending. |
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
- Additive migration and real PostgreSQL concurrency tests are prepared but **not run**. AGENTS.md explicitly requires a request before migration/build commands. The manual integration workflow targets disposable local CI services.
- Container build, migration-status startup, readiness in the built image, and signed-callback container smoke tests are **not verified**. Docker is unavailable in this workspace; the manual image workflow is prepared.
- Production activation needs a pinned image digest, approved migration/configuration operations, a canary recipient, and quiesced old workers. Mixed old/new versions do not share the new request and dispatch safeguards.
- Existing Reply-To mailboxes continue to receive replies. A shared inbound Cherry inbox remains separate work.

See [the activation and rollback runbook](anthem-email-control.md).
