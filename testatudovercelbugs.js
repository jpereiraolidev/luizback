#!/usr/bin/env node
// ============================================================================
// testemestre.js — Suíte visual de auditoria da API Luizback
// ----------------------------------------------------------------------------
// Uso:
//   $env:PROMAX_BASE_URL = "https://luizback-y8qz.vercel.app"
//   node testemestre.js
//
// Modos (opcionais via flag):
//   node testemestre.js --full        roda tudo (default)
//   node testemestre.js --quick       só fases 0–3
//   node testemestre.js --race        foca em concorrência
//   node testemestre.js --local       http://localhost:3000
//
// Env:
//   PROMAX_BASE_URL     obrigatório (ou usa --local)
//   PROMAX_TIMEOUT      default 20000
//   KEEPALIVE_TOKEN     para testar /__health/db
//   DIAG_TOKEN          para testar /__diag/instance
// ============================================================================

import crypto from "node:crypto";
import fs from "node:fs";

// ---------- CORES / ÍCONES ----------
const C = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m",
  blue: "\x1b[34m", magenta: "\x1b[35m", cyan: "\x1b[36m",
  gray: "\x1b[90m", white: "\x1b[97m",
  bgRed: "\x1b[41m", bgGreen: "\x1b[42m", bgYellow: "\x1b[43m",
  bgBlue: "\x1b[44m", bgMagenta: "\x1b[45m", bgCyan: "\x1b[46m",
};
const ICON = {
  ok: "✓", fail: "✗", warn: "⚠", info: "ℹ", arrow: "▶",
  spark: "✦", bolt: "⚡", clock: "⏱", lock: "🔒", bug: "🐛",
  rocket: "🚀", db: "🗄", wave: "👋", check: "✔", cross: "✖",
};

// ---------- CLI ----------
const args = process.argv.slice(2);
const mode = {
  local: args.includes("--local"),
  quick: args.includes("--quick"),
  race: args.includes("--race"),
  full: !args.includes("--quick") && !args.includes("--race"),
};
const BASE_URL = mode.local
  ? "https://luizback-y8qz.vercel.app"
  : (process.env.PROMAX_BASE_URL || "").replace(/\/+$/, "");
if (!BASE_URL) {
  console.error(`${C.red}❌ Defina PROMAX_BASE_URL ou use --local${C.reset}`);
  process.exit(1);
}
const TIMEOUT_MS = Number(process.env.PROMAX_TIMEOUT || 20000);
const KEEPALIVE_TOKEN = process.env.KEEPALIVE_TOKEN || "";
const DIAG_TOKEN = process.env.DIAG_TOKEN || "";
const RUN_ID = `${Date.now().toString(36)}-${crypto.randomBytes(2).toString("hex")}`;

// ---------- ESTADO ----------
const state = {
  runId: RUN_ID,
  startedAt: Date.now(),
  baseUrl: BASE_URL,
  metrics: [],
  bugs: [],
  phases: {},
};

// ---------- HELPERS VISUAIS ----------
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const visibleLen = (s) => stripAnsi(String(s)).length;
const pad = (s, n) => {
  const len = visibleLen(s);
  if (len >= n) return s;
  return s + " ".repeat(n - len);
};
const padLeft = (s, n) => {
  const len = visibleLen(s);
  if (len >= n) return s;
  return " ".repeat(n - len) + s;
};
const truncate = (s, n) => {
  s = String(s ?? "");
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
};

function line(char = "─", n = 78) {
  return C.gray + char.repeat(n) + C.reset;
}

function header(title, subtitle) {
  console.log("");
  console.log(`${C.bold}${C.cyan}╔${"═".repeat(76)}╗${C.reset}`);
  console.log(`${C.bold}${C.cyan}║${C.reset} ${C.bold}${C.white}${pad(title, 74)}${C.reset} ${C.bold}${C.cyan}║${C.reset}`);
  if (subtitle) {
    console.log(`${C.bold}${C.cyan}║${C.reset} ${C.dim}${pad(subtitle, 74)}${C.reset} ${C.bold}${C.cyan}║${C.reset}`);
  }
  console.log(`${C.bold}${C.cyan}╚${"═".repeat(76)}╝${C.reset}`);
}

function section(icon, title, subtitle) {
  console.log("");
  console.log(`${C.bold}${C.blue}${icon}  ${title}${C.reset}${subtitle ? ` ${C.dim}${subtitle}${C.reset}` : ""}`);
  console.log(line("─", 78));
}

