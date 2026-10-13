-- AlterTable
ALTER TABLE "behavior" ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'active';

-- AlterTable
ALTER TABLE "pee" ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'active';

-- AlterTable
ALTER TABLE "poop" ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'active';

-- AlterTable
ALTER TABLE "water" ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'active';

-- CreateTable
CREATE TABLE "invite_links" (
    "id" TEXT NOT NULL,
    "token" VARCHAR(64) NOT NULL,
    "coupleId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "maxUses" INTEGER NOT NULL DEFAULT 1,
    "useCount" INTEGER NOT NULL DEFAULT 0,
    "revokedAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "lastUsedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "invite_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sleep" (
    "id" TEXT NOT NULL,
    "durationMin" INTEGER NOT NULL,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3),
    "quality" TEXT,
    "note" TEXT,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "date" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "dependentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sleep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "record_types" (
    "id" TEXT NOT NULL,
    "coupleId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "icon" TEXT,
    "fields" JSONB NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "record_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "custom_records" (
    "id" TEXT NOT NULL,
    "typeId" TEXT NOT NULL,
    "dependentId" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "date" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "custom_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "requestId" TEXT,
    "level" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "method" TEXT,
    "path" TEXT,
    "status" INTEGER,
    "durationMs" INTEGER,
    "userId" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,
    "payload" JSONB,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "invite_links_token_key" ON "invite_links"("token");

-- CreateIndex
CREATE INDEX "invite_links_token_idx" ON "invite_links"("token");

-- CreateIndex
CREATE INDEX "invite_links_coupleId_revokedAt_idx" ON "invite_links"("coupleId", "revokedAt");

-- CreateIndex
CREATE INDEX "invite_links_expiresAt_idx" ON "invite_links"("expiresAt");

-- CreateIndex
CREATE INDEX "sleep_dependentId_date_idx" ON "sleep"("dependentId", "date");

-- CreateIndex
CREATE INDEX "sleep_dependentId_date_status_idx" ON "sleep"("dependentId", "date", "status");

-- CreateIndex
CREATE INDEX "record_types_coupleId_active_idx" ON "record_types"("coupleId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "record_types_coupleId_slug_key" ON "record_types"("coupleId", "slug");

-- CreateIndex
CREATE INDEX "custom_records_dependentId_date_idx" ON "custom_records"("dependentId", "date");

-- CreateIndex
CREATE INDEX "custom_records_typeId_date_idx" ON "custom_records"("typeId", "date");

-- CreateIndex
CREATE INDEX "custom_records_dependentId_date_status_idx" ON "custom_records"("dependentId", "date", "status");

-- CreateIndex
CREATE INDEX "audit_logs_createdAt_idx" ON "audit_logs"("createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_level_createdAt_idx" ON "audit_logs"("level", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_event_createdAt_idx" ON "audit_logs"("event", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_requestId_idx" ON "audit_logs"("requestId");

-- CreateIndex
CREATE INDEX "audit_logs_userId_createdAt_idx" ON "audit_logs"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_path_createdAt_idx" ON "audit_logs"("path", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_status_createdAt_idx" ON "audit_logs"("status", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_instanceId_createdAt_idx" ON "audit_logs"("instanceId", "createdAt");

-- CreateIndex
CREATE INDEX "behavior_dependentId_date_status_idx" ON "behavior"("dependentId", "date", "status");

-- CreateIndex
CREATE INDEX "notifications_fromId_toId_type_status_idx" ON "notifications"("fromId", "toId", "type", "status");

-- CreateIndex
CREATE INDEX "pee_dependentId_date_status_idx" ON "pee"("dependentId", "date", "status");

-- CreateIndex
CREATE INDEX "poop_dependentId_date_status_idx" ON "poop"("dependentId", "date", "status");

-- CreateIndex
CREATE INDEX "water_dependentId_date_status_idx" ON "water"("dependentId", "date", "status");

-- AddForeignKey
ALTER TABLE "invite_links" ADD CONSTRAINT "invite_links_coupleId_fkey" FOREIGN KEY ("coupleId") REFERENCES "couples"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invite_links" ADD CONSTRAINT "invite_links_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sleep" ADD CONSTRAINT "sleep_dependentId_fkey" FOREIGN KEY ("dependentId") REFERENCES "dependents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "record_types" ADD CONSTRAINT "record_types_coupleId_fkey" FOREIGN KEY ("coupleId") REFERENCES "couples"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custom_records" ADD CONSTRAINT "custom_records_typeId_fkey" FOREIGN KEY ("typeId") REFERENCES "record_types"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custom_records" ADD CONSTRAINT "custom_records_dependentId_fkey" FOREIGN KEY ("dependentId") REFERENCES "dependents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
