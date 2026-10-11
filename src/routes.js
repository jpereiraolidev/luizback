// ============================================================
// routes.js — todas as rotas da API
// ============================================================
import { Router } from "express";
import {
  HTTP,
  prisma,
  CASAL_DATA_KEYS,
  NOTIF_TYPE,
  NOTIF_STATUS,
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
  parseDateOnly,
  dayRange,
} from "./middleware.js";

const router = Router();

// ============================================================
// AUTH
// ============================================================

// POST /auth/register
router.post(
  "/auth/register",
  asyncHandler(async (req, res) => {
    const { email, password, name } = req.body || {};
    if (!isValidEmail(email)) throw badRequest("Email inválido");
    if (!isValidPassword(password)) throw badRequest("Senha deve ter >= 6 caracteres");
    if (!name?.trim()) throw badRequest("Nome é obrigatório");

    const existing = await prisma.user.findUnique({ where: { email: email.toLowerCase().trim() } });
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
  })
);

// POST /auth/login
router.post(
  "/auth/login",
  asyncHandler(async (req, res) => {
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
  })
);

// GET /auth/me
router.get(
  "/auth/me",
  authRequired,
  asyncHandler(async (req, res) => {
    const couple = req.user.coupleId
      ? await prisma.couple.findUnique({
          where: { id: req.user.coupleId },
          include: {
            members: { select: { id: true, name: true, email: true } },
            dependents: { select: { id: true, name: true, birthDate: true, avatar: true } },
          },
        })
      : null;

    res.json({ user: publicUser(req.user), couple });
  })
);

// ============================================================
// COUPLE
// ============================================================

// POST /couple  → cria casal (só se o user ainda não tem)
router.post(
  "/couple",
  authRequired,
  asyncHandler(async (req, res) => {
    if (req.user.coupleId) throw conflict("Você já está em um casal");

    const couple = await prisma.couple.create({
      data: {
        ownerId: req.user.id,
        members: { connect: { id: req.user.id } },
      },
      include: { members: { select: { id: true, name: true, email: true } } },
    });

    res.status(HTTP.CREATED).json({ couple });
  })
);

// GET /couple/me
router.get(
  "/couple/me",
  authRequired,
  requireCouple,
  asyncHandler(async (req, res) => {
    const couple = await prisma.couple.findUnique({
      where: { id: req.user.coupleId },
      include: {
        members: { select: { id: true, name: true, email: true } },
        dependents: true,
      },
    });
    res.json({ couple });
  })
);

// POST /couple/invite  { email }
router.post(
  "/couple/invite",
  authRequired,
  requireCouple,
  asyncHandler(async (req, res) => {
    const { email } = req.body || {};
    if (!isValidEmail(email)) throw badRequest("Email inválido");

    const target = await prisma.user.findUnique({
      where: { email: String(email).toLowerCase().trim() },
    });
    if (!target) throw notFound("Nenhum usuário cadastrado com esse email");
    if (target.id === req.user.id) throw badRequest("Você não pode convidar a si mesmo");
    if (target.coupleId) throw conflict("Esse usuário já está em um casal");

    // Verifica se já existe convite pendente
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
        from: { select: { id: true, name: true, email: true } },
      },
    });

    res.status(HTTP.CREATED).json({ notification: notif });
  })
);

// PUT /couple/prefs  { color?, theme? }
router.put(
  "/couple/prefs",
  authRequired,
  requireCouple,
  asyncHandler(async (req, res) => {
    const { color, theme } = req.body || {};
    const data = {};
    if (color) data.color = color;
    if (theme) data.theme = theme;
    const couple = await prisma.couple.update({
      where: { id: req.user.coupleId },
      data,
    });
    res.json({ couple });
  })
);

// DELETE /couple/leave
router.delete(
  "/couple/leave",
  authRequired,
  requireCouple,
  asyncHandler(async (req, res) => {
    const coupleId = req.user.coupleId;

    await prisma.user.update({
      where: { id: req.user.id },
      data: { coupleId: null },
    });

    const remaining = await prisma.user.count({ where: { coupleId } });
    if (remaining === 0) {
      // Último saiu → cascade apaga dependentes, tasks, data
      await prisma.couple.delete({ where: { id: coupleId } }).catch(() => {});
    }

    res.json({ left: true });
  })
);

// ============================================================
// NOTIFICATIONS
// ============================================================