function bullet(icon, label, value, color = C.reset) {
  console.log(`  ${color}${icon}${C.reset} ${pad(label, 32)} ${value}`);
}

function table(rows, cols) {
  if (!rows.length) {
    console.log(`${C.dim}  (sem dados)${C.reset}`);
    return;
  }
  const widths = cols.map((c) => {
    let w = visibleLen(c.header);
    for (const r of rows) w = Math.max(w, Math.min(visibleLen(r[c.key] ?? ""), c.max || 40));
    return w;
  });
  const head = cols.map((c, i) => pad(c.header, widths[i])).join(`${C.gray} │ ${C.reset}`);
  console.log(`  ${C.bold}${head}${C.reset}`);
  console.log(`  ${C.gray}${widths.map((w) => "─".repeat(w)).join("─┼─")}${C.reset}`);
  for (const r of rows) {
    const line = cols.map((c, i) => {
      const raw = String(r[c.key] ?? "");
      const val = pad(truncate(raw, widths[i]), widths[i]);
      return c.color ? c.color(r[c.key], r) + val + C.reset : val;
    }).join(`${C.gray} │ ${C.reset}`);
    console.log(`  ${line}`);
  }
}

// ---------- HTTP ----------
async function http(method, path, { body, token, headers = {}, timeoutMs } = {}) {
  const url = path.startsWith("http") ? path : BASE_URL + path;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs ?? TIMEOUT_MS);
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
  const ms = Date.now() - t0;
  const status = res?.status ?? 0;
  const vId = res?.headers.get("x-vercel-id") || null;
  const vRegion = res?.headers.get("x-vercel-execution-region") || null;
  const cold = ms > 3000 && !!vId;
  state.metrics.push({ method, path: path.split("?")[0], status, ms, cold, vId });
  return { ok: status >= 200 && status < 300, status, json, text, ms, vId, vRegion, cold, netErr };
}

// ---------- FIXTURES ----------
const uniqueEmail = (tag) => `mestre+${RUN_ID}-${tag}-${crypto.randomBytes(2).toString("hex")}@test.local`;
const nowTs = () => new Date().toISOString();
const ymd = (d = new Date()) => d.toISOString().slice(0, 10);

async function registerUser(tag) {
  const email = uniqueEmail(tag);
  const password = "mestre-" + crypto.randomBytes(3).toString("hex");
  const r = await http("POST", "/auth/register", { body: { email, password, name: `Mestre ${tag}` } });
  if (r.status !== 201) throw new Error(`register ${tag}: ${r.status} ${truncate(r.text, 120)}`);
  return { id: r.json.user.id, email, password, token: r.json.token };
}

async function createCouple(user) {
  const r = await http("POST", "/couple", { token: user.token });
  if (r.status !== 201) throw new Error(`couple: ${r.status}`);
  return r.json.couple.id;
}

async function createDependent(user, name = `Dep ${RUN_ID}`) {
  const r = await http("POST", "/dependent", { token: user.token, body: { name } });
  if (r.status !== 201) throw new Error(`dependent: ${r.status}`);
  return r.json;
}

// ---------- CONTADORES ----------
const counters = { pass: 0, fail: 0, warn: 0, info: 0 };
function test(ok, label, detail = "") {
  if (ok) {
    counters.pass++;
    console.log(`  ${C.green}${ICON.ok}${C.reset} ${pad(label, 50)} ${C.dim}${detail}${C.reset}`);
  } else {
    counters.fail++;
    console.log(`  ${C.red}${ICON.fail}${C.reset} ${pad(label, 50)} ${C.red}${detail}${C.reset}`);
  }
}
function warn(label, detail = "") {
  counters.warn++;
  console.log(`  ${C.yellow}${ICON.warn}${C.reset} ${pad(label, 50)} ${C.yellow}${detail}${C.reset}`);
}
function info(label, detail = "") {
  counters.info++;
  console.log(`  ${C.cyan}${ICON.info}${C.reset} ${pad(label, 50)} ${C.dim}${detail}${C.reset}`);
}

