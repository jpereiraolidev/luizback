// ============================================================
// api/index.js — App Express + Prisma (produção Vercel)
// Exporta o app para a Vercel como serverless function
// ============================================================

import express from "express";
import { PrismaClient } from "@prisma/client";

// ------------------------------------------------------------
// Prisma singleton (evita múltiplas conexões em serverless)
// ------------------------------------------------------------
const globalForPrisma = globalThis;
const prisma =
  globalForPrisma.prisma ||
  new PrismaClient({ log: ["error", "warn"] });
if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

// ------------------------------------------------------------
// App Express
// ------------------------------------------------------------
const app = express();
app.use(express.json());

// CORS
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ------------------------------------------------------------
// Health check
// ------------------------------------------------------------
app.get("/", async (req, res) => {
  try {
    const waterRows = await prisma.water.count();
    res.json({
      ok: true,
      service: "luizback",
      db: "connected",
      waterRows,
      ts: new Date().toISOString(),
    });
  } catch (e) {
    console.error("Health check erro:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ------------------------------------------------------------
// WATER — CRUD
// ------------------------------------------------------------
app.post("/water", async (req, res) => {
  try {
    const { amount, reason, timestamp, date } = req.body;
    if (!amount || !timestamp || !date)
      return res.status(400).json({ error: "Campos obrigatórios: amount, timestamp, date" });

    const created = await prisma.water.create({
      data: {
        amount: Number(amount),
        reason: reason || null,
        timestamp: new Date(timestamp),
        date: new Date(date),
      },
    });
    res.status(201).json(created);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/water", async (req, res) => {
  try {
    const { date, id } = req.query;
    if (id) {
      const item = await prisma.water.findUnique({ where: { id } });
      if (!item) return res.status(404).json({ error: "Não encontrado" });
      return res.json(item);
    }
    if (!date) return res.status(400).json({ error: "Query ?date=YYYY-MM-DD é obrigatória" });

    const items = await prisma.water.findMany({
      where: { date: new Date(date) },
      orderBy: { timestamp: "asc" },
    });
    res.json(items);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put("/water", async (req, res) => {
  try {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: "Query ?id= é obrigatória" });

    const updated = await prisma.water.update({
      where: { id },
      data: {
        amount: req.body.amount !== undefined ? Number(req.body.amount) : undefined,
        reason: req.body.reason,
      },
    });
    res.json(updated);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete("/water", async (req, res) => {
  try {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: "Query ?id= é obrigatória" });

    await prisma.water.delete({ where: { id } });
    res.json({ deleted: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ------------------------------------------------------------
// PEE — CRUD
// ------------------------------------------------------------
app.post("/pee", async (req, res) => {
  try {
    const { size, type, note, timestamp, date } = req.body;
    if (!size || !type || !timestamp || !date)
      return res.status(400).json({ error: "Campos obrigatórios: size, type, timestamp, date" });

    const created = await prisma.pee.create({
      data: {
        size,
        type,
        note: note || null,
        timestamp: new Date(timestamp),
        date: new Date(date),
      },
    });
    res.status(201).json(created);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/pee", async (req, res) => {
  try {
    const { date, id } = req.query;
    if (id) {
      const item = await prisma.pee.findUnique({ where: { id } });
      if (!item) return res.status(404).json({ error: "Não encontrado" });
      return res.json(item);
    }
    if (!date) return res.status(400).json({ error: "Query ?date=YYYY-MM-DD é obrigatória" });

    const items = await prisma.pee.findMany({
      where: { date: new Date(date) },
      orderBy: { timestamp: "asc" },
    });
    res.json(items);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put("/pee", async (req, res) => {
  try {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: "Query ?id= é obrigatória" });

    const updated = await prisma.pee.update({
      where: { id },
      data: {
        size: req.body.size,
        type: req.body.type,
        note: req.body.note,
      },
    });
    res.json(updated);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete("/pee", async (req, res) => {
  try {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: "Query ?id= é obrigatória" });

    await prisma.pee.delete({ where: { id } });
    res.json({ deleted: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ------------------------------------------------------------
// POOP — CRUD
// ------------------------------------------------------------
app.post("/poop", async (req, res) => {
  try {
    const { evacuated, consistency, pain, note, timestamp, date } = req.body;
    if (typeof evacuated !== "boolean" || !timestamp || !date)
      return res.status(400).json({ error: "Campos obrigatórios: evacuated (boolean), timestamp, date" });

    const created = await prisma.poop.create({
      data: {
        evacuated,
        consistency: consistency || null,
        pain: Number(pain) || 0,
        note: note || null,
        timestamp: new Date(timestamp),
        date: new Date(date),
      },
    });
    res.status(201).json(created);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/poop", async (req, res) => {
  try {
    const { date, id } = req.query;
    if (id) {
      const item = await prisma.poop.findUnique({ where: { id } });
      if (!item) return res.status(404).json({ error: "Não encontrado" });
      return res.json(item);
    }
    if (!date) return res.status(400).json({ error: "Query ?date=YYYY-MM-DD é obrigatória" });

    const items = await prisma.poop.findMany({
      where: { date: new Date(date) },
      orderBy: { timestamp: "asc" },
    });
    res.json(items);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put("/poop", async (req, res) => {
  try {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: "Query ?id= é obrigatória" });

    const updated = await prisma.poop.update({
      where: { id },
      data: {
        evacuated: req.body.evacuated,
        consistency: req.body.consistency,
        pain: req.body.pain !== undefined ? Number(req.body.pain) : undefined,
        note: req.body.note,
      },
    });
    res.json(updated);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete("/poop", async (req, res) => {
  try {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: "Query ?id= é obrigatória" });

    await prisma.poop.delete({ where: { id } });
    res.json({ deleted: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ------------------------------------------------------------
// BEHAVIOR — CRUD
// ------------------------------------------------------------
app.post("/behavior", async (req, res) => {
  try {
    const { observed, rule, action, duration, result, timestamp, date } = req.body;
    if (!observed || !timestamp || !date)
      return res.status(400).json({ error: "Campos obrigatórios: observed, timestamp, date" });

    const created = await prisma.behavior.create({
      data: {
        observed,
        rule: rule || null,
        action: action || null,
        duration: duration !== undefined ? Number(duration) : null,
        result: result || null,
        timestamp: new Date(timestamp),
        date: new Date(date),
      },
    });
    res.status(201).json(created);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/behavior", async (req, res) => {
  try {
    const { date, id } = req.query;
    if (id) {
      const item = await prisma.behavior.findUnique({ where: { id } });
      if (!item) return res.status(404).json({ error: "Não encontrado" });
      return res.json(item);
    }
    if (!date) return res.status(400).json({ error: "Query ?date=YYYY-MM-DD é obrigatória" });

    const items = await prisma.behavior.findMany({
      where: { date: new Date(date) },
      orderBy: { timestamp: "asc" },
    });
    res.json(items);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put("/behavior", async (req, res) => {
  try {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: "Query ?id= é obrigatória" });

    const updated = await prisma.behavior.update({
      where: { id },
      data: {
        observed: req.body.observed,
        rule: req.body.rule,
        action: req.body.action,
        duration: req.body.duration !== undefined ? Number(req.body.duration) : undefined,
        result: req.body.result,
      },
    });
    res.json(updated);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete("/behavior", async (req, res) => {
  try {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: "Query ?id= é obrigatória" });

    await prisma.behavior.delete({ where: { id } });
    res.json({ deleted: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ------------------------------------------------------------
// SUMMARY — agregado 7 dias
// ------------------------------------------------------------
app.get("/summary", async (req, res) => {
  try {
    const { date } = req.query;
    if (!date) return res.status(400).json({ error: "Query ?date=YYYY-MM-DD é obrigatória" });

    const d = new Date(date + (date.length === 10 ? "T00:00:00.000Z" : ""));
    if (isNaN(d.getTime())) return res.status(400).json({ error: "Data inválida" });

    const end = new Date(d);
    end.setUTCHours(23, 59, 59, 999);
    const start = new Date(d);
    start.setUTCDate(start.getUTCDate() - 6);
    start.setUTCHours(0, 0, 0, 0);

    const [water, pee, poop, behavior, waterWeek, peeWeek] = await Promise.all([
      prisma.water.findMany({ where: { date: d }, orderBy: { timestamp: "asc" } }),
      prisma.pee.findMany({ where: { date: d }, orderBy: { timestamp: "asc" } }),
      prisma.poop.findMany({ where: { date: d }, orderBy: { timestamp: "asc" } }),
      prisma.behavior.findMany({ where: { date: d }, orderBy: { timestamp: "asc" } }),
      prisma.water.findMany({
        where: { date: { gte: start, lte: end } },
        select: { date: true, amount: true },
      }),
      prisma.pee.findMany({
        where: { date: { gte: start, lte: end } },
        select: { date: true },
      }),
    ]);

    const days = [];
    for (let i = 6; i >= 0; i--) {
      const dd = new Date(d);
      dd.setUTCDate(dd.getUTCDate() - i);
      dd.setUTCHours(0, 0, 0, 0);
      days.push(dd);
    }

    const key = (dt) => new Date(dt).toISOString().slice(0, 10);
    const waterMap = {};
    waterWeek.forEach((w) => (waterMap[key(w.date)] = (waterMap[key(w.date)] || 0) + w.amount));
    const peeMap = {};
    peeWeek.forEach((p) => (peeMap[key(p.date)] = (peeMap[key(p.date)] || 0) + 1));

    res.json({
      date: key(d),
      water,
      pee,
      poop,
      behavior,
      weekly: {
        water: days.map((dd) => waterMap[key(dd)] || 0),
        pee: days.map((dd) => peeMap[key(dd)] || 0),
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ------------------------------------------------------------
// 404
// ------------------------------------------------------------
app.use((req, res) => {
  res.status(404).json({ error: "Rota não encontrada: " + req.path });
});

// ------------------------------------------------------------
// Exporta para a Vercel
// ------------------------------------------------------------
export default app;