// GET /notifications?status=PENDING
router.get(
  "/notifications",
  authRequired,
  asyncHandler(async (req, res) => {
    const { status } = req.query;
    const where = { toId: req.user.id };
    if (status) where.status = status;

    const list = await prisma.notification.findMany({
      where,
      orderBy: { createdAt: "desc" },
      include: {
        from: { select: { id: true, name: true, email: true } },
      },
      take: 50,
    });
    res.json(list);
  })
);

// POST /notifications/:id/accept
router.post(
  "/notifications/:id/accept",
  authRequired,
  asyncHandler(async (req, res) => {
    const notif = await prisma.notification.findUnique({ where: { id: req.params.id } });
    if (!notif) throw notFound("Notificação não encontrada");
    if (notif.toId !== req.user.id) throw forbidden("Essa notificação não é sua");
    if (notif.status !== NOTIF_STATUS.PENDING) throw conflict("Notificação não está pendente");

    if (notif.type === NOTIF_TYPE.COUPLE_INVITE) {
      if (req.user.coupleId) throw conflict("Você já está em um casal");
      const coupleId = notif.payload?.coupleId;
      if (!coupleId) throw badRequest("Convite sem coupleId");

      await prisma.$transaction([
        prisma.user.update({
          where: { id: req.user.id },
          data: { coupleId },
        }),
        prisma.notification.update({
          where: { id: notif.id },
          data: { status: NOTIF_STATUS.ACCEPTED },
        }),
      ]);

      res.json({ accepted: true, coupleId });
      return;
    }

    throw badRequest("Tipo de notificação não suportado");
  })
);

// POST /notifications/:id/reject
router.post(
  "/notifications/:id/reject",
  authRequired,
  asyncHandler(async (req, res) => {
    const notif = await prisma.notification.findUnique({ where: { id: req.params.id } });
    if (!notif) throw notFound("Notificação não encontrada");
    if (notif.toId !== req.user.id) throw forbidden("Essa notificação não é sua");
    if (notif.status !== NOTIF_STATUS.PENDING) throw conflict("Notificação não está pendente");

    await prisma.notification.update({
      where: { id: notif.id },
      data: { status: NOTIF_STATUS.REJECTED },
    });
    res.json({ rejected: true });
  })
);

// DELETE /notifications/:id  (só quem enviou pode cancelar)
router.delete(
  "/notifications/:id",
  authRequired,
  asyncHandler(async (req, res) => {
    const notif = await prisma.notification.findUnique({ where: { id: req.params.id } });
    if (!notif) throw notFound("Notificação não encontrada");
    if (notif.fromId !== req.user.id) throw forbidden("Só quem enviou pode cancelar");

    await prisma.notification.update({
      where: { id: notif.id },
      data: { status: NOTIF_STATUS.CANCELLED },
    });
    res.json({ cancelled: true });
  })
);

// ============================================================
// DEPENDENT
// ============================================================

// GET /dependent
router.get(
  "/dependent",
  authRequired,
  requireCouple,
  asyncHandler(async (req, res) => {
    const list = await prisma.dependent.findMany({
      where: { coupleId: req.user.coupleId },
      orderBy: { createdAt: "asc" },
    });
    res.json(list);
  })
);

// POST /dependent  { name, birthDate?, avatar? }
router.post(
  "/dependent",
  authRequired,
  requireCouple,
  asyncHandler(async (req, res) => {
    const { name, birthDate, avatar } = req.body || {};
    if (!name?.trim()) throw badRequest("Nome é obrigatório");

    let birth = null;
    if (birthDate) {
      birth = parseDateOnly(birthDate);
      if (!birth) throw badRequest("birthDate deve ser YYYY-MM-DD");
    }

    const dep = await prisma.dependent.create({
      data: {
        name: name.trim(),
        birthDate: birth,
        avatar: avatar || null,
        coupleId: req.user.coupleId,
      },
    });
    res.status(HTTP.CREATED).json(dep);
  })
);

// GET /dependent/:id
router.get(
  "/dependent/:id",
  authRequired,
  requireCouple,
  asyncHandler(async (req, res) => {
    const dep = await assertDependentBelongsToCouple(req.params.id, req.user.coupleId);
    res.json(dep);
  })
);

