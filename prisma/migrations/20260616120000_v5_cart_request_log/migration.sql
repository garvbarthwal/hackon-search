-- v5: per-API-request audit log
--
-- One row per incoming /v1/cart/plan or /v1/cart/chat call. Stores the full
-- frozen CartResponse payload so GET /v1/cart/status/:requestId can replay
-- it without re-running the pipeline.
CREATE TABLE "CartRequestLog" (
    "requestId" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "queryType" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "coverage" DOUBLE PRECISION NOT NULL,
    "sessionId" TEXT,
    "response" JSONB NOT NULL,
    "latencyMs" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CartRequestLog_pkey" PRIMARY KEY ("requestId")
);

CREATE INDEX "CartRequestLog_sessionId_idx" ON "CartRequestLog"("sessionId");
CREATE INDEX "CartRequestLog_createdAt_idx" ON "CartRequestLog"("createdAt");
