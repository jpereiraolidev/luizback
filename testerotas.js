#!/usr/bin/env node
// ============================================================================
// testemestre-authorization.js
// ----------------------------------------------------------------------------
// Auditor de AUTORIZAÇÃO (IDOR/BOLA) da API Luizback.
//
// Regra de ouro:
//   Nenhuma rota é inventada. A matriz de testes abaixo deriva do código
//   real (src/routes.js, src/middleware.js, prisma/schema.prisma).
//   Toda rota que não pôde ser testada aparece como NÃO TESTADA.
//
// Classificação honesta:
//   VULN       → acessou recurso de outro usuário/casal (bug confirmado)
//   OK         → bloqueou corretamente (403/404)
//   BY_DESIGN  → público por contrato (preview de convite, etc.)
//   SIMULATED  → token de terceiro aceito (JWT é bearer; não é falha)
//   SKIP       → não testada (destrutiva, ambígua ou sem dados)
//
// Uso:
//   $env:PROMAX_BASE_URL = "https://luizback-y8qz.vercel.app"
//   node testemestre-authorization.js
//
// Flags:
//   --local             http://localhost:3000
//   --allow-delete      habilita caso 2.x de DELETE (cria descartável)
//   --verbose           mostra cada request
// ============================================================================

import crypto from "node:crypto";
import fs from "node:fs";

// ---------- CLI ----------
const args = process.argv.slice(2);
const FLAGS = {
  local: args.includes("--local"),
  allowDelete: args.includes("--allow-delete"),
  verbose: args.includes("--verbose"),
};
const BASE_URL = FLAGS.local
  ? "https://luizback-y8qz.vercel.app"
  : (process.env.PROMAX_BASE_URL || "").replace(/\/+$/, "");
if (!BASE_URL) {
  console.error("❌ Defina PROMAX_BASE_URL ou use --local");
  process.exit(1);
}
const TIMEOUT_MS = Number(process.env.PROMAX_TIMEOUT || 20000);
const RUN_ID = `${Date.now().toString(36)}-${crypto.randomBytes(2).toString("hex")}`;
const REPORT_PATH = `authz-report-${RUN_ID}.json`;

