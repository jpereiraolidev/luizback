// ============================================================
// middleware.js — CORS, auth, error handler, 404
// ============================================================
import { HTTP, prisma } from "./config.js";
import { extractBearer, verifyToken } from "./auth.js";

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
// Valida o Bearer token, carrega o user do banco e injeta em req.user
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

// ---------- 404 ----------
export function notFoundHandler(req, res) {
  res.status(HTTP.NOT_FOUND).json({ error: "Rota não encontrada", path: req.path });
}

// ---------- ERROR HANDLER ----------
export function errorHandler(err, req, res, next) {
  // Erros do Prisma
  if (err?.code === "P2002") {
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

  const status = err.status || HTTP.INTERNAL;
  const body = { error: err.message || "Erro interno" };
  if (err.details) body.details = err.details;

  if (status >= 500) {
    console.error("💥", err);
  }

  res.status(status).json(body);
}

// ---------- WRAPPER PRA ROTAS ASYNC ----------
// Evita try/catch em cada rota
export const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

// ---------- VALIDADORES SIMPLES ----------
export function requireFields(body, fields) {
  const missing = fields.filter((f) => {
    const v = body?.[f];
    return v === undefined || v === null || (typeof v === "string" && !v.trim());
  });
  if (missing.length) {
    throw badRequest(`Campos obrigatórios: ${missing.join(", ")}`);
  }
}

export function parseDateOnly(str) {
  if (typeof str !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(str)) return null;
  const d = new Date(`${str}T00:00:00.000Z`);
  return isNaN(d.getTime()) ? null : d;
}

export function dayRange(dateStr) {
  const start = parseDateOnly(dateStr);
  if (!start) return null;
  const end = new Date(start);
  end.setUTCHours(23, 59, 59, 999);
  return { start, end };
}