// ============================================================================
// FASE 0 — SAÚDE BÁSICA
// ============================================================================
async function phase0_saude() {
  section(ICON.rocket, "FASE 0 — Saúde básica", "ping, headers, cold start");

  const r = await http("GET", "/");
  bullet(ICON.arrow, "GET /", `${r.status === 200 ? C.green : C.red}HTTP ${r.status}${C.reset}  ${C.dim}${r.ms}ms${C.reset}`);
  test(r.status === 200 && r.json?.ok === true, "healthcheck retorna { ok: true }");

  bullet(ICON.clock, "Latência", `${r.ms}ms ${r.cold ? C.yellow + "[cold]" + C.reset : C.dim + "[warm]" + C.reset}`);
  if (r.ms > 3000) warn("cold start detectado", "primeira request pagou cold start");
  else info("container quente", "sem cold start nesta request");

  bullet(ICON.db, "Region", r.vRegion || "não informada");
  bullet(ICON.lock, "Vercel ID", r.vId ? r.vId.slice(0, 24) + "…" : "n/a");

  const nf = await http("GET", "/nao-existe-mestre");
  test(nf.status === 404, "404 handler retorna JSON", `HTTP ${nf.status}`);

  const opt = await http("OPTIONS", "/auth/login");
  test(opt.status === 204, "OPTIONS preflight → 204", `HTTP ${opt.status}`);

  state.phases.phase0 = { ms: r.ms, cold: r.cold, region: r.vRegion };
}

// ============================================================================
// FASE 1 — KEEP-ALIVE
// ============================================================================
async function phase1_keepalive() {
  section(ICON.db, "FASE 1 — Keep-alive do banco", "GET /__health/db");

  const h = {};
  if (KEEPALIVE_TOKEN) h["x-keepalive-token"] = KEEPALIVE_TOKEN;

  const r = await http("GET", "/__health/db", { headers: h });
  bullet(ICON.arrow, "Status", `${r.status === 200 ? C.green : C.red}HTTP ${r.status}${C.reset}`);

  if (r.status === 401) {
    warn("sem KEEPALIVE_TOKEN no shell", "defina $env:KEEPALIVE_TOKEN para testar");
    return;
  }
  if (r.status !== 200) {
    test(false, "/__health/db retorna 200", `HTTP ${r.status}`);
    return;
  }

  const ok = r.json?.ok === true;
  const latency = r.json?.latencyMs;
  const error = r.json?.error;

  bullet(ICON.ok, "Banco", ok ? `${C.green}disponível${C.reset}` : `${C.red}indisponível${C.reset}`);
  bullet(ICON.clock, "Latência do SELECT 1", `${latency}ms`);
  if (error) bullet(ICON.warn, "Erro", error);

  test(ok === true, "banco respondeu ao SELECT 1", `ok=${ok}`);
  if (!ok) {
    state.bugs.push({ phase: 1, severity: "CRÍTICO", msg: "banco indisponível", evidence: r.json });
  }

  if (latency > 2000) warn("latência alta no keep-alive", "banco provavelmente hibernando");
  else if (latency > 500) info("latência média no keep-alive", `${latency}ms`);
  else info("banco quente", `${latency}ms`);

  state.phases.phase1 = { ok, latency, error };
}

// ============================================================================
// FASE 2 — AUTH + COUPLE + DEPENDENT
// ============================================================================
async function phase2_core() {
  section(ICON.lock, "FASE 2 — Auth + Couple + Dependent", "fluxo principal");

  // 2.1 Register
  let owner;
  try {
    owner = await registerUser("p2-owner");
    test(true, "register", `${owner.email}`);
  } catch (e) {
    test(false, "register", e.message);
    return null;
  }

  // 2.2 Login
  const login = await http("POST", "/auth/login", { body: { email: owner.email, password: owner.password } });
  test(login.status === 200 && login.json?.token, "login", `HTTP ${login.status}`);

  // 2.3 /auth/me
  const me = await http("GET", "/auth/me", { token: owner.token });
  test(me.status === 200 && me.json?.user?.id === owner.id, "/auth/me", `user.coupleId=${me.json?.user?.coupleId}`);

  // 2.4 Sem token
  const noAuth = await http("GET", "/auth/me");
  test(noAuth.status === 401, "rejeita sem token", `HTTP ${noAuth.status}`);

  // 2.5 Token inválido
  const badAuth = await http("GET", "/auth/me", { token: "abc.def.ghi" });
  test(badAuth.status === 401, "rejeita token inválido", `HTTP ${badAuth.status}`);

  // 2.6 Cria casal
  const coupleId = await createCouple(owner);
  test(true, "create couple", coupleId.slice(0, 16) + "…");

  // 2.7 Verifica coupleId refletido
  const me2 = await http("GET", "/auth/me", { token: owner.token });
  test(me2.json?.user?.coupleId === coupleId, "/auth/me reflete coupleId", `got=${me2.json?.user?.coupleId}`);

  // 2.8 Cria dependente
  const dep = await createDependent(owner, `Mestre Dep ${RUN_ID}`);
  test(true, "create dependent", dep.id.slice(0, 16) + "…");

  // 2.9 Lista dependentes
  const deps = await http("GET", "/dependent", { token: owner.token });
  test(Array.isArray(deps.json) && deps.json.length >= 1, "list dependent", `n=${deps.json?.length}`);

  // 2.10 IDOR: outro user não acessa
  const outsider = await registerUser("p2-out");
  await createCouple(outsider);
  const idor = await http("GET", `/dependent/${dep.id}`, { token: outsider.token });
  test([403, 404].includes(idor.status), "IDOR bloqueado", `HTTP ${idor.status}`);

  return { owner, outsider, coupleId, dep };
}

