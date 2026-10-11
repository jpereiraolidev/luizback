-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('COUPLE_INVITE');

-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'CANCELLED');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "coupleId" TEXT,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "couples" (
    "id" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT 'pink',
    "theme" TEXT NOT NULL DEFAULT 'dark',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ownerId" TEXT NOT NULL,

    CONSTRAINT "couples_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dependents" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "birthDate" DATE,
    "avatar" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "coupleId" TEXT NOT NULL,

    CONSTRAINT "dependents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "type" "NotificationType" NOT NULL,
    "status" "NotificationStatus" NOT NULL DEFAULT 'PENDING',
    "fromId" TEXT NOT NULL,
    "toId" TEXT NOT NULL,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "water" (
    "id" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "reason" TEXT,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "date" DATE NOT NULL,
    "dependentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "water_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pee" (
    "id" TEXT NOT NULL,
    "size" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "note" TEXT,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "date" DATE NOT NULL,
    "dependentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "poop" (
    "id" TEXT NOT NULL,
    "evacuated" BOOLEAN NOT NULL,
    "consistency" TEXT,
    "pain" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "date" DATE NOT NULL,
    "dependentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "poop_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "behavior" (
    "id" TEXT NOT NULL,
    "observed" TEXT NOT NULL,
    "rule" TEXT,
    "action" TEXT,
    "duration" INTEGER,
    "result" TEXT,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "date" DATE NOT NULL,
    "dependentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "behavior_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "couple_task" (
    "id" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "owner" TEXT,
    "priority" TEXT NOT NULL DEFAULT 'media',
    "due" TEXT,
    "note" TEXT,
    "done" BOOLEAN NOT NULL DEFAULT false,
    "doneAt" TIMESTAMP(3),
    "coupleId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "couple_task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "couple_data" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "coupleId" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "couple_data_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "dependents_coupleId_idx" ON "dependents"("coupleId");

-- CreateIndex
CREATE INDEX "notifications_toId_status_idx" ON "notifications"("toId", "status");

-- CreateIndex
CREATE INDEX "notifications_fromId_idx" ON "notifications"("fromId");

-- CreateIndex
CREATE INDEX "water_dependentId_date_idx" ON "water"("dependentId", "date");

-- CreateIndex
CREATE INDEX "pee_dependentId_date_idx" ON "pee"("dependentId", "date");

-- CreateIndex
CREATE INDEX "poop_dependentId_date_idx" ON "poop"("dependentId", "date");

-- CreateIndex
CREATE INDEX "behavior_dependentId_date_idx" ON "behavior"("dependentId", "date");

-- CreateIndex
CREATE INDEX "couple_task_coupleId_done_idx" ON "couple_task"("coupleId", "done");

-- CreateIndex
CREATE UNIQUE INDEX "couple_data_coupleId_key_key" ON "couple_data"("coupleId", "key");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_coupleId_fkey" FOREIGN KEY ("coupleId") REFERENCES "couples"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "couples" ADD CONSTRAINT "couples_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dependents" ADD CONSTRAINT "dependents_coupleId_fkey" FOREIGN KEY ("coupleId") REFERENCES "couples"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_fromId_fkey" FOREIGN KEY ("fromId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_toId_fkey" FOREIGN KEY ("toId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "water" ADD CONSTRAINT "water_dependentId_fkey" FOREIGN KEY ("dependentId") REFERENCES "dependents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pee" ADD CONSTRAINT "pee_dependentId_fkey" FOREIGN KEY ("dependentId") REFERENCES "dependents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "poop" ADD CONSTRAINT "poop_dependentId_fkey" FOREIGN KEY ("dependentId") REFERENCES "dependents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "behavior" ADD CONSTRAINT "behavior_dependentId_fkey" FOREIGN KEY ("dependentId") REFERENCES "dependents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "couple_task" ADD CONSTRAINT "couple_task_coupleId_fkey" FOREIGN KEY ("coupleId") REFERENCES "couples"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "couple_data" ADD CONSTRAINT "couple_data_coupleId_fkey" FOREIGN KEY ("coupleId") REFERENCES "couples"("id") ON DELETE CASCADE ON UPDATE CASCADE;
