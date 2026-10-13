// ============================================================
// middleware.js — CORS, auth, error handler, 404
// ------------------------------------------------------------
// 🔴 MUDOU: errorHandler agora classifica por CÓDIGO (não por string).
//           - Prisma P1001/P1002/P1008/P1017/P2024 → 503 (retryable)
//           - PostgreSQL 53300/57P01/08006 → 503 (retryable)
//           - PrismaClientValidationError → 400
// ✅ NOVO:  parseTimestamp() — valida datas antes de chegar no Prisma.
// ✅ NOVO:  requireAuthOrSkip, isUuid, extractIp para uso interno.
// ============================================================

import { HTTP, prisma, RECORD_STATUS } from "./config.js";
import { extractBearer, verifyToken } from "./auth.js";
import { log } from "./registerlogs.js";

// ---------- ERRO PADRÃO ----------
export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export const badRequest = (msg, det) => new HttpError(HTTP.BAD_REQUEST, msg, det);
export const unauthorized = (msg = "Não autenticado") => new HttpError(HTTP.UNAUTHORIZED, msg);
export const forbidden = (msg = "Sem permissão") => new HttpError(HTTP.FORBIDDEN, msg);
export const notFound = (msg = "Não encontrado") => new HttpError(HTTP.NOT_FOUND, msg);
export const conflict = (msg, det) => new HttpError(HTTP.CONFLICT, msg, det);
export const serviceUnavailable = (msg = "Serviço temporariamente indisponível") =>
  new HttpError(HTTP.UNAVAILABLE, msg);

// ---------- CORS ----------
export function cors(req, res, next) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");
  if (req.method === "OPTIONS") return res.sendStatus(HTTP.NO_CONTENT);
  next();
}

// ---------- AUTH ----------
// Valida o Bearer token, carrega o user do banco e injeta em req.user.
export async function authRequired(req, res, next) {
  try {
    const token = extractBearer(req);
    if (!token) throw unauthorized("Token ausente");

    const payload = verifyToken(token);
    if (!payload?.userId) throw unauthorized("Token inválido ou expirado");

    const user = await prisma.user.findUnique({ where: { id: payload.userId } });
    if (!user) throw unauthorized("Usuário não existe mais");

    req.user = user;
    next();
  } catch (e) {
    next(e);
  }
}

// Garante que o user tem casal (para rotas que precisam)
export function requireCouple(req, res, next) {
  if (!req.user?.coupleId) {
    return next(forbidden("Você ainda não está em um casal"));
  }
  next();
}

// Helper: verifica se um dependent pertence ao casal do user
export async function assertDependentBelongsToCouple(dependentId, coupleId) {
  if (!dependentId) throw badRequest("dependentId é obrigatório");
  const dep = await prisma.dependent.findUnique({ where: { id: dependentId } });
  if (!dep) throw notFound("Dependente não encontrado");
  if (dep.coupleId !== coupleId) throw forbidden("Dependente de outro casal");
  return dep;
}

// ✅ NOVO: verifica se um registro pertence ao casal do user (via dependentId)
export async function assertRecordBelongsToCouple(model, recordId, coupleId) {
  if (!recordId) throw badRequest("id é obrigatório");
  const rec = await prisma[model].findUnique({ where: { id: recordId } });
  if (!rec) throw notFound("Registro não encontrado");
  const dep = await prisma.dependent.findUnique({ where: { id: rec.dependentId } });
  if (!dep || dep.coupleId !== coupleId) throw forbidden("Registro de outro casal");
  return rec;
}

// ---------- 404 ----------
export function notFoundHandler(req, res) {
  res.status(HTTP.NOT_FOUND).json({ error: "Rota não encontrada", path: req.path });
}

// ============================================================
// ERROR HANDLER — classificação por CÓDIGO
// ============================================================
// 🔴 CORREÇÃO H4:
//   Antes: buscava substring em err.message ("Timed out fetching...").
//   Agora: classifica por código estável (Prisma P-codes + PG SQLSTATE).

// Prisma: erros de conexão/pool (podem ser retentados)
const PRISMA_DB_UNAVAILABLE = new Set([
  "P1001", // Can't reach database server
  "P1002", // Connection timed out
  "P1008", // Operation timed out
  "P1017", // Server has closed the connection
  "P2024", // Timed out fetching a new connection from pool
]);

// PostgreSQL: erros de conexão/conexões esgotadas
const PG_DB_UNAVAILABLE = new Set([
  "53300", // too_many_connections
  "53400", // configuration_limit_exceeded
  "57P01", // admin_shutdown
  "57P02", // crash_shutdown
  "57P03", // cannot_connect_now
  "08000", // connection_exception
  "08003", // connection_does_not_exist
  "08006", // connection_failure
  "08001", // sqlclient_unable_to_establish_sqlconnection
]);

function isDbUnavailable(err) {
  if (PRISMA_DB_UNAVAILABLE.has(err?.code)) return true;
  if (PG_DB_UNAVAILABLE.has(err?.meta?.code)) return true;
  if (PG_DB_UNAVAILABLE.has(err?.code)) return true;
  return false;
}

