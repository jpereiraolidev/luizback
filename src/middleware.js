// ============================================================
// middleware.js — CORS, auth, error handler, 404
// ------------------------------------------------------------
// 🔴 MUDOU (v3):
//   - importa prisma e safeQuery de ./prisma.js (não mais de ./config.js)
//   - authRequired usa safeQuery → retry automático em conexão zumbi
//     (esse é o middleware por onde TODA request passa; se ele cair,
//      a API inteira cai)
//
// ✅ Mantido:
//   - errorHandler classifica por CÓDIGO (não por string)
//   - parseTimestamp / parseTimestampRequired
//   - normalizeAvatar
//   - assertDependentBelongsToCouple / assertRecordBelongsToCouple
//   - isActive / activeOnly
// ============================================================

import { HTTP, RECORD_STATUS } from "./config.js";
import { prisma, safeQuery } from "./prisma.js";
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
// 🔴 MUDOU: usa safeQuery → retry em erros de conexão (P1001/P1017/P2024/etc)
// Antes: se a conexão estivesse zumbi, /auth/me devolvia 401 para TODA a API.
// Agora: o retry roda o findUnique numa conexão nova antes de desistir.
export async function authRequired(req, res, next) {
  try {
    const token = extractBearer(req);
    if (!token) throw unauthorized("Token ausente");

    const payload = verifyToken(token);
    if (!payload?.userId) throw unauthorized("Token inválido ou expirado");

    const user = await safeQuery(
      (db) => db.user.findUnique({ where: { id: payload.userId } }),
      { label: "authRequired" }
    );
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
  const dep = await safeQuery(
    (db) => db.dependent.findUnique({ where: { id: dependentId } }),
    { label: "assertDependentBelongsToCouple" }
  );
  if (!dep) throw notFound("Dependente não encontrado");
  if (dep.coupleId !== coupleId) throw forbidden("Dependente de outro casal");
  return dep;
}

// ✅ Helper: verifica se um registro pertence ao casal do user (via dependentId)
export async function assertRecordBelongsToCouple(model, recordId, coupleId) {
  if (!recordId) throw badRequest("id é obrigatório");
  const rec = await safeQuery(
    (db) => db[model].findUnique({ where: { id: recordId } }),
    { label: `assertRecordBelongsToCouple:${model}` }
  );
  if (!rec) throw notFound("Registro não encontrado");
  const dep = await safeQuery(
    (db) => db.dependent.findUnique({ where: { id: rec.dependentId } }),
    { label: `assertRecordBelongsToCouple:${model}:dependent` }
  );
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

const PRISMA_DB_UNAVAILABLE = new Set([
  "P1001", "P1002", "P1008", "P1017", "P2024",
]);

const PG_DB_UNAVAILABLE = new Set([
  "53300", "53400", "57P01", "57P02", "57P03",
  "08000", "08003", "08006", "08001",
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

  // ---------- Prisma: validação (inclui Invalid Date) ----------
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

// Aceita ISO 8601, unix ms (número) ou Date. Retorna Date ou null. NUNCA lança.
export function parseTimestamp(input) {
  if (input === undefined || input === null || input === "") return null;
  if (input instanceof Date) return isNaN(input.getTime()) ? null : input;
  if (typeof input === "number") {
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

// Variante que lança 400 se inválido (usado nas rotas de registro)
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

// Valida e normaliza um avatar (string)
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

// Helpers de soft delete
export function isActive(record) {
  return record && record.status === RECORD_STATUS.ACTIVE;
}

export function activeOnly(extra = {}) {
  return { ...extra, status: RECORD_STATUS.ACTIVE };
}