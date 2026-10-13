// ============================================================
// routes.js — todas as rotas da API Luizback
// ------------------------------------------------------------
// 🔴 CORREÇÕES:
//   H3 — POST /notifications/:id/accept agora é atômico (updateMany)
//   H4 — POST /water|pee|poop|behavior valida timestamp (400 em vez de 500)
//   Todos os DELETE viram soft delete (status = "archived")
//
// ✅ NOVAS ROTAS:
//   /sleep              (CRUD completo)
//   /record-types       (CRUD tipos custom)
//   /custom-records     (CRUD registros custom)
//   /couple/invite-link (link rápido com expiração)
//   /__diag/instance    (diagnóstico protegido)
//   /__cron/prune-logs  (retenção de audit_logs)
//
// 🔴 MODIFICADAS:
//   /summary            (inclui sleep + custom, filtra status=active)
// ============================================================

import { Router } from "express";
import crypto from "node:crypto";
import {
  HTTP,
  prisma,
  CASAL_DATA_KEYS,
  NOTIF_TYPE,
  NOTIF_STATUS,
  RECORD_STATUS,
  INVITE_LINK,
  FIELD_TYPES,
} from "./config.js";
import {
  hashPassword,
  verifyPassword,
  signToken,
  publicUser,
  isValidEmail,
  isValidPassword,
} from "./auth.js";
import {
  asyncHandler,
  authRequired,
  requireCouple,
  requireFields,
  badRequest,
  unauthorized,
  forbidden,
  notFound,
  conflict,
  assertDependentBelongsToCouple,
  assertRecordBelongsToCouple,
  parseDateOnly,
  parseTimestampRequired,
  dayRange,
  normalizeAvatar,
  activeOnly,
} from "./middleware.js";
import { getInstanceInfo, log } from "./registerlogs.js";

const router = Router();

// ============================================================
// HELPERS LOCAIS
// ============================================================

function generateInviteToken() {
  // URL-safe, ~22 chars, 128 bits de entropia
  return crypto.randomBytes(INVITE_LINK.TOKEN_BYTES).toString("base64url");
}

function validateRecordFields(fields, data) {
  if (!Array.isArray(fields)) throw badRequest("Tipo com schema inválido");
  const errors = [];
  for (const f of fields) {
    if (!f.name || !f.type) { errors.push("Campo sem name ou type"); continue; }
    if (!FIELD_TYPES.includes(f.type)) { errors.push(`Tipo desconhecido: ${f.type}`); continue; }
    const v = data?.[f.name];
    if (f.required && (v === undefined || v === null || v === "")) {
      errors.push(`Campo obrigatório ausente: ${f.name}`);
      continue;
    }
    if (v === undefined || v === null) continue;
    if (f.type === "number" && typeof v !== "number") errors.push(`${f.name} deve ser número`);
    if (f.type === "boolean" && typeof v !== "boolean") errors.push(`${f.name} deve ser boolean`);
    if (f.type === "string" && typeof v !== "string") errors.push(`${f.name} deve ser string`);
    if (f.type === "text" && typeof v !== "string") errors.push(`${f.name} deve ser texto`);
    if (f.type === "select" && !f.options?.includes(v)) errors.push(`${f.name} deve ser um de: ${f.options?.join(", ")}`);
    if (f.type === "date" && typeof v === "string" && isNaN(new Date(v).getTime())) errors.push(`${f.name} deve ser data válida`);
    if (f.type === "number" && typeof v === "number") {
      if (f.min !== undefined && v < f.min) errors.push(`${f.name} < mínimo ${f.min}`);
      if (f.max !== undefined && v > f.max) errors.push(`${f.name} > máximo ${f.max}`);
    }
  }
  if (errors.length) throw badRequest(`Validação falhou: ${errors.join("; ")}`);
}

// ============================================================
// AUTH
// ============================================================

router.post("/auth/register", asyncHandler(async (req, res) => {
  const { email, password, name } = req.body || {};
  if (!isValidEmail(email)) throw badRequest("Email inválido");
  if (!isValidPassword(password)) throw badRequest("Senha deve ter >= 6 caracteres");
  if (!name?.trim()) throw badRequest("Nome é obrigatório");

  const existing = await prisma.user.findUnique({
    where: { email: email.toLowerCase().trim() },
  });
  if (existing) throw conflict("Email já cadastrado");

  const user = await prisma.user.create({
    data: {
      email: email.toLowerCase().trim(),
      passwordHash: await hashPassword(password),
      name: name.trim(),
    },
  });

  const token = signToken(user.id);
  res.status(HTTP.CREATED).json({ token, user: publicUser(user) });
}));

router.post("/auth/login", asyncHandler(async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) throw badRequest("Email e senha são obrigatórios");

  const user = await prisma.user.findUnique({
    where: { email: String(email).toLowerCase().trim() },
  });
  if (!user) throw unauthorized("Credenciais inválidas");

  const ok = await verifyPassword(password, user.passwordHash);
  if (!ok) throw unauthorized("Credenciais inválidas");

  const token = signToken(user.id);
  res.json({ token, user: publicUser(user) });
}));

router.get("/auth/me", authRequired, asyncHandler(async (req, res) => {
  const couple = req.user.coupleId
    ? await prisma.couple.findUnique({
        where: { id: req.user.coupleId },
        include: {
          members: { select: { id: true, name: true, email: true, avatar: true } },
          dependents: { select: { id: true, name: true, birthDate: true, avatar: true } },
        },
      })
    : null;

  res.json({ user: publicUser(req.user), couple });
}));

