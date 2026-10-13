// ============================================================
// registerlogs.js — Observabilidade completa da API Luizback
// ------------------------------------------------------------
// Registra:
//   - Toda requisição de entrada (método, path, query, body sanitizado)
//   - Toda resposta (status, duração, tamanho, body sanitizado)
//   - Estado do processo (instanceId, uptime, memória, pid, boot count)
//   - Eventos do Prisma (erros, warnings, queries lentas)
//   - Erros não tratados (uncaughtException, unhandledRejection)
//   - Amostragem configurável para não explodir custo
//
// Modos de saída (env LOG_MODE):
//   stdout   → console.log estruturado (Vercel captura; sem persistência)
//   file     → arquivo rotativo em ./logs/ (local/staging)
//   db       → tabela AuditLog no Postgres
//   multi    → stdout + file + db em paralelo
//
// Env:
//   LOG_LEVEL         debug|info|warn|error   (default info)
//   LOG_MODE          stdout|file|db|multi    (default stdout)
//   LOG_DIR           diretório p/ file mode  (default ./logs)
//   LOG_MAX_BODY      bytes máximos do body   (default 4096)
//   LOG_SAMPLE_RATE   0..1                    (default 1.0 = tudo)
//   LOG_SLOW_MS       limiar p/ "lenta"       (default 1000)
//   LOG_SKIP_PATHS    CSV de paths ignorados  (default /favicon.ico)
//   LOG_REDACT        CSV de campos redigidos (default password,token,...)
//   LOG_PRISMA_SLOW_MS limiar p/ query lenta  (default 500)
// ============================================================

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// ---------- CONFIG ----------
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const LEVEL = LEVELS[process.env.LOG_LEVEL] || LEVELS.info;
const MODE = process.env.LOG_MODE || "stdout";
const LOG_DIR = process.env.LOG_DIR || "logs";
const MAX_BODY = Number(process.env.LOG_MAX_BODY || 4096);
const SAMPLE_RATE = Math.max(0, Math.min(1, Number(process.env.LOG_SAMPLE_RATE || 1)));
const SLOW_MS = Number(process.env.LOG_SLOW_MS || 1000);
const PRISMA_SLOW_MS = Number(process.env.LOG_PRISMA_SLOW_MS || 500);
const SKIP_PATHS = new Set(
  (process.env.LOG_SKIP_PATHS || "/favicon.ico")
    .split(",").map(s => s.trim()).filter(Boolean)
);
const REDACT_KEYS = new Set(
  (process.env.LOG_REDACT ||
    "password,passwordHash,token,authorization,secret,apiKey,database_url,diag_token,cron_secret")
    .split(",").map(s => s.trim().toLowerCase()).filter(Boolean)
);

// ---------- IDENTIDADE DA INSTÂNCIA ----------
// Persistente durante o ciclo de vida do processo (container quente).
// Muda a cada cold start — é exatamente isso que queremos detectar
// para resolver a hipótese H1 (fragmentação do PrismaClient).
if (!globalThis.__promax_logger) {
  globalThis.__promax_logger = {
    instanceId: crypto.randomUUID(),
    startedAt: new Date().toISOString(),
    bootCount: (globalThis.__promax_logger?.bootCount || 0) + 1,
    requestCount: 0,
    prismaInitAt: null,
  };
}
const INSTANCE = globalThis.__promax_logger;

// ---------- FILE SINK ----------
let fileStream = null;
if (MODE === "file" || MODE === "multi") {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    const fp = path.join(LOG_DIR, `api-${day}.log`);
    fileStream = fs.createWriteStream(fp, { flags: "a" });
  } catch (e) {
    console.error("[registerlogs] file sink falhou:", e.message);
  }
}

// ---------- DB SINK (lazy) ----------
// Importado dinamicamente para não criar dependência circular com config.js
let dbSink = null;
async function initDbSink() {
  if (dbSink !== null) return dbSink;
  try {
    const mod = await import("./config.js");
    dbSink = mod.prisma;
  } catch {
    dbSink = false;
  }
  return dbSink;
}

async function writeDb(entry) {
  const prisma = await initDbSink();
  if (!prisma) return;
  try {
    await prisma.auditLog.create({
      data: {
        instanceId: entry.instanceId,
        requestId: entry.requestId ?? null,
        level: entry.level,
        event: entry.event,
        method: entry.method ?? null,
        path: entry.path ?? null,
        status: entry.status ?? null,
        durationMs: entry.durationMs ?? null,
        userId: entry.userId ?? null,
        ip: entry.ip ?? null,
        userAgent: entry.userAgent?.slice(0, 300) ?? null,
        payload: entry.payload ?? null,
        error: entry.error ?? null,
      },
    });
  } catch (e) {
    // Falha no sink não pode derrubar a request.
    console.error("[registerlogs] db sink falhou:", e.message);
  }
}