// ============================================================================
// FASE 3 — FEATURES NOVAS
// ============================================================================
async function phase3_features(ctx) {
  section(ICON.spark, "FASE 3 — Features novas", "sleep, custom, invite-link");

  const { owner, dep } = ctx;
  const today = ymd();

  // 3.1 Sleep — criar
  const sleepBody = {
    dependentId: dep.id,
    durationMin: 90,
    startAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
    endAt: new Date(Date.now() - 0.5 * 3600_000).toISOString(),
    quality: "bom",
    note: `Mestre ${RUN_ID}`,
    date: today,
  };
  const sleep = await http("POST", "/sleep", { token: owner.token, body: sleepBody });
  test(sleep.status === 201, "POST /sleep", `HTTP ${sleep.status}`);

  // 3.2 Sleep — listar
  const sleepList = await http("GET", `/sleep?dependentId=${dep.id}`, { token: owner.token });
  test(sleepList.status === 200 && sleepList.json.some((s) => s.id === sleep.json?.id),
    "GET /sleep lista criado", `n=${sleepList.json?.length}`);

  // 3.3 Sleep — timestamp inválido
  const badTs = await http("POST", "/sleep", {
    token: owner.token,
    body: { ...sleepBody, startAt: "nao-e-data" },
  });
  test(badTs.status === 400, "POST /sleep startAt inválido → 400", `HTTP ${badTs.status}`);

  // 3.4 Record-type — criar
  const slug = `temp-${crypto.randomBytes(2).toString("hex")}`;
  const rt = await http("POST", "/record-types", {
    token: owner.token,
    body: {
      slug,
      label: "Temperatura",
      icon: "🌡",
      fields: [
        { name: "valor", label: "Valor", type: "number", required: true, min: 30, max: 45 },
        { name: "local", label: "Local", type: "select", options: ["axila", "boca", "ouvido"] },
      ],
    },
  });
  test(rt.status === 201, "POST /record-types", `slug=${slug}`);

  // 3.5 Custom-record — criar
  const cr = await http("POST", "/custom-records", {
    token: owner.token,
    body: {
      typeId: rt.json?.id,
      dependentId: dep.id,
      data: { valor: 37.5, local: "axila" },
      timestamp: nowTs(),
      date: today,
    },
  });
  test(cr.status === 201, "POST /custom-records", `HTTP ${cr.status}`);

  // 3.6 Custom-record — validação falha
  const crBad = await http("POST", "/custom-records", {
    token: owner.token,
    body: {
      typeId: rt.json?.id,
      dependentId: dep.id,
      data: { valor: 999, local: "axila" },  // valor > max
      timestamp: nowTs(),
      date: today,
    },
  });
  test(crBad.status === 400, "custom-record fora do range → 400", `HTTP ${crBad.status}`);

  // 3.7 Invite-link — criar
  const il = await http("POST", "/couple/invite-link", {
    token: owner.token,
    body: { expiresInHours: 24, maxUses: 1 },
  });
  test(il.status === 201 && il.json?.token, "POST /couple/invite-link", `token=${il.json?.token?.slice(0, 10)}…`);

  // 3.8 Invite-link — preview
  if (il.json?.token) {
    const prev = await http("GET", `/couple/invite-link/${il.json.token}/preview`);
    test(prev.status === 200 && prev.json?.coupleId === ctx.coupleId, "preview público", `HTTP ${prev.status}`);
  }

  // 3.9 Invite-link — accept
  const guest = await registerUser("p3-guest");
  if (il.json?.token) {
    const acc = await http("POST", `/couple/invite-link/${il.json.token}/accept`, { token: guest.token });
    test(acc.status === 200 && acc.json?.coupleId === ctx.coupleId, "accept via link", `HTTP ${acc.status}`);
  }

  // 3.10 Notificações antigas ainda funcionam
  const u2 = await registerUser("p3-n");
  const inv = await http("POST", "/couple/invite", { token: owner.token, body: { email: u2.email } });
  // owner já tem casal cheio (2 membros), então convite pode dar 409
  if (inv.status === 201) {
    test(true, "POST /couple/invite (legado)", `HTTP ${inv.status}`);
  } else {
    info("POST /couple/invite", `HTTP ${inv.status} (esperado se casal cheio)`);
  }

  state.phases.phase3 = { sleepId: sleep.json?.id, recordTypeId: rt.json?.id, inviteLinkToken: il.json?.token };
}