router.put("/auth/me", authRequired, asyncHandler(async (req, res) => {
  const { name, avatar } = req.body || {};
  const data = {};

  if (name !== undefined) {
    const trimmed = String(name).trim();
    if (!trimmed) throw badRequest("Nome não pode ser vazio");
    if (trimmed.length > 60) throw badRequest("Nome muito longo (máx 60)");
    data.name = trimmed;
  }
  if (avatar !== undefined) {
    data.avatar = normalizeAvatar(avatar);
  }
  if (Object.keys(data).length === 0) {
    throw badRequest("Nada pra atualizar");
  }

  const user = await prisma.user.update({ where: { id: req.user.id }, data });
  res.json({ user: publicUser(user) });
}));

// ============================================================
// COUPLE
// ============================================================

router.post("/couple", authRequired, asyncHandler(async (req, res) => {
  if (req.user.coupleId) throw conflict("Você já está em um casal");

  // 🔴 Usa transação para garantir que User.coupleId e Couple.ownerId fiquem consistentes
  const couple = await prisma.$transaction(async (tx) => {
    const c = await tx.couple.create({
      data: {
        ownerId: req.user.id,
        members: { connect: { id: req.user.id } },
      },
      include: {
        members: { select: { id: true, name: true, email: true, avatar: true } },
      },
    });
    // Garantia explícita (o `connect` já faz, mas confirmamos)
    await tx.user.update({
      where: { id: req.user.id },
      data: { coupleId: c.id },
    });
    return c;
  });

  res.status(HTTP.CREATED).json({ couple });
}));

router.get("/couple/me", authRequired, requireCouple, asyncHandler(async (req, res) => {
  const couple = await prisma.couple.findUnique({
    where: { id: req.user.coupleId },
    include: {
      members: { select: { id: true, name: true, email: true, avatar: true } },
      dependents: true,
    },
  });
  res.json({ couple });
}));

router.post("/couple/invite", authRequired, requireCouple, asyncHandler(async (req, res) => {
  const { email } = req.body || {};
  if (!isValidEmail(email)) throw badRequest("Email inválido");

  const target = await prisma.user.findUnique({
    where: { email: String(email).toLowerCase().trim() },
  });
  if (!target) throw notFound("Nenhum usuário cadastrado com esse email");
  if (target.id === req.user.id) throw badRequest("Você não pode convidar a si mesmo");
  if (target.coupleId) throw conflict("Esse usuário já está em um casal");

  const existing = await prisma.notification.findFirst({
    where: {
      type: NOTIF_TYPE.COUPLE_INVITE,
      status: NOTIF_STATUS.PENDING,
      fromId: req.user.id,
      toId: target.id,
    },
  });
  if (existing) throw conflict("Já existe um convite pendente pra esse usuário");

  const notif = await prisma.notification.create({
    data: {
      type: NOTIF_TYPE.COUPLE_INVITE,
      fromId: req.user.id,
      toId: target.id,
      payload: { coupleId: req.user.coupleId },
    },
    include: {
      from: { select: { id: true, name: true, email: true, avatar: true } },
    },
  });

  res.status(HTTP.CREATED).json({ notification: notif });
}));

router.put("/couple/prefs", authRequired, requireCouple, asyncHandler(async (req, res) => {
  const { color, theme } = req.body || {};
  const data = {};
  if (color) data.color = color;
  if (theme) data.theme = theme;
  const couple = await prisma.couple.update({ where: { id: req.user.coupleId }, data });
  res.json({ couple });
}));

router.delete("/couple/leave", authRequired, requireCouple, asyncHandler(async (req, res) => {
  const coupleId = req.user.coupleId;

  await prisma.user.update({
    where: { id: req.user.id },
    data: { coupleId: null },
  });

  const remaining = await prisma.user.count({ where: { coupleId } });
  if (remaining === 0) {
    await prisma.couple.delete({ where: { id: coupleId } }).catch((e) => {
      log.warn("couple.leave.delete_failed", { requestId: req.id, coupleId, error: e.message });
    });
  }

  res.json({ left: true });
}));

// ============================================================
// ✅ NOVO — CONVITE POR LINK RÁPIDO
// ============================================================

// POST /couple/invite-link  { expiresInHours?, maxUses? }
router.post("/couple/invite-link", authRequired, requireCouple, asyncHandler(async (req, res) => {
  const { expiresInHours, maxUses } = req.body || {};

  const hours = expiresInHours ?? INVITE_LINK.DEFAULT_EXPIRES_HOURS;
  if (!Number.isInteger(hours) || hours < 1 || hours > INVITE_LINK.MAX_EXPIRES_HOURS) {
    throw badRequest(`expiresInHours deve ser entre 1 e ${INVITE_LINK.MAX_EXPIRES_HOURS}`);
  }
  const uses = maxUses ?? INVITE_LINK.DEFAULT_MAX_USES;
  if (!Number.isInteger(uses) || uses < 1 || uses > INVITE_LINK.MAX_MAX_USES) {
    throw badRequest(`maxUses deve ser entre 1 e ${INVITE_LINK.MAX_MAX_USES}`);
  }

  // Revoga o link ativo anterior (só 1 por vez)
  await prisma.inviteLink.updateMany({
    where: { coupleId: req.user.coupleId, revokedAt: null },
    data: { revokedAt: new Date() },
  });

  const token = generateInviteToken();
  const expiresAt = new Date(Date.now() + hours * 3600_000);

  const link = await prisma.inviteLink.create({
    data: {
      token,
      coupleId: req.user.coupleId,
      createdById: req.user.id,
      expiresAt,
      maxUses: uses,
    },
  });

  log.info("invite_link.created", {
    requestId: req.id,
    coupleId: req.user.coupleId,
    linkId: link.id,
    expiresAt: link.expiresAt,
    maxUses: uses,
  });

  res.status(HTTP.CREATED).json({
    id: link.id,
    token: link.token,
    url: `/join/${link.token}`,
    expiresAt: link.expiresAt,
    maxUses: link.maxUses,
  });
}));

