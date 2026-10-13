// ============================================================
// prisma.js — PrismaClient com retry inteligente e anti-zumbi
// ------------------------------------------------------------
// Problema real observado em produção (Vercel + pooler):
//   1. Container Vercel fica quente, mas o pooler do banco
//      coloca a conexão TCP em modo ocioso.
//   2. A próxima query trava por segundos ou estoura
//      KEEPALIVE_TIMEOUT (5002ms).
//   3. Retry simples repete o erro na mesma conexão zumbi.
//
// Solução:
//   - Singleton global (1 cliente por processo Vercel)
//   - safeQuery(): retry SOMENTE em erros de rede/conexão
//   - Entre retries: $disconnect() + $connect() → descarta
//     o socket travado e força o pooler a entregar um novo
//   - warmupDb(): SELECT 1 para acordar antes de operações
//     críticas
//   - keepAlive(): usa safeQuery → retry + reconnect
//
// Erros que NÃO fazem retry (falham na hora):
//   P2002 (unique violation), P2025 (record not found),
//   P2003 (FK violation), HttpError, validação, etc.
// ============================================================

import { PrismaClient } from "@prisma/client";
import { log } from "./registerlogs.js";

// ---------- CONFIG DE RETRY ----------
const RETRY = {
  MAX_ATTEMPTS: Number(process.env.PRISMA_RETRY_ATTEMPTS || 4),
  BASE_DELAY_MS: Number(process.env.PRISMA_RETRY_BASE_MS || 250),
  MAX_DELAY_MS: Number(process.env.PRISMA_RETRY_MAX_MS || 3000),
  JITTER_MS: Number(process.env.PRISMA_RETRY_JITTER_MS || 100),
};

// Códigos do Prisma que indicam problema de CONEXÃO (retry vale a pena)
const RETRYABLE_CODES = new Set([
  "P1001", // Can't reach database server
  "P1002", // Connection timed out
  "P1008", // Operation timed out
  "P1017", // Server has closed the connection
  "P2024", // Timed out fetching a new connection from pool
]);

// Códigos do Postgres que indicam problema de CONEXÃO
const RETRYABLE_PG = new Set([
  "08000", "08003", "08006", "08001",
  "53300",
  "57P01", "57P02", "57P03",
]);

function isRetryable(err) {
  if (!err) return false;
  if (RETRYABLE_CODES.has(err.code)) return true;
  if (RETRYABLE_PG.has(err?.meta?.code)) return true;
  if (RETRYABLE_PG.has(err?.code)) return true;
  if (err.name === "PrismaClientInitializationError") return true;
  if (/ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN/.test(err.message || "")) return true;
  if (err.message === "KEEPALIVE_TIMEOUT") return true;
  return false;
}

// ---------- SINGLETON ----------
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

globalForPrisma.prisma = prisma;

// ---------- UTILS ----------
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function backoffMs(attempt) {
  const base = Math.min(
    RETRY.BASE_DELAY_MS * Math.pow(2, attempt - 1),
    RETRY.MAX_DELAY_MS
  );
  const jitter = Math.random() * RETRY.JITTER_MS;
  return Math.round(base + jitter);
}

// ---------- ANTI-ZUMBI ----------
let reconnecting = false;
async function reconnect(reason) {
  if (reconnecting) return;
  reconnecting = true;
  const t0 = Date.now();
  try {
    await prisma.$disconnect().catch(() => {});
    await prisma.$connect();
    log.info("prisma.reconnect", {
      reason,
      durationMs: Date.now() - t0,
    });
  } catch (e) {
    log.error("prisma.reconnect.failed", {
      reason,
      message: e.message?.slice(0, 200),
      durationMs: Date.now() - t0,
    });
    throw e;
  } finally {
    reconnecting = false;
  }
}

// ---------- SAFE QUERY ----------
export async function safeQuery(fn, { label = "query", attempts = RETRY.MAX_ATTEMPTS } = {}) {
  let lastErr = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const result = await fn(prisma);
      if (attempt > 1) {
        log.info("prisma.retry.success", { label, attempt });
      }
      return result;
    } catch (err) {
      lastErr = err;

      if (!isRetryable(err)) {
        throw err;
      }

      if (attempt === attempts) {
        log.error("prisma.retry.exhausted", {
          label,
          attempts,
          code: err.code,
          message: err.message?.slice(0, 200),
        });
        throw err;
      }

      const delay = backoffMs(attempt);
      log.warn("prisma.retry", {
        label,
        attempt,
        delayMs: delay,
        code: err.code,
        message: err.message?.slice(0, 150),
      });

      await reconnect(`retry-${label}-attempt-${attempt}`);
      await sleep(delay);
    }
  }

  throw lastErr;
}

// ---------- WARMUP ----------
export async function warmupDb() {
  const t0 = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    const ms = Date.now() - t0;
    if (ms > 2000) {
      log.warn("prisma.warmup.slow", { durationMs: ms });
    } else {
      log.debug("prisma.warmup.ok", { durationMs: ms });
    }
    return { ok: true, latencyMs: ms };
  } catch (e) {
    const ms = Date.now() - t0;
    log.error("prisma.warmup.failed", { durationMs: ms, message: e.message?.slice(0, 200) });
    return { ok: false, latencyMs: ms, error: e.code || e.name, message: e.message };
  }
}

// ---------- SAFE TRANSACTION ----------
export async function safeTransaction(fn, options = {}) {
  const { label = "transaction", ...txOpts } = options;
  return safeQuery(
    (prisma) => prisma.$transaction(fn, txOpts),
    { label }
  );
}

// ============================================================
// KEEPALIVE (com retry + reconnect)
// ============================================================
// Usa safeQuery → se a 1ª tentativa pegar a conexão zumbi, o
// safeQuery faz $disconnect + $connect e a 2ª tentativa pega
// a conexão nova (que já acorda o banco).
//
// Sem timeout externo. Confia no connect_timeout do Prisma
// + retry do safeQuery.
export async function keepAlive() {
  const t0 = Date.now();
  try {
    await safeQuery(
      () => prisma.$queryRaw`SELECT 1`,
      { label: "keepAlive", attempts: 2 }
    );
    return {
      ok: true,
      latencyMs: Date.now() - t0,
      ts: new Date().toISOString(),
    };
  } catch (e) {
    return {
      ok: false,
      error: e.code || e.name,
      message: String(e.message || e).slice(0, 200),
      latencyMs: Date.now() - t0,
      ts: new Date().toISOString(),
    };
  }
}