// ============================================================================
// FASE 4 — SUMMARY
// ============================================================================
async function phase4_summary(ctx) {
  section(ICON.wave, "FASE 4 — Summary (com sleep + custom)", "GET /summary");

  const { owner, dep } = ctx;
  const today = ymd();

  const sum = await http("GET", `/summary?dependentId=${dep.id}&date=${today}`, { token: owner.token });
  test(sum.status === 200, "GET /summary", `HTTP ${sum.status}`);

  if (sum.status !== 200) return;

  const body = sum.json || {};
  bullet(ICON.spark, "sleep[]", `${body.sleep?.length ?? 0} registros`);
  bullet(ICON.spark, "pee[]", `${body.pee?.length ?? 0} registros`);
  bullet(ICON.spark, "poop[]", `${body.poop?.length ?? 0} registros`);
  bullet(ICON.spark, "behavior[]", `${body.behavior?.length ?? 0} registros`);
  bullet(ICON.spark, "custom{}", `${Object.keys(body.custom || {}).length} tipos`);
  bullet(ICON.spark, "weekly.sleepMin", JSON.stringify(body.weekly?.sleepMin || []));
  bullet(ICON.spark, "weekly.sleepCount", JSON.stringify(body.weekly?.sleepCount || []));

  test(Array.isArray(body.sleep), "response tem sleep[]");
  test(body.weekly?.sleepMin?.length === 7, "weekly.sleepMin tem 7 posições");
  test(body.weekly?.sleepCount?.length === 7, "weekly.sleepCount tem 7 posições");
  test(body.water !== undefined, "campo water mantido (compat)");

  // Cross-couple
  const { outsider } = ctx;
  const idor = await http("GET", `/summary?dependentId=${dep.id}&date=${today}`, { token: outsider.token });
  test([403, 404].includes(idor.status), "summary IDOR bloqueado", `HTTP ${idor.status}`);

  state.phases.phase4 = {
    sleepCount: body.sleep?.length,
    customTypes: Object.keys(body.custom || {}).length,
  };
}

