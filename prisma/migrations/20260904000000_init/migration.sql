-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Plan" AS ENUM ('FREE', 'STARTER', 'GROWTH', 'PRO');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('ACTIVE', 'PENDING', 'CANCELLED', 'EXPIRED', 'DECLINED', 'FROZEN');

-- CreateEnum
CREATE TYPE "RuleStatus" AS ENUM ('DRAFT', 'ACTIVE', 'DISABLED', 'ARCHIVED', 'ERROR', 'NEEDS_ATTENTION');

-- CreateEnum
CREATE TYPE "RuleType" AS ENUM ('PRODUCT_QUANTITY', 'CART_QUANTITY', 'CART_VALUE', 'PRODUCT_COMBINATION', 'REQUIRED_PRODUCT', 'COLLECTION_QUANTITY', 'CUSTOMER', 'MARKET', 'COMPOSITE');

-- CreateEnum
CREATE TYPE "ConflictSeverity" AS ENUM ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO');

-- CreateEnum
CREATE TYPE "ConflictStatus" AS ENUM ('OPEN', 'IGNORED', 'RESOLVED');

-- CreateEnum
CREATE TYPE "FunctionConfigStatus" AS ENUM ('PENDING', 'PUBLISHED', 'FAILED', 'ROLLED_BACK');

