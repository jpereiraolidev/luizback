// ============================================================
// auth.js — hash de senha, JWT, helpers de auth
// ============================================================
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { ENV } from "./config.js";

// ---------- PASSWORD ----------
const SALT_ROUNDS = 10;

export async function hashPassword(plain) {
  return bcrypt.hash(plain, SALT_ROUNDS);
}

export async function verifyPassword(plain, hash) {
  if (!hash) return false;
  return bcrypt.compare(plain, hash);
}

// ---------- JWT ----------
export function signToken(userId) {
  return jwt.sign({ userId }, ENV.JWT_SECRET, {
    expiresIn: ENV.JWT_EXPIRES_IN,
  });
}

export function verifyToken(token) {
  try {
    return jwt.verify(token, ENV.JWT_SECRET);
  } catch {
    return null;
  }
}

// ---------- HELPERS DE REQUEST ----------
export function extractBearer(req) {
  const h = req.headers.authorization || "";
  if (!h.startsWith("Bearer ")) return null;
  return h.slice(7).trim() || null;
}

// ---------- VALIDAÇÃO DE EMAIL / SENHA ----------
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(email) {
  return typeof email === "string" && EMAIL_RE.test(email.trim());
}

export function isValidPassword(pwd) {
  return typeof pwd === "string" && pwd.length >= 6;
}

// ---------- FORMATAÇÃO DE USER PÚBLICO ----------
export function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    coupleId: user.coupleId ?? null,
    createdAt: user.createdAt,
  };
}