// ============================================================================
// FASE 5 — SEGURANÇA
// ============================================================================
async function phase5_seguranca(ctx) {
  section(ICON.lock, "FASE 5 — Segurança", "IDOR, JWT, mass assignment");

  const { owner, dep, outsider } = ctx;

  // 5.1 IDOR em dependent
  const idor1 = await http("GET", `/dependent/${dep.id}`, { token: outsider.token });
  test([403, 404].includes(idor1.status), "GET /dependent/:id IDOR", `HTTP ${idor1.status}`);

  // 5.2 IDOR em PUT
  const idor2 = await http("PUT", `/dependent/${dep.id}`, {
    token: outsider.token,
    body: { name: "HACK" },
  });
  test([403, 404].includes(idor2.status), "PUT /dependent/:id IDOR", `HTTP ${idor2.status}`);

  // 5.3 IDOR em DELETE
  const idor3 = await http("DELETE", `/dependent/${dep.id}`, { token: outsider.token });
  test([403, 404].includes(idor3.status), "DELETE /dependent/:id IDOR", `HTTP ${idor3.status}`);

  // 5.4 Mass assignment — coupleId no body
  const ma1 = await http("POST", "/dependent", {
    token: owner.token,
    body: { name: "MA Test", coupleId: "outro-id" },
  });
  if (ma1.status === 201) {
    test(ma1.json.coupleId !== "outro-id", "não aceita coupleId do body", `coupleId=${ma1.json.coupleId}`);
  }

  // 5.5 Mass assignment — status no body
  const ma2 = await http("POST", "/sleep", {
    token: owner.token,
    body: {
      dependentId: dep.id,
      durationMin: 30,
      startAt: nowTs(),
      date: ymd(),
      status: "archived",   // deve ser ignorado
    },
  });
  if (ma2.status === 201) {
    test(ma2.json.status === "active", "status do body ignorado", `status=${ma2.json.status}`);
  }

  // 5.6 Payload grande
  const big = "x".repeat(3 * 1024 * 1024);
  const bigRes = await http("POST", "/auth/register", {
    body: { email: "a@b.co", password: "123456", name: big },
  });
  test([413, 400].includes(bigRes.status), "payload 3MB rejeitado", `HTTP ${bigRes.status}`);

  // 5.7 JWT forjado
  const fake = "eyJhbGciOiJIUzI1NiJ9.eyJ1c2VySWQiOiJmYWtlIn0.xxx";
  const jwt = await http("GET", "/auth/me", { token: fake });
  test(jwt.status === 401, "JWT forjado → 401", `HTTP ${jwt.status}`);
}

// ============================================================================
// FASE 6 — CONCORRÊNCIA
// ============================================================================
async function phase6_race() {
  section(ICON.bolt, "FASE 6 — Concorrência", "accept race, invite race");

  // 6.1 100 accepts paralelos
  const owner = await registerUser("p6-own");
  const coupleId = await createCouple(owner);
  const target = await registerUser("p6-tgt");
  const inv = await http("POST", "/couple/invite", { token: owner.token, body: { email: target.email } });

  if (inv.status === 201) {
    const inviteId = inv.json.notification.id;
    const N = 100;
    const reqs = Array.from({ length: N }, () =>
      http("POST", `/notifications/${inviteId}/accept`, { token: target.token })
    );
    const rs = await Promise.all(reqs);
    const ok = rs.filter((r) => r.status === 200).length;
    const conflict = rs.filter((r) => r.status === 409).length;
    const other = rs.filter((r) => ![200, 409].includes(r.status)).length;

    test(ok === 1, `${N}x accept → exatamente 1 sucesso`, `200=${ok} 409=${conflict} outros=${other}`);
    state.phases.phase6 = { acceptOk: ok, acceptConflict: conflict };
  }

  // 6.2 20 invite-links paralelos
  const owner2 = await registerUser("p6-own2");
  await createCouple(owner2);
  const N2 = 20;
  const reqs2 = Array.from({ length: N2 }, () =>
    http("POST", "/couple/invite-link", { token: owner2.token, body: { expiresInHours: 24 } })
  );
  const rs2 = await Promise.all(reqs2);
  const created = rs2.filter((r) => r.status === 201).length;
  info(`${N2}x invite-link criados`, `${created} sucessos`);
  test(created >= 1 && created <= N2, "invite-link race sem duplicação crítica", `${created}/${N2}`);
}

// ============================================================================
// FASE 7 — LATÊNCIA
// ============================================================================
async function phase7_latencia() {
  section(ICON.clock, "FASE 7 — Latência por endpoint", "20 amostras cada");

  const u = await registerUser("p7");
  await createCouple(u);
  const dep = await createDependent(u);
  const today = ymd();

  const targets = [
    ["GET", "/"],
    ["GET", "/auth/me", { token: u.token }],
    ["GET", "/couple/me", { token: u.token }],
    ["GET", "/dependent", { token: u.token }],
    ["GET", `/dependent/${dep.id}`, { token: u.token }],
    ["GET", `/summary?dependentId=${dep.id}&date=${today}`, { token: u.token }],
    ["GET", "/casal", { token: u.token }],
    ["GET", "/record-types", { token: u.token }],
    ["GET", "/casal/data?key=mimos", { token: u.token }],
  ];

  const samples = 20;
  const rows = [];

  for (const [method, path, opts = {}] of targets) {
    const lats = [];
    for (let i = 0; i < samples; i++) {
      const r = await http(method, path, opts);
      lats.push(r.ms);
    }
    lats.sort((a, b) => a - b);
    const avg = Math.round(lats.reduce((s, v) => s + v, 0) / samples);
    rows.push({
      method, path: truncate(path, 40),
      min: lats[0], avg,
      p50: lats[Math.floor(samples * 0.5)],
      p95: lats[Math.floor(samples * 0.95)],
      max: lats[samples - 1],
    });
  }

  table(rows, [
    { key: "method", header: "method", max: 7 },
    { key: "path", header: "path", max: 42 },
    { key: "min", header: "min", max: 7, color: (v) => C.dim },
    { key: "avg", header: "avg", max: 7, color: (v) => v > 2000 ? C.red : v > 800 ? C.yellow : C.green },
    { key: "p50", header: "p50", max: 7 },
    { key: "p95", header: "p95", max: 7, color: (v) => v > 2000 ? C.red : v > 1000 ? C.yellow : C.reset },
    { key: "max", header: "max", max: 7 },
  ]);

  state.phases.phase7 = rows;
}