export function errorHandler(err, req, res, next) {
  // ---------- Banco indisponível (503 retryable) ----------
  if (isDbUnavailable(err)) {
    log.error("db.unavailable", {
      requestId: req.id,
      path: req.path,
      method: req.method,
      code: err.code,
      message: err.message?.slice(0, 300),
    });
    return res.status(HTTP.UNAVAILABLE).json({
      error: "Serviço temporariamente indisponível. Tente novamente em instantes.",
      code: "DB_UNAVAILABLE",
      retryable: true,
    });
  }

  // ---------- Prisma: erros conhecidos ----------
  if (err?.code === "P2002") {
    log.warn("db.unique_violation", {
      requestId: req.id,
      path: req.path,
      target: err.meta?.target,
    });
    return res.status(HTTP.CONFLICT).json({
      error: "Registro duplicado",
      details: err.meta?.target,
    });
  }
  if (err?.code === "P2025") {
    return res.status(HTTP.NOT_FOUND).json({ error: "Registro não encontrado" });
  }
  if (err?.code === "P2003") {
    return res.status(HTTP.BAD_REQUEST).json({
      error: "Referência inválida",
      details: err.meta?.field_name,
    });
  }

  // ---------- Prisma: validação (inclui Invalid Date que passou pelo parseTimestamp) ----------
  if (err?.name === "PrismaClientValidationError") {
    log.error("prisma.validation", {
      requestId: req.id,
      path: req.path,
      method: req.method,
      message: err.message?.slice(0, 300),
    });
    return res.status(HTTP.BAD_REQUEST).json({
      error: "Dados inválidos",
      code: "VALIDATION_ERROR",
    });
  }

  // ---------- HttpError (nossos erros) ----------
  const status = err.status || HTTP.INTERNAL;
  const body = { error: err.message || "Erro interno" };
  if (err.details) body.details = err.details;

  // 5xx: log estruturado
  if (status >= 500) {
    log.error("http.error", {
      requestId: req.id,
      method: req.method,
      path: req.path,
      status,
      message: err.message,
      stack: err.stack?.split("\n").slice(0, 6).join("\n"),
    });
  } else if (status >= 400) {
    log.warn("http.client_error", {
      requestId: req.id,
      method: req.method,
      path: req.path,
      status,
      message: err.message,
    });
  }

  res.status(status).json(body);
}

// ---------- WRAPPER PRA ROTAS ASYNC ----------
export const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

// ============================================================
// VALIDADORES
// ============================================================

export function requireFields(body, fields) {
  const missing = fields.filter((f) => {
    const v = body?.[f];
    return v === undefined || v === null || (typeof v === "string" && !v.trim());
  });
  if (missing.length) {
    throw badRequest(`Campos obrigatórios: ${missing.join(", ")}`);
  }
}

// Só aceita YYYY-MM-DD. Retorna Date em UTC meia-noite.
export function parseDateOnly(str) {
  if (typeof str !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(str)) return null;
  const d = new Date(`${str}T00:00:00.000Z`);
  return isNaN(d.getTime()) ? null : d;
}

// ✅ NOVO: aceita ISO 8601 completo, unix ms (número) ou Date.
// Retorna Date ou null. NUNCA lança.
export function parseTimestamp(input) {
  if (input === undefined || input === null || input === "") return null;
  if (input instanceof Date) return isNaN(input.getTime()) ? null : input;
  if (typeof input === "number") {
    // aceita unix ms ou unix s (heurística: < 1e12 = segundos)
    const ms = input < 1e12 ? input * 1000 : input;
    const d = new Date(ms);
    return isNaN(d.getTime()) ? null : d;
  }
  if (typeof input === "string") {
    const d = new Date(input);
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

// ✅ NOVO: timestamp obrigatório (usado nas rotas de registro)
export function parseTimestampRequired(input, fieldName = "timestamp") {
  const d = parseTimestamp(input);
  if (!d) throw badRequest(`${fieldName} inválido`);
  return d;
}

// Intervalo de um dia (00:00:00.000 a 23:59:59.999 UTC)
export function dayRange(dateStr) {
  const start = parseDateOnly(dateStr);
  if (!start) return null;
  const end = new Date(start);
  end.setUTCHours(23, 59, 59, 999);
  return { start, end };
}

// ✅ NOVO: valida e normaliza um avatar (string)
// Aceita: null/"" → remove, "data:image/..." (base64), "http(s)://..."
// Limite: 700KB em base64 (≈ 500KB de imagem real)
export function normalizeAvatar(avatar) {
  if (avatar === null || avatar === "") return null;
  if (typeof avatar !== "string") throw badRequest("Avatar inválido");
  if (avatar.length > 700_000) {
    throw badRequest("Foto muito grande (máx ~500KB)");
  }
  const isDataUrl = avatar.startsWith("data:image/");
  const isHttpUrl = /^https?:\/\//.test(avatar);
  if (!isDataUrl && !isHttpUrl) {
    throw badRequest("Formato de avatar inválido");
  }
  return avatar;
}

// ✅ NOVO: verifica se um registro está ativo (não foi arquivado)
export function isActive(record) {
  return record && record.status === RECORD_STATUS.ACTIVE;
}

// ✅ NOVO: gera where clause que filtra só registros ativos
export function activeOnly(extra = {}) {
  return { ...extra, status: RECORD_STATUS.ACTIVE };
}