// PUT /dependent/:id
router.put(
  "/dependent/:id",
  authRequired,
  requireCouple,
  asyncHandler(async (req, res) => {
    await assertDependentBelongsToCouple(req.params.id, req.user.coupleId);
    const { name, birthDate, avatar } = req.body || {};
    const data = {};
    if (name !== undefined) data.name = String(name).trim();
    if (avatar !== undefined) data.avatar = avatar;
    if (birthDate !== undefined) {
      data.birthDate = birthDate ? parseDateOnly(birthDate) : null;
      if (birthDate && !data.birthDate) throw badRequest("birthDate inválida");
    }
    const dep = await prisma.dependent.update({ where: { id: req.params.id }, data });
    res.json(dep);
  })
);

// DELETE /dependent/:id
router.delete(
  "/dependent/:id",
  authRequired,
  requireCouple,
  asyncHandler(async (req, res) => {
    await assertDependentBelongsToCouple(req.params.id, req.user.coupleId);
    await prisma.dependent.delete({ where: { id: req.params.id } });
    res.json({ deleted: true });
  })
);

// ============================================================
// REGISTROS DO DEPENDENTE — factory pra evitar repetição
// ============================================================
function makeRegistroRoutes(path, modelName, buildCreate, buildUpdate) {
  // CREATE
  router.post(
    path,
    authRequired,
    requireCouple,
    asyncHandler(async (req, res) => {
      const dependentId = req.body?.dependentId;
      await assertDependentBelongsToCouple(dependentId, req.user.coupleId);

      const data = await buildCreate(req.body, req.user);
      const created = await prisma[modelName].create({ data });
      res.status(HTTP.CREATED).json(created);
    })
  );

  // LIST
  router.get(
    path,
    authRequired,
    requireCouple,
    asyncHandler(async (req, res) => {
      const { dependentId, date } = req.query;
      await assertDependentBelongsToCouple(dependentId, req.user.coupleId);

      let where = { dependentId };
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
    })
  );

  // UPDATE
  router.put(
    path,
    authRequired,
    requireCouple,
    asyncHandler(async (req, res) => {
      const { id } = req.query;
      if (!id) throw badRequest("id é obrigatório");

      const existing = await prisma[modelName].findUnique({ where: { id } });
      if (!existing) throw notFound("Registro não encontrado");
      await assertDependentBelongsToCouple(existing.dependentId, req.user.coupleId);

      const data = buildUpdate(req.body);
      const updated = await prisma[modelName].update({ where: { id }, data });
      res.json(updated);
    })
  );

  // DELETE
  router.delete(
    path,
    authRequired,
    requireCouple,
    asyncHandler(async (req, res) => {
      const { id } = req.query;
      if (!id) throw badRequest("id é obrigatório");

      const existing = await prisma[modelName].findUnique({ where: { id } });
      if (!existing) throw notFound("Registro não encontrado");
      await assertDependentBelongsToCouple(existing.dependentId, req.user.coupleId);

      await prisma[modelName].delete({ where: { id } });
      res.json({ deleted: true });
    })
  );
}

// ---------- WATER ----------
makeRegistroRoutes(
  "/water",
  "water",
  async (body) => {
    requireFields(body, ["amount", "timestamp", "date"]);
    const d = parseDateOnly(body.date);
    if (!d) throw badRequest("date inválida");
    if (typeof body.amount !== "number" || body.amount <= 0)
      throw badRequest("amount deve ser número positivo");
    return {
      amount: body.amount,
      reason: body.reason ?? null,
      timestamp: new Date(body.timestamp),
      date: d,
      dependentId: body.dependentId,
    };
  },
  (body) => {
    const data = {};
    if (body.amount !== undefined) data.amount = body.amount;
    if (body.reason !== undefined) data.reason = body.reason;
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
    return {
      size: body.size,
      type: body.type,
      note: body.note ?? null,
      timestamp: new Date(body.timestamp),
      date: d,
      dependentId: body.dependentId,
    };
  },
  (body) => {
    const data = {};
    ["size", "type", "note"].forEach((k) => {
      if (body[k] !== undefined) data[k] = body[k];
    });
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
    return {
      evacuated: !!body.evacuated,
      consistency: body.consistency ?? null,
      pain: Number.isFinite(body.pain) ? body.pain : 0,
      note: body.note ?? null,
      timestamp: new Date(body.timestamp),
      date: d,
      dependentId: body.dependentId,
    };
  },
  (body) => {
    const data = {};
    ["evacuated", "consistency", "pain", "note"].forEach((k) => {
      if (body[k] !== undefined) data[k] = body[k];
    });
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
    return {
      observed: body.observed,
      rule: body.rule ?? null,
      action: body.action ?? null,
      duration: Number.isFinite(body.duration) ? body.duration : null,
      result: body.result ?? null,
      timestamp: new Date(body.timestamp),
      date: d,
      dependentId: body.dependentId,
    };
  },
  (body) => {
    const data = {};
    ["observed", "rule", "action", "duration", "result"].forEach((k) => {
      if (body[k] !== undefined) data[k] = body[k];
    });
    return data;
  }
);