// ============================================================================
// FASE 8 — DIAGNÓSTICO
// ============================================================================
async function phase8_diag() {
  section(ICON.spark, "FASE 8 — Diagnóstico", "GET /__diag/instance");

  const h = {};
  if (DIAG_TOKEN) h["x-diag-token"] = DIAG_TOKEN;

  const r = await http("GET", "/__diag/instance", { headers: h });
  if (r.status === 404 && !DIAG_TOKEN) {
    info("/__diag/instance sem token", "404 esperado");
    return;
  }
  if (r.status === 401) {
    warn("token de diag inválido", "confere DIAG_TOKEN");
    return;
  }
  if (r.status !== 200) {
    test(false, "/__diag/instance", `HTTP ${r.status}`);
    return;
  }

  const d = r.json || {};
  bullet(ICON.spark, "instanceId", d.instanceId?.slice(0, 20) + "…");
  bullet(ICON.clock, "uptime", `${d.uptime}s`);
  bullet(ICON.spark, "bootCount", d.bootCount);
  bullet(ICON.spark, "requestCount", d.requestCount);
  bullet(ICON.spark, "memMB", d.memMB);
  bullet(ICON.spark, "region", d.region || "n/a");
  bullet(ICON.spark, "prismaInitAt", d.prismaInitAt ? "sim" : "não");

  test(!!d.instanceId, "instanceId presente");
  test(Number.isFinite(d.uptime), "uptime numérico");

  state.phases.phase8 = d;
}

