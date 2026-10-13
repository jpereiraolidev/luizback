// ============================================================
// config.js — variáveis de ambiente, constantes, Prisma singleton
// ------------------------------------------------------------
// 🔴 MUDOU: singleton do Prisma SEMPRE guardado em globalThis.
// ✅ NOVO:  instrumentação do Prisma + hooks globais.
// ============================================================

import { PrismaClient } from "@prisma/client";
import { instrumentPrisma, installGlobalHooks, log } from "./registerlogs.js";

export const ENV = {
  DATABASE_URL: process.env.DATABASE_URL,
  JWT_SECRET: process.env.JWT_SECRET || "dev-secret-troque-em-prod",
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || "30d",
  NODE_ENV: process.env.NODE_ENV || "development",
  PORT: process.env.PORT || 3000,
};

if (!ENV.DATABASE_URL) {
  console.error("❌ DATABASE_URL não definida");
}
if (ENV.NODE_ENV === "production" && ENV.JWT_SECRET === "dev-secret-troque-em-prod") {
  console.error("⚠️  JWT_SECRET não definida em produção!");
}

// 🔴 CORREÇÃO H1: SEMPRE guarda em globalThis (inclusive em produção)
const globalForPrisma = globalThis;

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: [
      { emit: "event", level: "error" },
      { emit: "event", level: "warn" },
    ],
    datasources: { db: { url: process.env.DATABASE_URL } },
  });

if (!globalForPrisma.__promax_prisma_instrumented) {
  globalForPrisma.__promax_prisma_instrumented = true;
  globalForPrisma.prisma = prisma;
  instrumentPrisma(prisma);
  installGlobalHooks();

  log.info("config.prisma.ready", {
    nodeVersion: process.version,
    env: ENV.NODE_ENV,
    region: process.env.VERCEL_REGION || null,
    hasPooler: /pooled|pooler|pgbouncer/i.test(ENV.DATABASE_URL || ""),
    isProduction: ENV.NODE_ENV === "production",
  });
}

export const CASAL_DATA_KEYS = ["mimos", "planos", "metas", "checkins"];
export const PRIORITIES = ["baixa", "media", "alta"];
export const PEE_SIZES = ["pequeno", "medio", "grande"];
export const PEE_TYPES = ["espontaneo", "acidente"];

export const NOTIF_TYPE = { COUPLE_INVITE: "COUPLE_INVITE" };
export const NOTIF_STATUS = {
  PENDING: "PENDING",
  ACCEPTED: "ACCEPTED",
  REJECTED: "REJECTED",
  CANCELLED: "CANCELLED",
};

export const RECORD_STATUS = {
  ACTIVE: "active",
  LEGACY: "legacy",
  ARCHIVED: "archived",
};

export const INVITE_LINK = {
  DEFAULT_EXPIRES_HOURS: 24,
  MAX_EXPIRES_HOURS: 168,
  DEFAULT_MAX_USES: 1,
  MAX_MAX_USES: 2,
  TOKEN_BYTES: 16,
};

export const FIELD_TYPES = ["string", "number", "boolean", "date", "text", "select"];

export const HTTP = {
  OK: 200, CREATED: 201, NO_CONTENT: 204,
  BAD_REQUEST: 400, UNAUTHORIZED: 401, FORBIDDEN: 403,
  NOT_FOUND: 404, CONFLICT: 409, UNPROCESSABLE: 422,
  INTERNAL: 500, UNAVAILABLE: 503,
};