// GET /couple/invite-link
router.get("/couple/invite-link", authRequired, requireCouple, asyncHandler(async (req, res) => {
  const link = await prisma.inviteLink.findFirst({
    where: { coupleId: req.user.coupleId, revokedAt: null },
    orderBy: { createdAt: "desc" },
  });

  if (!link) return res.json({ link: null });

  const active = link.expiresAt > new Date() && link.useCount < link.maxUses;
  res.json({
    link: {
      id: link.id,
      token: link.token,
      url: `/join/${link.token}`,
      expiresAt: link.expiresAt,
      maxUses: link.maxUses,
      useCount: link.useCount,
      lastUsedAt: link.lastUsedAt,
      createdAt: link.createdAt,
      active,
    },
  });
}));

// DELETE /couple/invite-link
router.delete("/couple/invite-link", authRequired, requireCouple, asyncHandler(async (req, res) => {
  const result = await prisma.inviteLink.updateMany({
    where: { coupleId: req.user.coupleId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  log.info("invite_link.revoked", { requestId: req.id, coupleId: req.user.coupleId, count: result.count });
  res.json({ revoked: true, count: result.count });
}));

// GET /couple/invite-link/:token/preview  (público)
router.get("/couple/invite-link/:token/preview", asyncHandler(async (req, res) => {
  const { token } = req.params;
  const link = await prisma.inviteLink.findUnique({
    where: { token },
    include: {
      couple: { select: { id: true } },
      createdBy: { select: { name: true } },
    },
  });
  if (!link) throw notFound("Convite não encontrado");
  if (link.revokedAt) throw notFound("Convite revogado");
  if (link.expiresAt <= new Date()) throw notFound("Convite expirado");
  if (link.useCount >= link.maxUses) throw notFound("Convite já utilizado");

  res.json({
    coupleId: link.couple.id,
    createdByName: link.createdBy.name,
    expiresAt: link.expiresAt,
    remainingUses: link.maxUses - link.useCount,
  });
}));

// POST /couple/invite-link/:token/accept
router.post("/couple/invite-link/:token/accept", authRequired, asyncHandler(async (req, res) => {
  const { token } = req.params;

  if (req.user.coupleId) throw conflict("Você já está em um casal");

  // 🔴 Atômico: só passa se ainda válido
  const result = await prisma.$transaction(async (tx) => {
    const link = await tx.inviteLink.findUnique({ where: { token } });
    if (!link) throw notFound("Convite não encontrado");
    if (link.revokedAt) throw badRequest("Convite revogado");
    if (link.expiresAt <= new Date()) throw badRequest("Convite expirado");
    if (link.useCount >= link.maxUses) throw conflict("Convite já utilizado");

    // Reserva um "uso" atomicamente
    const claimed = await tx.inviteLink.updateMany({
      where: {
        id: link.id,
        revokedAt: null,
        expiresAt: { gt: new Date() },
        useCount: { lt: link.maxUses },
      },
      data: {
        useCount: { increment: 1 },
        lastUsedAt: new Date(),
        lastUsedById: req.user.id,
      },
    });
    if (claimed.count === 0) throw conflict("Convite já utilizado");

    // Re-lê o user para garantir que ainda está sem casal
    const fresh = await tx.user.findUnique({ where: { id: req.user.id } });
    if (fresh.coupleId) throw conflict("Você já está em um casal");

    await tx.user.update({
      where: { id: req.user.id },
      data: { coupleId: link.coupleId },
    });

    return { coupleId: link.coupleId, linkId: link.id };
  });

  log.info("invite_link.accepted", {
    requestId: req.id,
    coupleId: result.coupleId,
    linkId: result.linkId,
    userId: req.user.id,
  });

  res.json({ accepted: true, coupleId: result.coupleId });
}));

// ============================================================
// NOTIFICATIONS
// ============================================================

router.get("/notifications", authRequired, asyncHandler(async (req, res) => {
  const { status } = req.query;
  const where = { toId: req.user.id };
  if (status) where.status = status;

  const list = await prisma.notification.findMany({
    where,
    orderBy: { createdAt: "desc" },
    include: {
      from: { select: { id: true, name: true, email: true, avatar: true } },
    },
    take: 50,
  });
  res.json(list);
}));

// 🔴 CORREÇÃO H3 — accept atômico
router.post("/notifications/:id/accept", authRequired, asyncHandler(async (req, res) => {
  const notif = await prisma.notification.findUnique({ where: { id: req.params.id } });
  if (!notif) throw notFound("Notificação não encontrada");
  if (notif.toId !== req.user.id) throw forbidden("Essa notificação não é sua");

  if (notif.type !== NOTIF_TYPE.COUPLE_INVITE) {
    throw badRequest("Tipo de notificação não suportado");
  }
  const coupleId = notif.payload?.coupleId;
  if (!coupleId) throw badRequest("Convite sem coupleId");

  const result = await prisma.$transaction(async (tx) => {
    // Só marca como ACCEPTED se ainda estiver PENDING — atômico
    const updated = await tx.notification.updateMany({
      where: { id: notif.id, status: NOTIF_STATUS.PENDING },
      data: { status: NOTIF_STATUS.ACCEPTED },
    });
    if (updated.count === 0) throw conflict("Notificação não está mais pendente");

    // Re-lê o user dentro da transação
    const fresh = await tx.user.findUnique({ where: { id: req.user.id } });
    if (fresh.coupleId) throw conflict("Você já está em um casal");

    await tx.user.update({
      where: { id: req.user.id },
      data: { coupleId },
    });

    return { coupleId };
  });

  log.info("notification.accepted", {
    requestId: req.id,
    notifId: notif.id,
    coupleId: result.coupleId,
    userId: req.user.id,
  });

  res.json({ accepted: true, coupleId: result.coupleId });
}));

router.post("/notifications/:id/reject", authRequired, asyncHandler(async (req, res) => {
  const notif = await prisma.notification.findUnique({ where: { id: req.params.id } });
  if (!notif) throw notFound("Notificação não encontrada");
  if (notif.toId !== req.user.id) throw forbidden("Essa notificação não é sua");

  const result = await prisma.notification.updateMany({
    where: { id: notif.id, status: NOTIF_STATUS.PENDING },
    data: { status: NOTIF_STATUS.REJECTED },
  });
  if (result.count === 0) throw conflict("Notificação não está pendente");

  res.json({ rejected: true });
}));

router.delete("/notifications/:id", authRequired, asyncHandler(async (req, res) => {
  const notif = await prisma.notification.findUnique({ where: { id: req.params.id } });
  if (!notif) throw notFound("Notificação não encontrada");
  if (notif.fromId !== req.user.id) throw forbidden("Só quem enviou pode cancelar");

  await prisma.notification.update({
    where: { id: notif.id },
    data: { status: NOTIF_STATUS.CANCELLED },
  });
  res.json({ cancelled: true });
}));

// ============================================================
// DEPENDENT
// ============================================================

router.get("/dependent", authRequired, requireCouple, asyncHandler(async (req, res) => {
  const list = await prisma.dependent.findMany({
    where: { coupleId: req.user.coupleId },
    orderBy: { createdAt: "asc" },
  });
  res.json(list);
}));

router.post("/dependent", authRequired, requireCouple, asyncHandler(async (req, res) => {
  const { name, birthDate, avatar } = req.body || {};
  if (!name?.trim()) throw badRequest("Nome é obrigatório");

  let birth = null;
  if (birthDate) {
    birth = parseDateOnly(birthDate);
    if (!birth) throw badRequest("birthDate deve ser YYYY-MM-DD");
  }

  let av = null;
  if (avatar !== undefined && avatar !== null) {
    av = normalizeAvatar(avatar);
  }

  const dep = await prisma.dependent.create({
    data: {
      name: name.trim(),
      birthDate: birth,
      avatar: av,
      coupleId: req.user.coupleId,
    },
  });
  res.status(HTTP.CREATED).json(dep);
}));

router.get("/dependent/:id", authRequired, requireCouple, asyncHandler(async (req, res) => {
  const dep = await assertDependentBelongsToCouple(req.params.id, req.user.coupleId);
  res.json(dep);
}));

router.put("/dependent/:id", authRequired, requireCouple, asyncHandler(async (req, res) => {
  await assertDependentBelongsToCouple(req.params.id, req.user.coupleId);
  const { name, birthDate, avatar } = req.body || {};
  const data = {};

  if (name !== undefined) data.name = String(name).trim();
  if (avatar !== undefined) data.avatar = normalizeAvatar(avatar);
  if (birthDate !== undefined) {
    data.birthDate = birthDate ? parseDateOnly(birthDate) : null;
    if (birthDate && !data.birthDate) throw badRequest("birthDate inválida");
  }

  const dep = await prisma.dependent.update({ where: { id: req.params.id }, data });
  res.json(dep);
}));

router.delete("/dependent/:id", authRequired, requireCouple, asyncHandler(async (req, res) => {
  await assertDependentBelongsToCouple(req.params.id, req.user.coupleId);
  await prisma.dependent.delete({ where: { id: req.params.id } });
  res.json({ deleted: true });
}));

// ============================================================
// REGISTROS — factory (com soft delete e parseTimestampRequired)
// ============================================================

function makeRegistroRoutes(path, modelName, buildCreate, buildUpdate) {
  // CREATE
  router.post(path, authRequired, requireCouple, asyncHandler(async (req, res) => {
    const dependentId = req.body?.dependentId;
    await assertDependentBelongsToCouple(dependentId, req.user.coupleId);
    const data = await buildCreate(req.body, req.user);
    const created = await prisma[modelName].create({ data });
    res.status(HTTP.CREATED).json(created);
  }));

  // LIST — por padrão só ativos; aceita ?status= para incluir outros
  router.get(path, authRequired, requireCouple, asyncHandler(async (req, res) => {
    const { dependentId, date, status } = req.query;
    await assertDependentBelongsToCouple(dependentId, req.user.coupleId);

    const where = { dependentId };
    if (status === "all") {
      // todos
    } else if (status) {
      where.status = status;
    } else {
      where.status = RECORD_STATUS.ACTIVE;
    }

    if (date) {
      const range = dayRange(date);
      if (!range) throw badRequest("date inválida (YYYY-MM-DD)");
      where.date = { gte: range.start, lte: range.end };
    }

    const items = await prisma[modelName].findMany({
      where,
      orderBy: { timestamp: "desc" },
      take: 500,
    });
    res.json(items);
  }));

  // UPDATE
  router.put(path, authRequired, requireCouple, asyncHandler(async (req, res) => {
    const { id } = req.query;
    if (!id) throw badRequest("id é obrigatório");

    const existing = await prisma[modelName].findUnique({ where: { id } });
    if (!existing) throw notFound("Registro não encontrado");
    await assertDependentBelongsToCouple(existing.dependentId, req.user.coupleId);

    const data = buildUpdate(req.body);
    const updated = await prisma[modelName].update({ where: { id }, data });
    res.json(updated);
  }));

  // DELETE — soft delete (status = archived)
  router.delete(path, authRequired, requireCouple, asyncHandler(async (req, res) => {
    const { id } = req.query;
    if (!id) throw badRequest("id é obrigatório");

    const existing = await prisma[modelName].findUnique({ where: { id } });
    if (!existing) throw notFound("Registro não encontrado");
    await assertDependentBelongsToCouple(existing.dependentId, req.user.coupleId);

    const updated = await prisma[modelName].update({
      where: { id },
      data: { status: RECORD_STATUS.ARCHIVED },
    });
    res.json({ archived: true, id: updated.id });
  }));
}

// ---------- WATER (mantido como legado) ----------
makeRegistroRoutes(
  "/water",
  "water",
  async (body) => {
    requireFields(body, ["amount", "timestamp", "date"]);
    const d = parseDateOnly(body.date);
    if (!d) throw badRequest("date inválida");
    // 🔴 CORREÇÃO H4
    const ts = parseTimestampRequired(body.timestamp, "timestamp");
    if (typeof body.amount !== "number" || body.amount <= 0)
      throw badRequest("amount deve ser número positivo");
    return {
      amount: body.amount,
      reason: body.reason ?? null,
      timestamp: ts,
      date: d,
      dependentId: body.dependentId,
    };
  },
  (body) => {
    const data = {};
    if (body.amount !== undefined) data.amount = body.amount;
    if (body.reason !== undefined) data.reason = body.reason;
    if (body.timestamp !== undefined) data.timestamp = parseTimestampRequired(body.timestamp);
    return data;
  }
);

// ---------- PEE ----------
makeRegistroRoutes(
  "/pee",
  "pee",
  async (body) => {
    requireFields(body, ["size", "type", "timestamp", "date"]);
    const d = parseDateOnly(body.date);
    if (!d) throw badRequest("date inválida");
    const ts = parseTimestampRequired(body.timestamp, "timestamp");
    return {
      size: body.size,
      type: body.type,
      note: body.note ?? null,
      timestamp: ts,
      date: d,
      dependentId: body.dependentId,
    };
  },
  (body) => {
    const data = {};
    ["size", "type", "note"].forEach((k) => {
      if (body[k] !== undefined) data[k] = body[k];
    });
    if (body.timestamp !== undefined) data.timestamp = parseTimestampRequired(body.timestamp);
    return data;
  }
);

// ---------- POOP ----------
makeRegistroRoutes(
  "/poop",
  "poop",
  async (body) => {
    requireFields(body, ["evacuated", "timestamp", "date"]);
    const d = parseDateOnly(body.date);
    if (!d) throw badRequest("date inválida");
    const ts = parseTimestampRequired(body.timestamp, "timestamp");
    return {
      evacuated: !!body.evacuated,
      consistency: body.consistency ?? null,
      pain: Number.isFinite(body.pain) ? body.pain : 0,
      note: body.note ?? null,
      timestamp: ts,
      date: d,
      dependentId: body.dependentId,
    };
  },
  (body) => {
    const data = {};
    ["evacuated", "consistency", "pain", "note"].forEach((k) => {
      if (body[k] !== undefined) data[k] = body[k];
    });
    if (body.timestamp !== undefined) data.timestamp = parseTimestampRequired(body.timestamp);
    return data;
  }
);

// ---------- BEHAVIOR ----------
makeRegistroRoutes(
  "/behavior",
  "behavior",
  async (body) => {
    requireFields(body, ["observed", "timestamp", "date"]);
    const d = parseDateOnly(body.date);
    if (!d) throw badRequest("date inválida");
    const ts = parseTimestampRequired(body.timestamp, "timestamp");
    return {
      observed: body.observed,
      rule: body.rule ?? null,
      action: body.action ?? null,
      duration: Number.isFinite(body.duration) ? body.duration : null,
      result: body.result ?? null,
      timestamp: ts,
      date: d,
      dependentId: body.dependentId,
    };
  },
  (body) => {
    const data = {};
    ["observed", "rule", "action", "duration", "result"].forEach((k) => {
      if (body[k] !== undefined) data[k] = body[k];
    });
    if (body.timestamp !== undefined) data.timestamp = parseTimestampRequired(body.timestamp);
    return data;
  }
);

// ============================================================
// ✅ NOVO — SLEEP (registro principal)
// ============================================================

makeRegistroRoutes(
  "/sleep",
  "sleep",
  async (body) => {
    requireFields(body, ["durationMin", "startAt", "date"]);
    const d = parseDateOnly(body.date);
    if (!d) throw badRequest("date inválida");
    const startAt = parseTimestampRequired(body.startAt, "startAt");
    const endAt = body.endAt ? parseTimestampRequired(body.endAt, "endAt") : null;
    if (typeof body.durationMin !== "number" || body.durationMin < 0)
      throw badRequest("durationMin deve ser número >= 0");
    if (endAt && endAt < startAt) throw badRequest("endAt deve ser >= startAt");

    const ts = body.timestamp
      ? parseTimestampRequired(body.timestamp, "timestamp")
      : startAt;

    return {
      durationMin: Math.round(body.durationMin),
      startAt,
      endAt,
      quality: body.quality ?? null,
      note: body.note ?? null,
      timestamp: ts,
      date: d,
      dependentId: body.dependentId,
    };
  },
  (body) => {
    const data = {};
    if (body.durationMin !== undefined) {
      if (typeof body.durationMin !== "number" || body.durationMin < 0)
        throw badRequest("durationMin deve ser número >= 0");
      data.durationMin = Math.round(body.durationMin);
    }
    if (body.startAt !== undefined) data.startAt = parseTimestampRequired(body.startAt, "startAt");
    if (body.endAt !== undefined) data.endAt = body.endAt ? parseTimestampRequired(body.endAt, "endAt") : null;
    if (body.quality !== undefined) data.quality = body.quality;
    if (body.note !== undefined) data.note = body.note;
    if (body.timestamp !== undefined) data.timestamp = parseTimestampRequired(body.timestamp);
    return data;
  }
);

// ============================================================
// ✅ NOVO — RECORD TYPES (tipos custom do casal)
// ============================================================

router.post("/record-types", authRequired, requireCouple, asyncHandler(async (req, res) => {
  const { slug, label, icon, fields } = req.body || {};
  if (!slug || !/^[a-z0-9-]{2,40}$/.test(slug)) throw badRequest("slug deve ser a-z, 0-9 e -, 2-40 chars");
  if (!label?.trim()) throw badRequest("label é obrigatório");
  if (!Array.isArray(fields) || fields.length === 0) throw badRequest("fields deve ser array não-vazio");
  if (fields.length > 20) throw badRequest("no máximo 20 campos");

  const existing = await prisma.recordType.findUnique({
    where: { coupleId_slug: { coupleId: req.user.coupleId, slug } },
  });
  if (existing) throw conflict("Já existe um tipo com esse slug");

  const rt = await prisma.recordType.create({
    data: {
      coupleId: req.user.coupleId,
      slug,
      label: label.trim(),
      icon: icon ?? null,
      fields,
    },
  });
  res.status(HTTP.CREATED).json(rt);
}));

router.get("/record-types", authRequired, requireCouple, asyncHandler(async (req, res) => {
  const list = await prisma.recordType.findMany({
    where: { coupleId: req.user.coupleId, active: true },
    orderBy: { createdAt: "asc" },
  });
  res.json(list);
}));

router.put("/record-types/:id", authRequired, requireCouple, asyncHandler(async (req, res) => {
  const existing = await prisma.recordType.findUnique({ where: { id: req.params.id } });
  if (!existing || existing.coupleId !== req.user.coupleId) throw notFound("Tipo não encontrado");

  const data = {};
  if (req.body.label !== undefined) data.label = String(req.body.label).trim();
  if (req.body.icon !== undefined) data.icon = req.body.icon;
  if (req.body.fields !== undefined) {
    if (!Array.isArray(req.body.fields) || req.body.fields.length === 0)
      throw badRequest("fields deve ser array não-vazio");
    data.fields = req.body.fields;
  }
  if (req.body.active !== undefined) data.active = !!req.body.active;

  const rt = await prisma.recordType.update({ where: { id: req.params.id }, data });
  res.json(rt);
}));

router.delete("/record-types/:id", authRequired, requireCouple, asyncHandler(async (req, res) => {
  const existing = await prisma.recordType.findUnique({ where: { id: req.params.id } });
  if (!existing || existing.coupleId !== req.user.coupleId) throw notFound("Tipo não encontrado");

  const rt = await prisma.recordType.update({
    where: { id: req.params.id },
    data: { active: false },
  });
  res.json({ archived: true, id: rt.id });
}));

// ============================================================
// ✅ NOVO — CUSTOM RECORDS
// ============================================================

router.post("/custom-records", authRequired, requireCouple, asyncHandler(async (req, res) => {
  const { typeId, dependentId, data, timestamp, date } = req.body || {};
  if (!typeId) throw badRequest("typeId é obrigatório");
  if (!dependentId) throw badRequest("dependentId é obrigatório");

  await assertDependentBelongsToCouple(dependentId, req.user.coupleId);

  const type = await prisma.recordType.findUnique({ where: { id: typeId } });
  if (!type || type.coupleId !== req.user.coupleId || !type.active)
    throw notFound("Tipo não encontrado");

  validateRecordFields(type.fields, data);

  const ts = parseTimestampRequired(timestamp, "timestamp");
  const d = parseDateOnly(date);
  if (!d) throw badRequest("date inválida");

  const cr = await prisma.customRecord.create({
    data: {
      typeId,
      dependentId,
      data,
      timestamp: ts,
      date: d,
    },
  });
  res.status(HTTP.CREATED).json(cr);
}));

router.get("/custom-records", authRequired, requireCouple, asyncHandler(async (req, res) => {
  const { dependentId, typeId, date, status } = req.query;
  await assertDependentBelongsToCouple(dependentId, req.user.coupleId);

  const where = { dependentId };
  if (typeId) {
    const t = await prisma.recordType.findUnique({ where: { id: typeId } });
    if (!t || t.coupleId !== req.user.coupleId) throw notFound("Tipo não encontrado");
    where.typeId = typeId;
  }
  if (status === "all") {
    // todos
  } else if (status) {
    where.status = status;
  } else {
    where.status = RECORD_STATUS.ACTIVE;
  }
  if (date) {
    const range = dayRange(date);
    if (!range) throw badRequest("date inválida");
    where.date = { gte: range.start, lte: range.end };
  }

  const list = await prisma.customRecord.findMany({
    where,
    orderBy: { timestamp: "desc" },
    take: 500,
    include: { type: { select: { slug: true, label: true, icon: true } } },
  });
  res.json(list);
}));

router.put("/custom-records", authRequired, requireCouple, asyncHandler(async (req, res) => {
  const { id } = req.query;
  if (!id) throw badRequest("id é obrigatório");

  const existing = await prisma.customRecord.findUnique({
    where: { id },
    include: { type: true },
  });
  if (!existing) throw notFound("Registro não encontrado");
  await assertDependentBelongsToCouple(existing.dependentId, req.user.coupleId);
  if (existing.type.coupleId !== req.user.coupleId) throw forbidden("Tipo de outro casal");

  const data = {};
  if (req.body.data !== undefined) {
    validateRecordFields(existing.type.fields, req.body.data);
    data.data = req.body.data;
  }
  if (req.body.timestamp !== undefined) data.timestamp = parseTimestampRequired(req.body.timestamp);
  if (req.body.date !== undefined) {
    const d = parseDateOnly(req.body.date);
    if (!d) throw badRequest("date inválida");
    data.date = d;
  }

  const cr = await prisma.customRecord.update({ where: { id }, data });
  res.json(cr);
}));

router.delete("/custom-records", authRequired, requireCouple, asyncHandler(async (req, res) => {
  const { id } = req.query;
  if (!id) throw badRequest("id é obrigatório");

  const existing = await prisma.customRecord.findUnique({ where: { id } });
  if (!existing) throw notFound("Registro não encontrado");
  await assertDependentBelongsToCouple(existing.dependentId, req.user.coupleId);

  const cr = await prisma.customRecord.update({
    where: { id },
    data: { status: RECORD_STATUS.ARCHIVED },
  });
  res.json({ archived: true, id: cr.id });
}));

// ============================================================
// SUMMARY (atualizado)
// ============================================================
// 🔴 Só inclui registros com status=active.
// ✅ Inclui sleep e custom.
// Mantém `water` na resposta para compatibilidade (sempre vazio se não houver).
// ============================================================

router.get("/summary", authRequired, requireCouple, asyncHandler(async (req, res) => {
  const { dependentId, date } = req.query;
  if (!date) throw badRequest("date é obrigatório");
  await assertDependentBelongsToCouple(dependentId, req.user.coupleId);

  const range = dayRange(date);
  if (!range) throw badRequest("date inválida");

  const dayWhere = {
    dependentId,
    date: { gte: range.start, lte: range.end },
    status: RECORD_STATUS.ACTIVE,
  };

  const [sleep, pee, poop, behavior] = await Promise.all([
    prisma.sleep.findMany({ where: dayWhere, orderBy: { timestamp: "desc" } }),
    prisma.pee.findMany({ where: dayWhere, orderBy: { timestamp: "desc" } }),
    prisma.poop.findMany({ where: dayWhere, orderBy: { timestamp: "desc" } }),
    prisma.behavior.findMany({ where: dayWhere, orderBy: { timestamp: "desc" } }),
  ]);

  // Custom: agrupa por slug do tipo
  const customRaw = await prisma.customRecord.findMany({
    where: dayWhere,
    orderBy: { timestamp: "desc" },
    include: { type: { select: { slug: true } } },
  });
  const custom = {};
  for (const cr of customRaw) {
    const slug = cr.type.slug;
    (custom[slug] ||= []).push(cr);
  }

  // Weekly: últimos 7 dias incluindo `date`
  const base = parseDateOnly(date);
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(base);
    d.setUTCDate(d.getUTCDate() - i);
    days.push(d);
  }
  const weekStart = days[0];
  const weekEnd = new Date(days[6]);
  weekEnd.setUTCHours(23, 59, 59, 999);

  const weekWhere = {
    dependentId,
    date: { gte: weekStart, lte: weekEnd },
    status: RECORD_STATUS.ACTIVE,
  };

  const [weekSleep, weekPee, weekPoop] = await Promise.all([
    prisma.sleep.findMany({ where: weekWhere }),
    prisma.pee.findMany({ where: weekWhere }),
    prisma.poop.findMany({ where: weekWhere }),
  ]);

  const dayKey = (d) => new Date(d).toISOString().slice(0, 10);

  const weeklySleepMin = days.map((d) => {
    const key = dayKey(d);
    return weekSleep.filter((s) => dayKey(s.date) === key).reduce((sum, s) => sum + s.durationMin, 0);
  });
  const weeklySleepCount = days.map((d) => {
    const key = dayKey(d);
    return weekSleep.filter((s) => dayKey(s.date) === key).length;
  });
  const weeklyPee = days.map((d) => {
    const key = dayKey(d);
    return weekPee.filter((p) => dayKey(p.date) === key).length;
  });
  const weeklyPoop = days.map((d) => {
    const key = dayKey(d);
    return weekPoop.filter((p) => dayKey(p.date) === key).length;
  });

  res.json({
    // mantido para compatibilidade
    water: [],
    // novo
    sleep,
    pee,
    poop,
    behavior,
    custom,
    weekly: {
      // mantido vazio para compatibilidade
      water: [0, 0, 0, 0, 0, 0, 0],
      // novo
      sleepMin: weeklySleepMin,
      sleepCount: weeklySleepCount,
      pee: weeklyPee,
      poop: weeklyPoop,
    },
  });
}));

// ============================================================
// CASAL — TAREFAS
// ============================================================

router.get("/casal", authRequired, requireCouple, asyncHandler(async (req, res) => {
  const { done } = req.query;
  const where = { coupleId: req.user.coupleId };
  if (done === "true") where.done = true;
  if (done === "false") where.done = false;

  const list = await prisma.coupleTask.findMany({
    where,
    orderBy: [{ done: "asc" }, { createdAt: "desc" }],
  });
  res.json(list);
}));

router.post("/casal", authRequired, requireCouple, asyncHandler(async (req, res) => {
  const { text, owner, priority, due, note } = req.body || {};
  if (!text || !String(text).trim()) throw badRequest("text é obrigatório");

  const task = await prisma.coupleTask.create({
    data: {
      text: String(text).trim(),
      owner: owner ?? "Qualquer um",
      priority: priority ?? "media",
      due: due ?? null,
      note: note ?? null,
      coupleId: req.user.coupleId,
    },
  });
  res.status(HTTP.CREATED).json(task);
}));

router.put("/casal", authRequired, requireCouple, asyncHandler(async (req, res) => {
  const { id } = req.query;
  if (!id) throw badRequest("id é obrigatório");

  const existing = await prisma.coupleTask.findUnique({ where: { id } });
  if (!existing || existing.coupleId !== req.user.coupleId)
    throw notFound("Tarefa não encontrada");

  const data = {};
  ["text", "owner", "priority", "due", "note"].forEach((k) => {
    if (req.body[k] !== undefined) data[k] = req.body[k];
  });
  if (req.body.done !== undefined) {
    data.done = !!req.body.done;
    data.doneAt = data.done ? new Date() : null;
  }

  const updated = await prisma.coupleTask.update({ where: { id }, data });
  res.json(updated);
}));

router.delete("/casal", authRequired, requireCouple, asyncHandler(async (req, res) => {
  const { id } = req.query;
  if (!id) throw badRequest("id é obrigatório");

  const existing = await prisma.coupleTask.findUnique({ where: { id } });
  if (!existing || existing.coupleId !== req.user.coupleId)
    throw notFound("Tarefa não encontrada");

  await prisma.coupleTask.delete({ where: { id } });
  res.json({ deleted: true });
}));

// ============================================================
// CASAL — DADOS GENÉRICOS
// ============================================================

router.get("/casal/data", authRequired, requireCouple, asyncHandler(async (req, res) => {
  const { key } = req.query;
  if (!key) throw badRequest("key é obrigatória");
  if (!CASAL_DATA_KEYS.includes(key)) throw badRequest(`key inválida: ${key}`);

  const row = await prisma.coupleData.findUnique({
    where: { coupleId_key: { coupleId: req.user.coupleId, key } },
  });

  res.json({ key, value: row ? JSON.parse(row.value) : null });
}));

router.put("/casal/data", authRequired, requireCouple, asyncHandler(async (req, res) => {
  const { key } = req.query;
  if (!key) throw badRequest("key é obrigatória");
  if (!CASAL_DATA_KEYS.includes(key)) throw badRequest(`key inválida: ${key}`);
  if (!("value" in (req.body || {}))) throw badRequest("value é obrigatório");

  const serialized = JSON.stringify(req.body.value);
  const row = await prisma.coupleData.upsert({
    where: { coupleId_key: { coupleId: req.user.coupleId, key } },
    update: { value: serialized },
    create: { coupleId: req.user.coupleId, key, value: serialized },
  });
  res.json({ key, value: JSON.parse(row.value) });
}));

// ============================================================
// DIAGNÓSTICO (protegido por DIAG_TOKEN)
// ============================================================

router.get("/__diag/instance", (req, res) => {
  const expected = process.env.DIAG_TOKEN;
  if (!expected || req.headers["x-diag-token"] !== expected) {
    return res.status(404).json({ error: "not found" });
  }
  res.json(getInstanceInfo());
});

// ============================================================
// CRON — PRUNE DE LOGS (protegido por CRON_SECRET)
// ============================================================

router.get("/__cron/prune-logs", asyncHandler(async (req, res) => {
  const auth = req.headers["authorization"];
  const expected = `Bearer ${process.env.CRON_SECRET}`;
  if (!process.env.CRON_SECRET || auth !== expected) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const days = Number(req.query.days || 7);
  const cutoff = new Date(Date.now() - days * 24 * 3600 * 1000);

  const result = await prisma.auditLog.deleteMany({
    where: { createdAt: { lt: cutoff } },
  });

  log.info("cron.prune_logs", { requestId: req.id, deleted: result.count, cutoff, days });
  res.json({ deleted: result.count, cutoff: cutoff.toISOString(), days });
}));

// ============================================================
// HEALTH
// ============================================================
router.get("/__health/db", asyncHandler(async (req, res) => {
  const expected = process.env.KEEPALIVE_TOKEN;
  if (expected) {
    const provided =
      req.headers["x-keepalive-token"] ||       // ✅ cron-job.org vai usar isso
      (req.headers["authorization"] || "").replace(/^Bearer\s+/i, "") ||
      req.query.token;
    if (provided !== expected) {
      return res.status(401).json({ error: "unauthorized" });
    }
  }
  const result = await keepAlive();
  log[result.ok ? "info" : "error"]("keepalive.ping", { requestId: req.id, ...result });
  res.json(result);
}));

router.get("/", (req, res) => res.json({ ok: true }));

export default router;