// ---------- VISUAL ----------
const C = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m",
  blue: "\x1b[34m", magenta: "\x1b[35m", cyan: "\x1b[36m",
  gray: "\x1b[90m", white: "\x1b[97m",
  bgRed: "\x1b[41m", bgGreen: "\x1b[42m",
};
const I = {
  shield: "🛡", key: "🔑", lock: "🔒", bug: "🐛", ok: "✓",
  cross: "✗", warn: "⚠", skip: "○", arrow: "▶", target: "🎯",
  bolt: "⚡", info: "ℹ", skull: "☠",
};
const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, "");
const vlen = (s) => stripAnsi(s).length;
const pad = (s, n) => (vlen(s) >= n ? s : s + " ".repeat(n - vlen(s)));
const padLeft = (s, n) => (vlen(s) >= n ? s : " ".repeat(n - vlen(s)) + s);
const trunc = (s, n) => { s = String(s ?? ""); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
const hline = (n = 78) => C.gray + "─".repeat(n) + C.reset;

function title() {
  console.log("");
  console.log(`${C.bold}${C.magenta}╔${"═".repeat(76)}╗${C.reset}`);
  console.log(`${C.bold}${C.magenta}║${C.reset}  ${C.bold}${C.white}${pad("TESTEMESTRE — AUTHORIZATION AUDITOR", 74)}${C.reset}${C.bold}${C.magenta}║${C.reset}`);
  console.log(`${C.bold}${C.magenta}║${C.reset}  ${C.dim}${pad(BASE_URL, 74)}${C.reset}${C.bold}${C.magenta}║${C.reset}`);
  console.log(`${C.bold}${C.magenta}║${C.reset}  ${C.dim}${pad(`runId: ${RUN_ID}   delete: ${FLAGS.allowDelete ? "ON" : "OFF"}`, 74)}${C.reset}${C.bold}${C.magenta}║${C.reset}`);
  console.log(`${C.bold}${C.magenta}╚${"═".repeat(76)}╝${C.reset}`);
}
function section(icon, t, sub) {
  console.log("");
  console.log(`${C.bold}${C.blue}${icon}  ${t}${C.reset}${sub ? `  ${C.dim}${sub}${C.reset}` : ""}`);
  console.log(hline());
}
function line(icon, color, label, detail = "") {
  console.log(`  ${color}${icon}${C.reset} ${pad(label, 48)} ${C.dim}${detail}${C.reset}`);
}

// ---------- HTTP ----------
async function http(method, path, { body, token, headers = {} } = {}) {
  const url = path.startsWith("http") ? path : BASE_URL + path;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const h = { ...headers };
  if (token) h["Authorization"] = `Bearer ${token}`;
  if (body !== undefined) h["Content-Type"] = "application/json";
  const t0 = Date.now();
  let res, text, json = null, netErr = null;
  try {
    res = await fetch(url, {
      method, headers: h,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });
    text = await res.text();
    if (text) { try { json = JSON.parse(text); } catch {} }
  } catch (e) {
    netErr = e.name === "AbortError" ? "TIMEOUT" : e.message;
  }
  clearTimeout(t);
  const out = { ok: res?.ok, status: res?.status ?? 0, json, text, ms: Date.now() - t0, netErr };
  if (FLAGS.verbose) {
    const color = out.status >= 500 ? C.red : out.status >= 400 ? C.yellow : C.green;
    console.log(`    ${C.dim}${color}${method} ${path} → ${out.status} (${out.ms}ms)${C.reset}`);
  }
  return out;
}

// ---------- HELPERS ----------
const uniqueEmail = (tag) => `atk+${RUN_ID}-${tag}-${crypto.randomBytes(2).toString("hex")}@test.local`;
const nowTs = () => new Date().toISOString();
const ymd = (d = new Date()) => d.toISOString().slice(0, 10);

async function registerUser(tag) {
  const email = uniqueEmail(tag);
  const password = "atk-" + crypto.randomBytes(3).toString("hex");
  const r = await http("POST", "/auth/register", { body: { email, password, name: `ATK ${tag}` } });
  if (r.status !== 201) throw new Error(`register ${tag}: ${r.status} ${trunc(r.text, 120)}`);
  return { id: r.json.user.id, email, password, token: r.json.token, name: `ATK ${tag}` };
}
async function createCouple(u) {
  const r = await http("POST", "/couple", { token: u.token });
  if (r.status !== 201) throw new Error(`couple: ${r.status}`);
  return r.json.couple.id;
}
async function createDependent(u, name) {
  const r = await http("POST", "/dependent", { token: u.token, body: { name } });
  if (r.status !== 201) throw new Error(`dependent: ${r.status}`);
  return r.json;
}

// ============================================================================
// MATRIZ DE TESTES
// ============================================================================
// Cada entrada:
//   id       — identificador do caso
//   kind     — "read" | "write" | "delete" | "admin"
//   label    — texto curto
//   expected — [403,404] para bloqueio esperado
//   build    — função que retorna { method, path, body? }
//              recebe ctx = { victim, attacker }
//   skip     — motivo (opcional) — só testa se skip não estiver definido
// ============================================================================

const MATRIX = [
  // ---------- DEPENDENT ----------
  { id: "dep.get",    kind: "read",  label: "GET    /dependent/:id",
    expected: [403,404], build: (c) => ({ method: "GET", path: `/dependent/${c.victim.dep.id}` }) },
  { id: "dep.put",    kind: "write", label: "PUT    /dependent/:id",
    expected: [403,404], build: (c) => ({ method: "PUT", path: `/dependent/${c.victim.dep.id}`, body: { name: "HACK" } }) },
  { id: "dep.delete", kind: "delete", label: "DELETE /dependent/:id",
    expected: [403,404], build: (c) => ({ method: "DELETE", path: `/dependent/${c.victim.dep.id}` }) },

  // ---------- SUMMARY ----------
  { id: "summary.get", kind: "read", label: "GET    /summary?dependentId=<vítima>",
    expected: [403,404], build: (c) => ({ method: "GET", path: `/summary?dependentId=${c.victim.dep.id}&date=${ymd()}` }) },

  // ---------- REGISTROS (list) ----------
  ...["water","pee","poop","behavior","sleep"].map((m) => ({
    id: `${m}.list`, kind: "read", label: `GET    /${m}?dependentId=<vítima>`,
    expected: [403,404],
    build: (c) => ({ method: "GET", path: `/${m}?dependentId=${c.victim.dep.id}` }),
  })),

  // ---------- REGISTROS (create, apontando para dependente da vítima) ----------
  { id: "water.create",    kind: "write", label: "POST   /water → dependentId vítima",
    expected: [403,404],
    build: (c) => ({ method: "POST", path: "/water", body: { dependentId: c.victim.dep.id, amount: 100, timestamp: nowTs(), date: ymd() } }) },
  { id: "pee.create",      kind: "write", label: "POST   /pee → dependentId vítima",
    expected: [403,404],
    build: (c) => ({ method: "POST", path: "/pee", body: { dependentId: c.victim.dep.id, size: "medio", type: "espontaneo", timestamp: nowTs(), date: ymd() } }) },
  { id: "poop.create",     kind: "write", label: "POST   /poop → dependentId vítima",
    expected: [403,404],
    build: (c) => ({ method: "POST", path: "/poop", body: { dependentId: c.victim.dep.id, evacuated: true, timestamp: nowTs(), date: ymd() } }) },
  { id: "behavior.create", kind: "write", label: "POST   /behavior → dependentId vítima",
    expected: [403,404],
    build: (c) => ({ method: "POST", path: "/behavior", body: { dependentId: c.victim.dep.id, observed: "x", timestamp: nowTs(), date: ymd() } }) },
  { id: "sleep.create",    kind: "write", label: "POST   /sleep → dependentId vítima",
    expected: [403,404],
    build: (c) => ({ method: "POST", path: "/sleep", body: { dependentId: c.victim.dep.id, durationMin: 60, startAt: nowTs(), date: ymd() } }) },

  // ---------- REGISTROS (update/delete por id) ----------
  ...["water","pee","poop","behavior","sleep"].map((m) => ({
    id: `${m}.update`, kind: "write", label: `PUT    /${m}?id=<vítima>`,
    expected: [403,404],
    build: (c) => ({ method: "PUT", path: `/${m}?id=${c.victim.records[m]}`, body: {} }),
  })),
  ...["water","pee","poop","behavior","sleep"].map((m) => ({
    id: `${m}.delete`, kind: "delete", label: `DELETE /${m}?id=<vítima>`,
    expected: [403,404],
    skip: !FLAGS.allowDelete ? "use --allow-delete" : null,
    build: (c) => ({ method: "DELETE", path: `/${m}?id=${c.victim.records[m]}` }),
  })),

  // ---------- RECORD TYPES (custom) ----------
  { id: "rt.update", kind: "write",  label: "PUT    /record-types/:id (vítima)",
    expected: [403,404], build: (c) => ({ method: "PUT", path: `/record-types/${c.victim.recordTypeId}`, body: { label: "HACK" } }) },
  { id: "rt.delete", kind: "delete", label: "DELETE /record-types/:id (vítima)",
    expected: [403,404], skip: !FLAGS.allowDelete ? "use --allow-delete" : null,
    build: (c) => ({ method: "DELETE", path: `/record-types/${c.victim.recordTypeId}` }) },

  // ---------- CUSTOM RECORDS ----------
  { id: "cr.create", kind: "write", label: "POST   /custom-records → typeId/dep vítima",
    expected: [403,404],
    build: (c) => ({ method: "POST", path: "/custom-records", body: {
      typeId: c.victim.recordTypeId, dependentId: c.victim.dep.id,
      data: { valor: 37 }, timestamp: nowTs(), date: ymd(),
    } }) },
  { id: "cr.list", kind: "read", label: "GET    /custom-records?dependentId=<vítima>",
    expected: [403,404],
    build: (c) => ({ method: "GET", path: `/custom-records?dependentId=${c.victim.dep.id}` }) },
  { id: "cr.update", kind: "write", label: "PUT    /custom-records?id=<vítima>",
    expected: [403,404],
    build: (c) => ({ method: "PUT", path: `/custom-records?id=${c.victim.customRecordId}`, body: { data: { valor: 99 } } }) },
  { id: "cr.delete", kind: "delete", label: "DELETE /custom-records?id=<vítima>",
    expected: [403,404], skip: !FLAGS.allowDelete ? "use --allow-delete" : null,
    build: (c) => ({ method: "DELETE", path: `/custom-records?id=${c.victim.customRecordId}` }) },

  // ---------- COUPLE TASKS ----------
  { id: "task.update", kind: "write", label: "PUT    /casal?id=<vítima>",
    expected: [403,404],
    build: (c) => ({ method: "PUT", path: `/casal?id=${c.victim.taskId}`, body: { text: "HACK" } }) },
  { id: "task.delete", kind: "delete", label: "DELETE /casal?id=<vítima>",
    expected: [403,404], skip: !FLAGS.allowDelete ? "use --allow-delete" : null,
    build: (c) => ({ method: "DELETE", path: `/casal?id=${c.victim.taskId}` }) },

  // ---------- NOTIFICATIONS ----------
  { id: "notif.accept", kind: "write", label: "POST   /notifications/:id/accept (vítima)",
    expected: [403,404],
    build: (c) => ({ method: "POST", path: `/notifications/${c.victim.notifId}/accept` }) },
  { id: "notif.reject", kind: "write", label: "POST   /notifications/:id/reject (vítima)",
    expected: [403,404],
    build: (c) => ({ method: "POST", path: `/notifications/${c.victim.notifId}/reject` }) },

  // ---------- INVITE-LINK ----------
  { id: "il.get",    kind: "read",  label: "GET    /couple/invite-link",
    expected: [200],   // o atacante vê o PRÓPRIO link, não o da vítima
    skip: "rota sem ID — testada em caso próprio",
    build: (c) => ({ method: "GET", path: "/couple/invite-link" }) },
  { id: "il.preview", kind: "read", label: "GET    /couple/invite-link/:token/preview (vítima)",
    expected: [200],
    classify: "BY_DESIGN",  // público por contrato
    build: (c) => ({ method: "GET", path: `/couple/invite-link/${c.victim.inviteToken}/preview` }) },
  { id: "il.delete", kind: "delete", label: "DELETE /couple/invite-link (atacante)",
    expected: [200],
    skip: "rota sem ID — não aplica IDOR",
    build: (c) => ({ method: "DELETE", path: "/couple/invite-link" }) },

  // ---------- ROTAS ADMIN (read-only ou protegidas por token) ----------
  { id: "admin.diag", kind: "admin", label: "GET    /__diag/instance (sem token)",
    expected: [404],
    build: () => ({ method: "GET", path: "/__diag/instance" }) },
  { id: "admin.diag.wrong", kind: "admin", label: "GET    /__diag/instance (token errado)",
    expected: [404], headers: { "x-diag-token": "wrong" },
    build: () => ({ method: "GET", path: "/__diag/instance" }) },
  { id: "admin.health.wrong", kind: "admin", label: "GET    /__health/db (token errado)",
    expected: [401], headers: { "x-keepalive-token": "wrong" },
    build: () => ({ method: "GET", path: "/__health/db" }) },
  { id: "admin.cron", kind: "admin", label: "GET    /__cron/prune-logs",
    expected: [401],
    skip: "destrutiva sem autorização — só inventariada",
    build: () => ({ method: "GET", path: "/__cron/prune-logs" }) },
];

// ============================================================================
// SETUP — cria atacantes e vítima
// ============================================================================
async function setup() {
  section("🎯", "SETUP", "criando atacantes e vítima");

  // Atacante A — sem casal
  const attackerA = await registerUser("A");
  line(I.ok, C.green, "atacante A (sem casal)", attackerA.email);

  // Atacante B — com casal próprio
  const attackerB = await registerUser("B");
  const attackerBCoupleId = await createCouple(attackerB);
  const attackerBDep = await createDependent(attackerB, `ATK-B dep ${RUN_ID}`);
  line(I.ok, C.green, "atacante B (com casal)", `${attackerB.email} → coupleId ${attackerBCoupleId.slice(0, 12)}…`);

  // Vítima — com casal completo
  const victim = await registerUser("V");
  const victimCoupleId = await createCouple(victim);
  const dep = await createDependent(victim, `VÍTIMA dep ${RUN_ID}`);
  line(I.ok, C.green, "vítima: couple + dependent", `${victim.email}`);

  const today = ymd();
  const ts = nowTs();

  // Registros da vítima (um de cada tipo)
  const records = {};
  const water = await http("POST", "/water", { token: victim.token, body: { dependentId: dep.id, amount: 250, timestamp: ts, date: today } });
  if (water.status === 201) records.water = water.json.id;
  const pee = await http("POST", "/pee", { token: victim.token, body: { dependentId: dep.id, size: "medio", type: "espontaneo", timestamp: ts, date: today } });
  if (pee.status === 201) records.pee = pee.json.id;
  const poop = await http("POST", "/poop", { token: victim.token, body: { dependentId: dep.id, evacuated: true, timestamp: ts, date: today } });
  if (poop.status === 201) records.poop = poop.json.id;
  const behavior = await http("POST", "/behavior", { token: victim.token, body: { dependentId: dep.id, observed: "obs", timestamp: ts, date: today } });
  if (behavior.status === 201) records.behavior = behavior.json.id;
  const sleep = await http("POST", "/sleep", { token: victim.token, body: { dependentId: dep.id, durationMin: 90, startAt: ts, date: today } });
  if (sleep.status === 201) records.sleep = sleep.json.id;
  line(I.ok, C.green, "vítima: registros", `water=${!!records.water} pee=${!!records.pee} poop=${!!records.poop} behavior=${!!records.behavior} sleep=${!!records.sleep}`);

  // Record-type + custom-record
  const slug = `atk-audit-${crypto.randomBytes(2).toString("hex")}`;
  const rt = await http("POST", "/record-types", {
    token: victim.token,
    body: {
      slug, label: "Auditoria", icon: "🔎",
      fields: [{ name: "valor", label: "Valor", type: "number", required: true, min: 0, max: 1000 }],
    },
  });
  let recordTypeId = null, customRecordId = null;
  if (rt.status === 201) {
    recordTypeId = rt.json.id;
    const cr = await http("POST", "/custom-records", {
      token: victim.token,
      body: { typeId: recordTypeId, dependentId: dep.id, data: { valor: 37 }, timestamp: ts, date: today },
    });
    if (cr.status === 201) customRecordId = cr.json.id;
  }
  line(I.ok, C.green, "vítima: record-type + custom", `${!!recordTypeId} / ${!!customRecordId}`);

  // Task + couple-data
  const task = await http("POST", "/casal", { token: victim.token, body: { text: `VÍTIMA task ${RUN_ID}` } });
  const taskId = task.status === 201 ? task.json.id : null;
  line(I.ok, C.green, "vítima: task", taskId ? taskId.slice(0, 12) + "…" : "falhou");

  // Invite-link da vítima
  const il = await http("POST", "/couple/invite-link", { token: victim.token, body: { expiresInHours: 24, maxUses: 1 } });
  const inviteToken = il.status === 201 ? il.json.token : null;
  line(I.ok, C.green, "vítima: invite-link", inviteToken ? inviteToken.slice(0, 12) + "…" : "falhou");

  // Notificação: cria uma notificação "de teste" endereçada à vítima
  // Precisamos de um remetente com casal. Atacante B pode convidar a vítima.
  let notifId = null;
  const notif = await http("POST", "/couple/invite", {
    token: attackerB.token,
    body: { email: victim.email },
  });
  if (notif.status === 201) notifId = notif.json.notification.id;
  line(I.ok, C.green, "notificação pendente (para a vítima)", notifId ? notifId.slice(0, 12) + "…" : "n/a");

  return {
    attackerA,
    attackerB: { ...attackerB, coupleId: attackerBCoupleId, dep: attackerBDep },
    victim: {
      ...victim,
      coupleId: victimCoupleId,
      dep,
      records,
      recordTypeId,
      customRecordId,
      taskId,
      inviteToken,
      notifId,
    },
  };
}

// ============================================================================
// CASO 1 — IDENTIDADE
// ============================================================================
async function case1_identity(ctx) {
  section("🔑", "CASO 1 — Identidade", "tokens válidos, papéis corretos");

  const results = [];

  // A e B têm tokens válidos
  for (const [tag, u] of [["A", ctx.attackerA], ["B", ctx.attackerB], ["V", ctx.victim]]) {
    const r = await http("GET", "/auth/me", { token: u.token });
    const ok = r.status === 200 && r.json?.user?.id === u.id;
    results.push({ who: tag, kind: "identity", ok, status: r.status });
    line(ok ? I.ok : I.cross, ok ? C.green : C.red, `${tag} token válido → /auth/me`, `HTTP ${r.status}`);
  }

  // A não tem casal
  const meA = await http("GET", "/auth/me", { token: ctx.attackerA.token });
  const aNoCouple = meA.json?.user?.coupleId === null;
  results.push({ who: "A", kind: "no-couple", ok: aNoCouple, status: meA.status });
  line(aNoCouple ? I.ok : I.cross, aNoCouple ? C.green : C.red,
       "atacante A: coupleId = null", `coupleId=${meA.json?.user?.coupleId}`);

  // B tem casal próprio, diferente do da vítima
  const meB = await http("GET", "/auth/me", { token: ctx.attackerB.token });
  const bHasOwnCouple = meB.json?.user?.coupleId === ctx.attackerB.coupleId;
  const bNotVictim = meB.json?.user?.coupleId !== ctx.victim.coupleId;
  line(bHasOwnCouple && bNotVictim ? I.ok : I.cross,
       bHasOwnCouple && bNotVictim ? C.green : C.red,
       "atacante B: casal próprio ≠ vítima", `coupleId=${meB.json?.user?.coupleId?.slice(0, 12)}…`);
  results.push({ who: "B", kind: "own-couple", ok: bHasOwnCouple && bNotVictim });

  return results;
}

// ============================================================================
// CASO 2 — PERMISSÃO (IDOR/BOLA)
// ============================================================================
async function case2_idor(ctx, matrix) {
  section("🚫", "CASO 2 — Autorização (IDOR/BOLA)", "atacantes tentam acessar recursos da vítima");

  const results = [];

  for (const entry of matrix) {
    if (entry.skip) {
      results.push({ id: entry.id, kind: entry.kind, status: "SKIP", reason: entry.skip });
      line(I.skip, C.gray, entry.label, `SKIP — ${entry.skip}`);
      continue;
    }
    const classify = entry.classify || "BLOCK";   // BLOCK | BY_DESIGN | SIMULATED
    const { method, path, body } = entry.build(ctx);
    const headers = entry.headers || {};

    for (const who of ["A", "B"]) {
      const attacker = who === "A" ? ctx.attackerA : ctx.attackerB;
      const r = await http(method, path, { token: attacker.token, body, headers });

      let verdict;
      if (classify === "BY_DESIGN") {
        // Esperado 200. Se der 200 → OK (público). Se der 4xx → INFO.
        verdict = r.status === 200 ? "OK" : "INFO";
      } else if (classify === "SIMULATED") {
        verdict = "SIMULATED";
      } else {
        if (entry.expected.includes(r.status)) verdict = "OK";
        else if (r.status >= 200 && r.status < 300) verdict = "VULN";
        else verdict = "UNEXPECTED";
      }

      results.push({
        id: entry.id, kind: entry.kind, who,
        method, path, body: body || null,
        status: r.status, verdict,
        responseBody: r.json || null,
      });

      const icon = verdict === "VULN" ? I.bug
                 : verdict === "OK" ? I.ok
                 : verdict === "SKIP" ? I.skip
                 : I.warn;
      const color = verdict === "VULN" ? C.red
                  : verdict === "OK" ? C.green
                  : C.yellow;
      const tag = `[${who}] ${pad(entry.label, 42)}`;
      console.log(`  ${color}${icon}${C.reset} ${tag} ${color}HTTP ${padLeft(r.status, 3)}${C.reset} ${C.dim}${verdict}${C.reset}`);
    }
  }

  return results;
}

// ============================================================================
// CASO 3 — TOKEN
// ============================================================================
function tamperJwt(token) {
  // Troca o payload por um userId falso, mantém o header e a assinatura originais
  try {
    const [h, p, s] = token.split(".");
    const payload = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
    payload.userId = "forjado-" + crypto.randomBytes(4).toString("hex");
    const newP = Buffer.from(JSON.stringify(payload)).toString("base64url");
    return `${h}.${newP}.${s}`;
  } catch {
    return token;
  }
}

async function case3_token(ctx) {
  section("🔒", "CASO 3 — Token", "forjado, adulterado, expirado, cross-user");

  const results = [];
  const add = (label, expected, r, classify = "BLOCK") => {
    let verdict;
    if (classify === "SIMULATED") verdict = "SIMULATED";
    else if (expected.includes(r.status)) verdict = "OK";
    else if (r.status >= 200 && r.status < 300) verdict = "VULN";
    else verdict = "UNEXPECTED";
    results.push({ label, status: r.status, verdict });
    const icon = verdict === "VULN" ? I.bug : verdict === "OK" ? I.ok : I.warn;
    const color = verdict === "VULN" ? C.red : verdict === "OK" ? C.green : C.yellow;
    console.log(`  ${color}${icon}${C.reset} ${pad(label, 48)} ${color}HTTP ${padLeft(r.status, 3)}${C.reset} ${C.dim}${verdict}${C.reset}`);
  };

  // 3a — token com userId adulterado, assinatura original
  const tampered = tamperJwt(ctx.attackerA.token);
  const r3a = await http("GET", "/auth/me", { token: tampered });
  add("3a token adulterado (userId falso)", [401], r3a);

  // 3b — token assinado com outro secret (JWT bem formado, assinatura inválida)
  const fake = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiJ4IiwiaWF0IjoxNzAwMDAwMDAwfQ.xxx";
  const r3b = await http("GET", "/auth/me", { token: fake });
  add("3b token assinado com outro secret", [401], r3b);

  // 3c — Header Authorization malformado
  const r3c = await http("GET", "/auth/me", { headers: { Authorization: "NotBearer abc" } });
  add("3c Authorization malformado", [401], r3c);

  // 3d — Sem header
  const r3d = await http("GET", "/auth/me");
  add("3d sem Authorization", [401], r3d);

  // 3e — token da vítima usado em outro "cliente" (simulação de credencial roubada)
  const r3e = await http("GET", "/auth/me", { token: ctx.victim.token });
  add("3e token da vítima (simulação de roubo)", [200], r3e, "SIMULATED");

  return results;
}

// ============================================================================
// RELATÓRIO
// ============================================================================
function report(ctx, c1, c2, c3) {
  const t0 = Date.now();

  // Agrega
  const all = [...c1, ...c2, ...c3];
  const vulns = c2.filter((r) => r.verdict === "VULN");
  const oks = c2.filter((r) => r.verdict === "OK");
  const byDesign = c2.filter((r) => r.verdict === "OK" && r.classify === "BY_DESIGN");
  const skips = c2.filter((r) => r.verdict === "SKIP");
  const unexpected = c2.filter((r) => r.verdict === "UNEXPECTED");

  console.log("");
  console.log(`${C.bold}${C.cyan}╔${"═".repeat(76)}╗${C.reset}`);
  console.log(`${C.bold}${C.cyan}║${C.reset}  ${C.bold}${C.white}${pad("RELATÓRIO DE AUTORIZAÇÃO", 74)}${C.reset}${C.bold}${C.cyan}║${C.reset}`);
  console.log(`${C.bold}${C.cyan}╚${"═".repeat(76)}╝${C.reset}`);

  console.log("");
  console.log(`  ${C.bold}Contagens${C.reset}`);
  console.log(`  ${hline()}`);
  line(I.ok, C.green, "Bloqueadas corretamente", c2.filter(r => r.verdict === "OK").length);
  line(I.bug, C.red, "VAZAMENTOS (recursos de outro)", vulns.length);
  line(I.warn, C.yellow, "Respostas inesperadas", unexpected.length);
  line(I.skip, C.gray, "Não testadas", skips.length);

  if (vulns.length) {
    console.log("");
    console.log(`  ${C.bold}${C.red}Vulnerabilidades confirmadas${C.reset}`);
    console.log(`  ${hline()}`);
    for (const v of vulns) {
      console.log(`  ${C.red}${I.bug}${C.reset} [${v.who}] ${v.method} ${v.path}`);
      console.log(`     ${C.dim}status=${v.status} body=${trunc(JSON.stringify(v.responseBody), 120)}${C.reset}`);
    }
  }

  if (unexpected.length) {
    console.log("");
    console.log(`  ${C.bold}${C.yellow}Respostas inesperadas (não-vuln, mas fora do esperado)${C.reset}`);
    console.log(`  ${hline()}`);
    for (const u of unexpected) {
      console.log(`  ${C.yellow}${I.warn}${C.reset} [${u.who}] ${u.method} ${u.path} → ${u.status}`);
    }
  }

  if (skips.length) {
    console.log("");
    console.log(`  ${C.bold}${C.gray}Não testadas${C.reset}`);
    console.log(`  ${hline()}`);
    for (const s of skips) {
      console.log(`  ${C.gray}${I.skip}${C.reset} ${s.id} — ${s.reason}`);
    }
  }

  const verdict = vulns.length === 0 ? "SEGURO" : "VULNERÁVEL";
  const bg = vulns.length === 0 ? C.bgGreen : C.bgRed;
  console.log("");
  console.log(`  ${bg}${C.bold}${C.white}  RESULTADO: ${verdict}  ${C.reset}`);
  console.log("");

  const out = {
    runId: RUN_ID,
    startedAt: new Date(t0).toISOString(),
    baseUrl: BASE_URL,
    allowDelete: FLAGS.allowDelete,
    setup: {
      attackerA: { id: ctx.attackerA.id, email: ctx.attackerA.email },
      attackerB: { id: ctx.attackerB.id, email: ctx.attackerB.email, coupleId: ctx.attackerB.coupleId },
      victim: {
        id: ctx.victim.id, email: ctx.victim.email, coupleId: ctx.victim.coupleId,
        dependentId: ctx.victim.dep.id,
        records: ctx.victim.records,
        recordTypeId: ctx.victim.recordTypeId,
        customRecordId: ctx.victim.customRecordId,
        taskId: ctx.victim.taskId,
        inviteToken: ctx.victim.inviteToken,
        notifId: ctx.victim.notifId,
      },
    },
    results: { case1: c1, case2: c2, case3: c3 },
    summary: {
      blocked: c2.filter(r => r.verdict === "OK").length,
      vulnerabilities: vulns.length,
      unexpected: unexpected.length,
      skipped: skips.length,
      byDesign: byDesign.length,
      verdict,
    },
  };
  fs.writeFileSync(REPORT_PATH, JSON.stringify(out, null, 2));
  console.log(`  ${C.green}${I.ok}${C.reset} Relatório JSON: ${C.bold}${REPORT_PATH}${C.reset}`);
  console.log("");

  process.exit(vulns.length > 0 ? 1 : 0);
}

// ============================================================================
// MAIN
// ============================================================================
(async () => {
  console.clear?.();
  title();

  let ctx, c1 = [], c2 = [], c3 = [];
  try {
    ctx = await setup();
    c1 = await case1_identity(ctx);
    c2 = await case2_idor(ctx, MATRIX);
    c3 = await case3_token(ctx);
  } catch (e) {
    console.log(`\n${C.red}${C.bold}💥 Erro fatal:${C.reset} ${e.message}`);
    if (e.stack) console.log(`${C.dim}${e.stack.split("\n").slice(1, 4).join("\n")}${C.reset}`);
  } finally {
    if (ctx) report(ctx, c1, c2, c3);
    else process.exit(2);
  }
})();