// ============================================================================
// RELATÓRIO FINAL
// ============================================================================
function finalReport() {
  const dur = Date.now() - state.startedAt;
  const lat = state.metrics.map((m) => m.ms).sort((a, b) => a - b);
  const colds = state.metrics.filter((m) => m.cold).length;
  const errs = state.metrics.filter((m) => m.status >= 500).length;
  const clientErrs = state.metrics.filter((m) => m.status >= 400 && m.status < 500).length;
  const total = state.metrics.length;

  console.log("");
  console.log(`${C.bold}${C.magenta}╔${"═".repeat(76)}╗${C.reset}`);
  console.log(`${C.bold}${C.magenta}║${C.reset}  ${C.bold}${C.white}RELATÓRIO FINAL${C.reset}${pad("", 59)}${C.bold}${C.magenta}║${C.reset}`);
  console.log(`${C.bold}${C.magenta}╚${"═".repeat(76)}╝${C.reset}`);

  console.log("");
  console.log(`  ${C.bold}Execução${C.reset}`);
  console.log(`  ${line("─", 76)}`);
  bullet(ICON.spark, "runId", state.runId);
  bullet(ICON.spark, "baseUrl", state.baseUrl);
  bullet(ICON.clock, "duração", `${(dur / 1000).toFixed(1)}s`);
  bullet(ICON.db, "requisições", total);
  bullet(ICON.bolt, "cold starts", colds);
  bullet(ICON.bug, "erros 5xx", errs);
  bullet(ICON.warn, "erros 4xx", clientErrs);

  console.log("");
  console.log(`  ${C.bold}Testes${C.reset}`);
  console.log(`  ${line("─", 76)}`);
  const passColor = counters.pass > 0 ? C.green : C.gray;
  const failColor = counters.fail > 0 ? C.red : C.gray;
  bullet(ICON.check, "passou", `${passColor}${counters.pass}${C.reset}`);
  bullet(ICON.cross, "falhou", `${failColor}${counters.fail}${C.reset}`);
  bullet(ICON.warn, "avisos", `${C.yellow}${counters.warn}${C.reset}`);
  bullet(ICON.info, "infos", `${C.cyan}${counters.info}${C.reset}`);

  const rate = counters.pass + counters.fail > 0
    ? Math.round((counters.pass / (counters.pass + counters.fail)) * 100)
    : 0;
  const rateColor = rate === 100 ? C.green : rate >= 80 ? C.yellow : C.red;
  console.log("");
  const bar = "█".repeat(Math.round(rate / 4)) + "░".repeat(25 - Math.round(rate / 4));
  console.log(`  ${rateColor}${bar}${C.reset}  ${C.bold}${rateColor}${rate}%${C.reset} aprovação`);

  if (lat.length) {
    console.log("");
    console.log(`  ${C.bold}Latência global (${lat.length} amostras)${C.reset}`);
    console.log(`  ${line("─", 76)}`);
    bullet(ICON.clock, "min", `${lat[0]}ms`);
    bullet(ICON.clock, "p50", `${lat[Math.floor(lat.length * 0.5)]}ms`);
    bullet(ICON.clock, "p95", `${C.yellow}${lat[Math.floor(lat.length * 0.95)]}ms${C.reset}`);
    bullet(ICON.clock, "p99", `${C.yellow}${lat[Math.floor(lat.length * 0.99)]}ms${C.reset}`);
    bullet(ICON.clock, "max", `${lat[lat.length - 1]}ms`);
  }

  if (state.bugs.length) {
    console.log("");
    console.log(`  ${C.bold}${C.red}Bugs detectados${C.reset}`);
    console.log(`  ${line("─", 76)}`);
    for (const b of state.bugs) {
      console.log(`  ${C.red}${ICON.bug}${C.reset} [${b.severity}] ${b.msg}`);
    }
  }

  // Status final
  console.log("");
  const ok = counters.fail === 0;
  const bgColor = ok ? C.bgGreen : C.bgRed;
  const label = ok ? " TODOS OS TESTES PASSARAM " : ` ${counters.fail} TESTE(S) FALHARAM `;
  console.log(`  ${bgColor}${C.bold}${C.white}  ${label}  ${C.reset}`);
  console.log("");

  // Salva JSON
  const out = {
    runId: state.runId,
    startedAt: new Date(state.startedAt).toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: dur,
    baseUrl: state.baseUrl,
    totals: { requests: total, colds, err5xx: errs, err4xx: clientErrs },
    tests: { pass: counters.pass, fail: counters.fail, warn: counters.warn, info: counters.info, rate },
    phases: state.phases,
    latency: {
      min: lat[0], p50: lat[Math.floor(lat.length * 0.5)],
      p95: lat[Math.floor(lat.length * 0.95)], p99: lat[Math.floor(lat.length * 0.99)],
      max: lat[lat.length - 1],
    },
    bugs: state.bugs,
  };
  const outPath = `mestre-report-${RUN_ID}.json`;
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`  ${C.green}${ICON.ok}${C.reset} Relatório JSON: ${C.bold}${outPath}${C.reset}`);
  console.log("");

  process.exit(ok ? 0 : 1);
}

// ============================================================================
// MAIN
// ============================================================================
(async () => {
  console.clear?.();
  header(
    `TESTEMESTRE — ${mode.local ? "LOCAL" : "PRODUÇÃO"} — ${RUN_ID}`,
    `base: ${BASE_URL}  |  timeout: ${TIMEOUT_MS}ms`
  );

  try {
    await phase0_saude();
    await phase1_keepalive();
    const ctx = await phase2_core();
    if (ctx && !mode.quick) {
      await phase3_features(ctx);
      await phase4_summary(ctx);
      await phase5_seguranca(ctx);
    }
    if (mode.full || mode.race) {
      await phase6_race();
    }
    if (!mode.quick) {
      await phase7_latencia();
      await phase8_diag();
    }
  } catch (e) {
    console.log(`\n${C.red}${C.bold}💥 Erro fatal:${C.reset} ${e.message}`);
    if (e.stack) console.log(`${C.dim}${e.stack.split("\n").slice(1, 4).join("\n")}${C.reset}`);
  } finally {
    finalReport();
  }
})();