// ============================================================
// SUMMARY (dependente)
// ============================================================
router.get(
  "/summary",
  authRequired,
  requireCouple,
  asyncHandler(async (req, res) => {
    const { dependentId, date } = req.query;
    if (!date) throw badRequest("date é obrigatório");
    await assertDependentBelongsToCouple(dependentId, req.user.coupleId);

    const range = dayRange(date);
    if (!range) throw badRequest("date inválida");

    const where = { dependentId, date: { gte: range.start, lte: range.end } };
    const [water, pee, poop, behavior] = await Promise.all([
      prisma.water.findMany({ where, orderBy: { timestamp: "desc" } }),
      prisma.pee.findMany({ where, orderBy: { timestamp: "desc" } }),
      prisma.poop.findMany({ where, orderBy: { timestamp: "desc" } }),
      prisma.behavior.findMany({ where, orderBy: { timestamp: "desc" } }),
    ]);

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

    const weekWhere = { dependentId, date: { gte: weekStart, lte: weekEnd } };
    const [weekWater, weekPee] = await Promise.all([
      prisma.water.findMany({ where: weekWhere }),
      prisma.pee.findMany({ where: weekWhere }),
    ]);

    const weeklyWater = days.map((d) => {
      const key = d.toISOString().slice(0, 10);
      return weekWater
        .filter((w) => new Date(w.date).toISOString().slice(0, 10) === key)
        .reduce((s, w) => s + w.amount, 0);
    });
    const weeklyPee = days.map((d) => {
      const key = d.toISOString().slice(0, 10);
      return weekPee.filter((p) => new Date(p.date).toISOString().slice(0, 10) === key).length;
    });

    res.json({
      water,
      pee,
      poop,
      behavior,
      weekly: { water: weeklyWater, pee: weeklyPee },
    });
  })
);

// ============================================================
// CASAL — tarefas (CoupleTask)
// ============================================================

router.get(
  "/casal",
  authRequired,
  requireCouple,
  asyncHandler(async (req, res) => {
    const { done } = req.query;
    const where = { coupleId: req.user.coupleId };
    if (done === "true") where.done = true;
    if (done === "false") where.done = false;

    const list = await prisma.coupleTask.findMany({
      where,
      orderBy: [{ done: "asc" }, { createdAt: "desc" }],
    });
    res.json(list);
  })
);

router.post(
  "/casal",
  authRequired,
  requireCouple,
  asyncHandler(async (req, res) => {
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
  })
);

router.put(
  "/casal",
  authRequired,
  requireCouple,
  asyncHandler(async (req, res) => {
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
  })
);

router.delete(
  "/casal",
  authRequired,
  requireCouple,
  asyncHandler(async (req, res) => {
    const { id } = req.query;
    if (!id) throw badRequest("id é obrigatório");

    const existing = await prisma.coupleTask.findUnique({ where: { id } });
    if (!existing || existing.coupleId !== req.user.coupleId)
      throw notFound("Tarefa não encontrada");

    await prisma.coupleTask.delete({ where: { id } });
    res.json({ deleted: true });
  })
);

// ============================================================
// CASAL — dados genéricos (CoupleData)
// ============================================================

router.get(
  "/casal/data",
  authRequired,
  requireCouple,
  asyncHandler(async (req, res) => {
    const { key } = req.query;
    if (!key) throw badRequest("key é obrigatória");
    if (!CASAL_DATA_KEYS.includes(key)) throw badRequest(`key inválida: ${key}`);

    const row = await prisma.coupleData.findUnique({
      where: { coupleId_key: { coupleId: req.user.coupleId, key } },
    });

    res.json({
      key,
      value: row ? JSON.parse(row.value) : null,
    });
  })
);

router.put(
  "/casal/data",
  authRequired,
  requireCouple,
  asyncHandler(async (req, res) => {
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
  })
);

// ============================================================
// HEALTH
// ============================================================
router.get("/", (req, res) => res.json({ ok: true }));

export default router;