-- CreateEnum
CREATE TYPE "AIRequestStatus" AS ENUM ('SUCCESS', 'INVALID_OUTPUT', 'NEEDS_CLARIFICATION', 'PROVIDER_ERROR', 'RATE_LIMITED', 'TIMEOUT');

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,
    "refreshToken" TEXT,
    "refreshTokenExpires" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Shop" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "name" TEXT,
    "email" TEXT,
    "countryCode" TEXT,
    "currencyCode" TEXT,
    "timezone" TEXT,
    "planDisplayName" TEXT,
    "installedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uninstalledAt" TIMESTAMP(3),
    "onboardingStep" INTEGER NOT NULL DEFAULT 0,
    "onboardingDone" BOOLEAN NOT NULL DEFAULT false,
    "businessType" TEXT,
    "primaryProblem" TEXT,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Shop_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Subscription" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "plan" "Plan" NOT NULL DEFAULT 'FREE',
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'ACTIVE',
    "shopifySubscriptionId" TEXT,
    "test" BOOLEAN NOT NULL DEFAULT false,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "renewedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Rule" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "type" "RuleType" NOT NULL,
    "status" "RuleStatus" NOT NULL DEFAULT 'DRAFT',
    "priority" INTEGER NOT NULL DEFAULT 50,
    "definition" JSONB NOT NULL,
    "message" TEXT NOT NULL,
    "warningConfig" JSONB NOT NULL DEFAULT '{}',
    "attentionReason" TEXT,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3),
    "activatedAt" TIMESTAMP(3),

    CONSTRAINT "Rule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RuleVersion" (
    "id" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "configuration" JSONB NOT NULL,
    "note" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RuleVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Simulation" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "name" TEXT,
    "scenario" JSONB NOT NULL,
    "result" JSONB NOT NULL,
    "outcome" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Simulation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Conflict" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "relatedRuleId" TEXT,
    "fingerprint" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "severity" "ConflictSeverity" NOT NULL,
    "confidence" TEXT NOT NULL,
    "explanation" TEXT NOT NULL,
    "scenario" JSONB,
    "suggestedFix" TEXT,
    "status" "ConflictStatus" NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "Conflict_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActivityLog" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "ruleId" TEXT,
    "eventType" TEXT NOT NULL,
    "actor" TEXT,
    "summary" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActivityLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UsageMetric" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "ruleChecks" INTEGER NOT NULL DEFAULT 0,
    "warnings" INTEGER NOT NULL DEFAULT 0,
    "failures" INTEGER NOT NULL DEFAULT 0,
    "blocks" INTEGER NOT NULL DEFAULT 0,
    "simulations" INTEGER NOT NULL DEFAULT 0,
    "aiRequests" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "UsageMetric_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RuleDailyStat" (
    "id" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "checks" INTEGER NOT NULL DEFAULT 0,
    "passed" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "warnings" INTEGER NOT NULL DEFAULT 0,
    "blocks" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "RuleDailyStat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FunctionConfiguration" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "checksum" TEXT NOT NULL,
    "configuration" JSONB NOT NULL,
    "byteSize" INTEGER NOT NULL DEFAULT 0,
    "status" "FunctionConfigStatus" NOT NULL DEFAULT 'PENDING',
    "validationGid" TEXT,
    "publishedAt" TIMESTAMP(3),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FunctionConfiguration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AIRequest" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "requestType" TEXT NOT NULL,
    "status" "AIRequestStatus" NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "response" JSONB,
    "errorCode" TEXT,
    "latencyMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AIRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'INFO',
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "actionUrl" TEXT,
    "dedupeKey" TEXT NOT NULL,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Session_shop_idx" ON "Session"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "Shop_shopDomain_key" ON "Shop"("shopDomain");

-- CreateIndex
CREATE INDEX "Shop_uninstalledAt_idx" ON "Shop"("uninstalledAt");

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_shopId_key" ON "Subscription"("shopId");

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_shopifySubscriptionId_key" ON "Subscription"("shopifySubscriptionId");

-- CreateIndex
CREATE INDEX "Subscription_status_idx" ON "Subscription"("status");

-- CreateIndex
CREATE INDEX "Rule_shopId_status_idx" ON "Rule"("shopId", "status");

-- CreateIndex
CREATE INDEX "Rule_shopId_type_idx" ON "Rule"("shopId", "type");

-- CreateIndex
CREATE INDEX "Rule_shopId_updatedAt_idx" ON "Rule"("shopId", "updatedAt");

-- CreateIndex
CREATE INDEX "RuleVersion_ruleId_createdAt_idx" ON "RuleVersion"("ruleId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "RuleVersion_ruleId_version_key" ON "RuleVersion"("ruleId", "version");

-- CreateIndex
CREATE INDEX "Simulation_shopId_createdAt_idx" ON "Simulation"("shopId", "createdAt");

-- CreateIndex
CREATE INDEX "Conflict_shopId_status_severity_idx" ON "Conflict"("shopId", "status", "severity");

-- CreateIndex
CREATE UNIQUE INDEX "Conflict_shopId_fingerprint_key" ON "Conflict"("shopId", "fingerprint");

-- CreateIndex
CREATE INDEX "ActivityLog_shopId_createdAt_idx" ON "ActivityLog"("shopId", "createdAt");

-- CreateIndex
CREATE INDEX "ActivityLog_shopId_eventType_idx" ON "ActivityLog"("shopId", "eventType");

-- CreateIndex
CREATE INDEX "UsageMetric_shopId_date_idx" ON "UsageMetric"("shopId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "UsageMetric_shopId_date_key" ON "UsageMetric"("shopId", "date");

-- CreateIndex
CREATE INDEX "RuleDailyStat_ruleId_date_idx" ON "RuleDailyStat"("ruleId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "RuleDailyStat_ruleId_date_key" ON "RuleDailyStat"("ruleId", "date");

-- CreateIndex
CREATE INDEX "FunctionConfiguration_shopId_status_idx" ON "FunctionConfiguration"("shopId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "FunctionConfiguration_shopId_version_key" ON "FunctionConfiguration"("shopId", "version");

-- CreateIndex
CREATE INDEX "AIRequest_shopId_createdAt_idx" ON "AIRequest"("shopId", "createdAt");

-- CreateIndex
CREATE INDEX "Notification_shopId_readAt_idx" ON "Notification"("shopId", "readAt");

-- CreateIndex
CREATE UNIQUE INDEX "Notification_shopId_dedupeKey_key" ON "Notification"("shopId", "dedupeKey");

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Rule" ADD CONSTRAINT "Rule_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RuleVersion" ADD CONSTRAINT "RuleVersion_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "Rule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Simulation" ADD CONSTRAINT "Simulation_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conflict" ADD CONSTRAINT "Conflict_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conflict" ADD CONSTRAINT "Conflict_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "Rule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conflict" ADD CONSTRAINT "Conflict_relatedRuleId_fkey" FOREIGN KEY ("relatedRuleId") REFERENCES "Rule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityLog" ADD CONSTRAINT "ActivityLog_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityLog" ADD CONSTRAINT "ActivityLog_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "Rule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsageMetric" ADD CONSTRAINT "UsageMetric_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RuleDailyStat" ADD CONSTRAINT "RuleDailyStat_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "Rule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FunctionConfiguration" ADD CONSTRAINT "FunctionConfiguration_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AIRequest" ADD CONSTRAINT "AIRequest_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

