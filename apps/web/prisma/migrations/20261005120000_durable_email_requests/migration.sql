-- Additive only. Apply explicitly before starting the Anthem fork workers.
CREATE TABLE "EmailRequest" (
  "id" TEXT NOT NULL,
  "teamId" INTEGER NOT NULL,
  "keyHash" TEXT NOT NULL,
  "bodyHash" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PROCESSING',
  "emailIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "EmailRequest_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "EmailRequest_teamId_keyHash_key" ON "EmailRequest"("teamId", "keyHash");
ALTER TABLE "Email" ADD COLUMN "requestId" TEXT;
CREATE INDEX "Email_requestId_idx" ON "Email"("requestId");
ALTER TABLE "Email" ADD CONSTRAINT "Email_requestId_fkey"
  FOREIGN KEY ("requestId") REFERENCES "EmailRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;