// ---------- SANITIZAÇÃO ----------
function redact(obj, depth = 0) {
  if (depth > 6) return "[deep]";
  if (obj == null) return obj;
  if (typeof obj === "string") return obj.length > 500 ? obj.slice(0, 500) + "…" : obj;
  if (typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.slice(0, 50).map(v => redact(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = REDACT_KEYS.has(k.toLowerCase()) ? "***" : redact(v, depth + 1);
  }
  return out;
}

function truncateBody(body) {
  try {
    const json = JSON.stringify(redact(body));
    if (json.length <= MAX_BODY) return JSON.parse(json);
    return { _truncated: true, _size: json.length, _preview: json.slice(0, MAX_BODY) };
  } catch {
    return { _unserializable: true };
  }
}

// ---------- CORE DE LOG ----------
function emit(entry) {
  const full = {
    ts: new Date().toISOString(),
    instanceId: INSTANCE.instanceId,
    uptime: Math.round(process.uptime()),
    memMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
    ...entry,
  };

  // stdout
  if (MODE === "stdout" || MODE === "multi") {
    const line = JSON.stringify(full);
    if (entry.level === "error") console.error(line);
    else if (entry.level === "warn") console.warn(line);
    else console.log(line);
  }

  // file
  if (fileStream) {
    try { fileStream.write(JSON.stringify(full) + "\n"); } catch {}
  }

  // db (fire and forget)
  if (MODE === "db" || MODE === "multi") {
    writeDb(full).catch(() => {});
  }
}

const log = {
  debug: (evt, extra) => LEVEL <= LEVELS.debug && emit({ level: "debug", event: evt, ...extra }),
  info:  (evt, extra) => LEVEL <= LEVELS.info  && emit({ level: "info",  event: evt, ...extra }),
  warn:  (evt, extra) => LEVEL <= LEVELS.warn  && emit({ level: "warn",  event: evt, ...extra }),
  error: (evt, extra) => LEVEL <= LEVELS.error && emit({ level: "error", event: evt, ...extra }),
};

// ============================================================
// MIDDLEWARE — requestLogger
// ============================================================
// Deve ser registrado ANTES de express.json (para capturar headers,
// IP e content-length mesmo quando o body for inválido).
export function requestLogger(req, res, next) {
  // Skip paths configurados
  if (SKIP_PATHS.has(req.path)) return next();

  // Amostragem (0..1)
  if (SAMPLE_RATE < 1 && Math.random() > SAMPLE_RATE) return next();

  const requestId = crypto.randomUUID();
  const t0 = process.hrtime.bigint();

  // Injeta utilitários por request
  req.id = requestId;
  req.log = {
    debug: (evt, extra) => log.debug(evt, { requestId, ...extra }),
    info:  (evt, extra) => log.info(evt,  { requestId, ...extra }),
    warn:  (evt, extra) => log.warn(evt,  { requestId, ...extra }),
    error: (evt, extra) => log.error(evt, { requestId, ...extra }),
  };

  // Captura o body da resposta sem quebrar o fluxo
  const originalJson = res.json.bind(res);
  const originalSend = res.send.bind(res);
  let responseBody = null;

  res.json = (body) => { responseBody = body; return originalJson(body); };
  res.send = (body) => { if (responseBody == null) responseBody = body; return originalSend(body); };

  // ===== ENTRADA =====
  log.info("request.in", {
    requestId,
    method: req.method,
    path: req.path,
    query: redact(req.query),
    body: truncateBody(req.body || {}),
    userId: req.user?.id ?? null,
    ip: req.ip || req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || null,
    userAgent: req.headers["user-agent"] || null,
    contentLength: Number(req.headers["content-length"] || 0),
  });

  // ===== SAÍDA =====
  res.on("finish", () => {
    INSTANCE.requestCount++;
    const durationMs = Number(process.hrtime.bigint() - t0) / 1e6;
    const slow = durationMs > SLOW_MS;
    const level = res.statusCode >= 500 ? "error"
                : res.statusCode >= 400 ? "warn"
                : slow ? "warn"
                : "info";

    emit({
      level,
      event: "request.out",
      requestId,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs: Math.round(durationMs),
      slow,
      responseBytes: Number(res.getHeader("content-length") || 0),
      userId: req.user?.id ?? null,
      ip: req.ip || req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || null,
      userAgent: req.headers["user-agent"] || null,
      payload: responseBody != null ? truncateBody(responseBody) : null,
      instanceRequests: INSTANCE.requestCount,
    });
  });

  // ===== ABORT / SOCKET CLOSED =====
  res.on("close", () => {
    if (!res.writableEnded) {
      const durationMs = Math.round(Number(process.hrtime.bigint() - t0) / 1e6);
      log.warn("request.aborted", { requestId, method: req.method, path: req.path, durationMs });
    }
  });

  next();
}

// ============================================================
// INSTRUMENTAÇÃO DO PRISMA
// ============================================================
// Chame UMA VEZ após criar o PrismaClient:
//   import { instrumentPrisma } from "./registerlogs.js";
//   instrumentPrisma(prisma);
export function instrumentPrisma(prisma) {
  INSTANCE.prismaInitAt = new Date().toISOString();

  log.info("prisma.init", {
    bootCount: INSTANCE.bootCount,
    nodeVersion: process.version,
    env: process.env.NODE_ENV,
    region: process.env.VERCEL_REGION || null,
    hasPooler: /pooler|pgbouncer/i.test(process.env.DATABASE_URL || ""),
  });

  // Eventos nativos do Prisma (exigem log: [{emit:"event",...}] no client)
  try {
    prisma.$on("error", (e) => {
      log.error("prisma.error", {
        code: e.code,
        message: e.message?.slice(0, 500),
        target: e.meta?.target ?? null,
      });
    });
    prisma.$on("warn", (e) => {
      log.warn("prisma.warn", { message: e.message?.slice(0, 300) });
    });
  } catch {
    // Cliente foi criado sem log:{emit:"event"} — não é fatal
  }

  // Wrapper para medir duração de queries comuns
  const wrap = (model, method) => {
    const original = prisma[model]?.[method];
    if (typeof original !== "function") return;
    prisma[model][method] = async function (...args) {
      const t = process.hrtime.bigint();
      try {
        const result = await original.apply(this, args);
        const ms = Number(process.hrtime.bigint() - t) / 1e6;
        if (ms > PRISMA_SLOW_MS) {
          log.warn("prisma.slow", {
            model, method, durationMs: Math.round(ms),
            where: redact(args[0]?.where ?? {}),
          });
        }
        return result;
      } catch (err) {
        const ms = Number(process.hrtime.bigint() - t) / 1e6;
        log.error("prisma.error", {
          model, method, durationMs: Math.round(ms),
          code: err.code,
          message: err.message?.slice(0, 400),
          where: redact(args[0]?.where ?? {}),
        });
        throw err;
      }
    };
  };

  const models = ["user", "couple", "dependent", "water", "sleep", "pee", "poop",
                  "behavior", "coupleTask", "coupleData", "notification",
                  "inviteLink", "recordType", "customRecord", "auditLog"];
  const methods = ["findUnique", "findFirst", "findMany", "create",
                   "update", "updateMany", "delete", "deleteMany", "upsert", "count"];
  for (const m of models) {
    for (const fn of methods) wrap(m, fn);
  }

  return prisma;
}

// ============================================================
// HOOKS GLOBAIS DE PROCESSO
// ============================================================
export function installGlobalHooks() {
  if (globalThis.__promax_hooks_installed) return;
  globalThis.__promax_hooks_installed = true;

  process.on("uncaughtException", (err) => {
    log.error("process.uncaughtException", {
      message: err.message,
      stack: err.stack?.split("\n").slice(0, 8).join("\n"),
    });
  });

  process.on("unhandledRejection", (reason) => {
    log.error("process.unhandledRejection", {
      reason: String(reason).slice(0, 500),
    });
  });

  process.on("SIGTERM", () => {
    log.info("process.sigterm", { uptime: Math.round(process.uptime()) });
  });

  process.on("exit", (code) => {
    log.info("process.exit", { code, uptime: Math.round(process.uptime()) });
  });
}

// ============================================================
// HELPERS PÚBLICOS
// ============================================================
export function getInstanceInfo() {
  return {
    instanceId: INSTANCE.instanceId,
    startedAt: INSTANCE.startedAt,
    bootCount: INSTANCE.bootCount,
    requestCount: INSTANCE.requestCount,
    prismaInitAt: INSTANCE.prismaInitAt,
    uptime: Math.round(process.uptime()),
    nodeVersion: process.version,
    pid: process.pid,
    memMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
    region: process.env.VERCEL_REGION || null,
  };
}

export { log };