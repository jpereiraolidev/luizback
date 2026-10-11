// ============================================================
// config.js — variáveis de ambiente, constantes, Prisma singleton
// ============================================================
import { PrismaClient } from "@prisma/client";

// ---------- ENV ----------
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

// ---------- PRISMA SINGLETON (evita esgotar pool na Vercel) ----------
const globalForPrisma = globalThis;

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: ENV.NODE_ENV === "development" ? ["query", "error", "warn"] : ["error"],
  });

if (ENV.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

// ---------- CONSTANTES DE DOMÍNIO ----------
export const CASAL_DATA_KEYS = ["mimos", "planos", "metas", "checkins"];

export const PRIORITIES = ["baixa", "media", "alta"];
export const PEE_SIZES = ["pequeno", "medio", "grande"];
export const PEE_TYPES = ["espontaneo", "acidente"];

export const NOTIF_TYPE = {
  COUPLE_INVITE: "COUPLE_INVITE",
};
export const NOTIF_STATUS = {
  PENDING: "PENDING",
  ACCEPTED: "ACCEPTED",
  REJECTED: "REJECTED",
  CANCELLED: "CANCELLED",
};

export const HTTP = {
  OK: 200,
  CREATED: 201,
  NO_CONTENT: 204,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  UNPROCESSABLE: 422,
  INTERNAL: 500,
};