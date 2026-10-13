#!/usr/bin/env node
// ============================================================================
// seed.js — Popula a API Luizback com dados reais para testes
// ----------------------------------------------------------------------------
// Uso:
//   $env:PROMAX_BASE_URL = "https://luizback-y8qz.vercel.app"
//   node seed.js
//
// Env:
//   PROMAX_BASE_URL   obrigatório
//   PROMAX_TIMEOUT    default 20000
//   SEED_COUNT        casais (default 3)
//   SEED_DEPENDENTS   dependentes por casal (default 2)
//   SEED_OUT          arquivo de saída (default seed-output.json)
//   SEED_TAG          tag extra no email (default timestamp)
//   SEED_SLEEP        criar registros de sono (default true)
//   SEED_CUSTOM       criar tipo custom + registros (default true)
//   SEED_INVITE       criar link de convite (default true)
//
// Fluxo por casal:
//   1.  Cria owner
//   2.  Cria casal
//   3.  Verifica coupleId no /auth/me
//   4.  Cria partner
//   5.  Convida partner + accept
//   6.  Cria dependentes
//   7.  Para cada dependente: cria pee, poop, behavior, sleep
//   8.  Cria tipo custom + registros custom
//   9.  Cria tarefa + casal/data
//  10.  Gera link de convite (opcional)
//  11.  Testa isolamento (outsider → 403)
// ============================================================================

import fs from "node:fs";
import crypto from "node:crypto";

// ---------- CONFIG ----------
const BASE_URL = (process.env.PROMAX_BASE_URL || "https://luizback-y8qz.vercel.app").replace(/\/+$/, "");
if (!BASE_URL) {
  console.error("❌ Defina PROMAX_BASE_URL. Ex: https://luizback-y8qz.vercel.app");
  process.exit(1);
}
const TIMEOUT_MS      = Number(process.env.PROMAX_TIMEOUT || 20000);
const SEED_COUNT      = Number(process.env.SEED_COUNT || 3);
const SEED_DEPENDENTS = Number(process.env.SEED_DEPENDENTS || 2);
const SEED_OUT        = process.env.SEED_OUT || "seed-output.json";
const SEED_TAG        = process.env.SEED_TAG || Date.now().toString(36);
const SEED_SLEEP      = process.env.SEED_SLEEP !== "false";
const SEED_CUSTOM     = process.env.SEED_CUSTOM !== "false";
const SEED_INVITE     = process.env.SEED_INVITE !== "false";

const CASAL_DATA_KEYS = ["mimos", "planos", "metas", "checkins"];

// ---------- CORES ----------
const C = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m",
  blue: "\x1b[34m", magenta: "\x1b[35m", cyan: "\x1b[36m",
};

// ---------- MÉTRICAS ----------
const metrics = [];
async function http(label, method, urlPath, { body, token } = {}) {
  const url = BASE_URL + urlPath;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const h = {};
  if (token) h["Authorization"] = `Bearer ${token}`;
  if (body !== undefined) h["Content-Type"] = "application/json";

  const t0 = Date.now();
  let res, text, json = null, networkError = null;
  try {
    res = await fetch(url, {
      method, headers: h,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    text = await res.text();
    if (text) { try { json = JSON.parse(text); } catch {} }
  } catch (e) {
    networkError = e.name === "AbortError" ? "TIMEOUT" : e.message;
  }
  clearTimeout(t);
  const ms = Date.now() - t0;
  const status = res?.status ?? 0;
  const vercelId = res?.headers.get("x-vercel-id") || null;
  const cold = ms > 3000 && !!vercelId;

  metrics.push({ label, method, path: urlPath.split("?")[0], status, ms, cold, networkError });

  const ok = status >= 200 && status < 300;
  const icon = ok ? `${C.green}✓${C.reset}` : `${C.red}✗${C.reset}`;
  const color = ms > 2000 ? C.red : ms > 800 ? C.yellow : C.green;
  const coldMark = cold ? ` ${C.dim}[cold]${C.reset}` : "";
  console.log(`  ${icon} ${color}${String(ms).padStart(5)}ms${C.reset}${coldMark}  ${method.padEnd(6)} ${urlPath.padEnd(50)} → ${status}`);

  return { status, json, text, ms, cold, vercelId, networkError, ok };
}

function must(res, expected, ctx) {
  const exp = Array.isArray(expected) ? expected : [expected];
  if (!exp.includes(res.status)) {
    throw new Error(`${ctx}: esperado ${exp.join("/")}, recebeu ${res.status} — ${String(res.text).slice(0, 160)}`);
  }
  return res;
}

// ---------- HELPERS ----------
function uniqueEmail(tag) {
  return `seed+${SEED_TAG}-${tag}-${crypto.randomBytes(2).toString("hex")}@test.local`;
}
function nowTs() { return new Date().toISOString(); }
function ymd(d = new Date()) { return d.toISOString().slice(0, 10); }
function minutesAgo(m) { return new Date(Date.now() - m * 60000).toISOString(); }

// ---------- FIXTURES ----------
async function registerUser(tag) {
  const email = uniqueEmail(tag);
  const password = "seed-" + crypto.randomBytes(4).toString("hex");
  const name = `SEED ${tag} ${SEED_TAG}`;
  const r = must(await http("register", "POST", "/auth/register", { body: { email, password, name } }), 201, "POST /auth/register");
  return { id: r.json.user.id, email, password, name, token: r.json.token };
}

// ============================================================================
// CRIA DEPENDENTE + REGISTROS
// ============================================================================
async function seedDependent(owner, idx, depIdx) {
  const depName = `DEP ${idx}.${depIdx} ${SEED_TAG}`;
  const depRes = must(
    await http(`dep:create`, "POST", "/dependent", {
      token: owner.token,
      body: { name: depName, birthDate: "2021-06-15" },
    }),
    201, "POST /dependent"
  );
  const dep = depRes.json;
  console.log(`  ${C.dim}dependent: ${dep.id} (${depName})${C.reset}`);

  const today = ymd();
  const ts = nowTs();
  const records = {};

  // ---------- PEE ----------
  const peeRes = must(
    await http(`pee`, "POST", "/pee", {
      token: owner.token,
      body: { size: "medio", type: "espontaneo", note: `seed-${idx}-${depIdx}`, timestamp: ts, date: today, dependentId: dep.id },
    }),
    201, "POST /pee"
  );
  records.pee = peeRes.json.id;

  // ---------- POOP ----------
  const poopRes = must(
    await http(`poop`, "POST", "/poop", {
      token: owner.token,
      body: { evacuated: true, consistency: "normal", pain: 0, timestamp: ts, date: today, dependentId: dep.id },
    }),
    201, "POST /poop"
  );
  records.poop = poopRes.json.id;

  // ---------- BEHAVIOR ----------
  const behRes = must(
    await http(`behavior`, "POST", "/behavior", {
      token: owner.token,
      body: { observed: `obs-${idx}-${depIdx}`, rule: "r", action: "a", duration: 15, result: "ok", timestamp: ts, date: today, dependentId: dep.id },
    }),
    201, "POST /behavior"
  );
  records.behavior = behRes.json.id;

  // ---------- SLEEP (novo) ----------
  if (SEED_SLEEP) {
    const sleepRes = await http(`sleep`, "POST", "/sleep", {
      token: owner.token,
      body: {
        durationMin: 90,
        startAt: minutesAgo(120),
        endAt: minutesAgo(30),
        quality: "bom",
        note: `soneca ${idx}.${depIdx}`,
        timestamp: minutesAgo(120),
        date: today,
        dependentId: dep.id,
      },
    });
    if (sleepRes.status === 201) {
      records.sleep = sleepRes.json.id;
    } else {
      console.log(`  ${C.yellow}⚠ sleep não criado (${sleepRes.status}) — rota pode não existir ainda${C.reset}`);
    }
  }

  // ---------- SUMMARY ----------
  const sum = await http(`summary`, "GET", `/summary?dependentId=${dep.id}&date=${today}`, { token: owner.token });
  if (sum.status === 200) {
    const parts = [];
    if (sum.json?.pee) parts.push(`pee=${sum.json.pee.length}`);
    if (sum.json?.poop) parts.push(`poop=${sum.json.poop.length}`);
    if (sum.json?.behavior) parts.push(`behavior=${sum.json.behavior.length}`);
    if (sum.json?.sleep) parts.push(`sleep=${sum.json.sleep.length}`);
    if (sum.json?.custom) parts.push(`customKeys=${Object.keys(sum.json.custom).length}`);
    console.log(`  ${C.dim}summary: ${parts.join(" ")}${C.reset}`);
  }

  return { id: dep.id, name: dep.name, records };
}

// ============================================================================
// SEED DE UM CASAL COMPLETO
// ============================================================================
async function seedCouple(idx) {
  console.log(`\n${C.bold}${C.blue}▶ Casal #${idx}${C.reset}`);

  // 1) Owner
  const owner = await registerUser(`c${idx}-owner`);
  console.log(`  ${C.dim}owner: ${owner.email}${C.reset}`);

  // 2) Cria casal
  const coupleRes = must(await http("couple:create", "POST", "/couple", { token: owner.token }), 201, "POST /couple");
  const coupleId = coupleRes.json.couple.id;

  // 3) Verifica coupleId no /auth/me
  const me = await http("couple:me", "GET", "/auth/me", { token: owner.token });
  if (me.json?.user?.coupleId !== coupleId) {
    console.log(`  ${C.yellow}⚠ BUG: /auth/me não reflete coupleId (esperado ${coupleId}, got ${me.json?.user?.coupleId})${C.reset}`);
  }

  // 4) Partner
  const partner = await registerUser(`c${idx}-partner`);
  console.log(`  ${C.dim}partner: ${partner.email}${C.reset}`);

  // 5) Convite + accept
  const inv = must(
    await http("invite:create", "POST", "/couple/invite", { token: owner.token, body: { email: partner.email } }),
    201, "POST /couple/invite"
  );
  const inviteId = inv.json.notification.id;
  await http("notif:list", "GET", "/notifications?status=PENDING", { token: partner.token });
  must(
    await http("invite:accept", "POST", `/notifications/${inviteId}/accept`, { token: partner.token }),
    200, "POST /notifications/:id/accept"
  );

  // 6) Dependentes + registros
  const dependents = [];
  for (let d = 1; d <= SEED_DEPENDENTS; d++) {
    const dep = await seedDependent(owner, idx, d);
    dependents.push(dep);
  }

  // 7) Tipo custom (opcional)
  let customType = null;
  if (SEED_CUSTOM) {
    const rtRes = await http("record-type:create", "POST", "/record-types", {
      token: owner.token,
      body: {
        slug: `temperatura-${idx}-${crypto.randomBytes(2).toString("hex")}`,
        label: `Temperatura ${idx}`,
        icon: "🌡️",
        fields: [
          { name: "valor", label: "Valor", type: "number", required: true, min: 30, max: 45 },
          { name: "local", label: "Local", type: "select", options: ["axila", "boca", "ouvido"] },
          { name: "obs", label: "Observação", type: "text" },
        ],
      },
    });
    if (rtRes.status === 201) {
      customType = rtRes.json;
      console.log(`  ${C.dim}record-type: ${customType.id} (${customType.slug})${C.reset}`);
      // cria 1 registro custom para o primeiro dependente
      const crRes = await http("custom-record:create", "POST", "/custom-records", {
        token: owner.token,
        body: {
          typeId: customType.id,
          dependentId: dependents[0].id,
          data: { valor: 37.5, local: "axila", obs: "seed" },
          timestamp: nowTs(),
          date: ymd(),
        },
      });
      if (crRes.status === 201) {
        customType.recordId = crRes.json.id;
        console.log(`  ${C.dim}custom-record: ${crRes.json.id}${C.reset}`);
      }
    } else {
      console.log(`  ${C.yellow}⚠ /record-types não disponível (${rtRes.status})${C.reset}`);
    }
  }

  // 8) Tarefa
  const taskRes = must(
    await http("task:create", "POST", "/casal", { token: owner.token, body: { text: `SEED TASK ${idx} ${SEED_TAG}` } }),
    201, "POST /casal"
  );
  const taskId = taskRes.json.id;

  // 9) Casal data
  await must(
    await http("casaldata:put", "PUT", `/casal/data?key=${CASAL_DATA_KEYS[0]}`, {
      token: owner.token,
      body: { value: { seededBy: SEED_TAG, coupleIdx: idx, at: nowTs() } },
    }),
    200, "PUT /casal/data"
  );

  // 10) Link de convite (opcional)
  let inviteLink = null;
  if (SEED_INVITE) {
    const ilRes = await http("invite-link:create", "POST", "/couple/invite-link", {
      token: owner.token,
      body: { expiresInHours: 24, maxUses: 1 },
    });
    if (ilRes.status === 201) {
      inviteLink = ilRes.json;
      console.log(`  ${C.dim}invite-link: ${inviteLink.token?.slice(0, 12)}… expira ${inviteLink.expiresAt}${C.reset}`);
    } else {
      console.log(`  ${C.yellow}⚠ /couple/invite-link não disponível (${ilRes.status})${C.reset}`);
    }
  }

  // 11) Testa isolamento
  const outsider = await registerUser(`c${idx}-out`);
  must(await http("outsider:couple", "POST", "/couple", { token: outsider.token }), 201, "POST /couple (outsider)");
  const idor = await http("idor:dep", "GET", `/dependent/${dependents[0].id}`, { token: outsider.token });
  if (![403, 404].includes(idor.status)) {
    console.log(`  ${C.red}⚠ CRÍTICO: IDOR — outsider acessou dependente (${idor.status})${C.reset}`);
  }

  return {
    idx,
    owner:   { email: owner.email,   password: owner.password,   token: owner.token,   id: owner.id },
    partner: { email: partner.email, password: partner.password, token: partner.token, id: partner.id },
    outsider:{ email: outsider.email,password: outsider.password,token: outsider.token,id: outsider.id },
    coupleId,
    dependents,
    taskId,
    customType,
    inviteLink,
    casalDataKey: CASAL_DATA_KEYS[0],
  };
}

// ============================================================================
// RELATÓRIO
// ============================================================================
function latencyReport() {
  const byPath = {};
  for (const m of metrics) {
    const k = `${m.method} ${m.path}`;
    (byPath[k] ||= []).push(m.ms);
  }

  console.log(`\n${C.bold}${C.cyan}═══════════════════════════════════════════════════════════════${C.reset}`);
  console.log(`${C.bold}  LATÊNCIA POR ENDPOINT${C.reset}`);
  console.log(`${C.cyan}═══════════════════════════════════════════════════════════════${C.reset}`);
  console.log(`  ${"Endpoint".padEnd(42)} ${"n".padStart(4)} ${"min".padStart(7)} ${"avg".padStart(7)} ${"p95".padStart(7)} ${"max".padStart(7)}`);
  console.log(`  ${"-".repeat(42)} ${"-".repeat(4)} ${"-".repeat(7)} ${"-".repeat(7)} ${"-".repeat(7)} ${"-".repeat(7)}`);

  const rows = Object.entries(byPath).map(([k, arr]) => {
    const sorted = [...arr].sort((a, b) => a - b);
    return {
      k, n: arr.length,
      min: sorted[0],
      max: sorted[sorted.length - 1],
      avg: Math.round(arr.reduce((s, v) => s + v, 0) / arr.length),
      p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))],
    };
  }).sort((a, b) => b.avg - a.avg);

  for (const r of rows) {
    const color = r.avg > 2000 ? C.red : r.avg > 800 ? C.yellow : C.green;
    console.log(`  ${r.k.padEnd(42)} ${String(r.n).padStart(4)} ${color}${String(r.min).padStart(6)}ms${C.reset} ${color}${String(r.avg).padStart(6)}ms${C.reset} ${color}${String(r.p95).padStart(6)}ms${C.reset} ${color}${String(r.max).padStart(6)}ms${C.reset}`);
  }

  const all = metrics.map(m => m.ms).sort((a, b) => a - b);
  const total = all.length;
  const coldCount = metrics.filter(m => m.cold).length;
  const failCount = metrics.filter(m => m.status >= 400 || m.networkError).length;

  console.log(`\n  ${C.bold}Resumo geral${C.reset}`);
  console.log(`    Requisições:  ${total}`);
  console.log(`    Falhas:       ${failCount}`);
  console.log(`    Cold starts:  ${coldCount}`);
  console.log(`    Min:          ${all[0]}ms`);
  console.log(`    Média:        ${Math.round(all.reduce((s, v) => s + v, 0) / total)}ms`);
  console.log(`    p50:          ${all[Math.floor(total * 0.5)]}ms`);
  console.log(`    p95:          ${all[Math.floor(total * 0.95)]}ms`);
  console.log(`    p99:          ${all[Math.floor(total * 0.99)]}ms`);
  console.log(`    Max:          ${all[total - 1]}ms`);
}

// ============================================================================
// MAIN
// ============================================================================
(async () => {
  console.log(`${C.bold}${C.magenta}🌱 SEED — Luizback${C.reset}`);
  console.log(`${C.dim}base: ${BASE_URL}  tag: ${SEED_TAG}  casais: ${SEED_COUNT}  deps/casal: ${SEED_DEPENDENTS}${C.reset}`);
  console.log(`${C.dim}opções: sleep=${SEED_SLEEP} custom=${SEED_CUSTOM} invite=${SEED_INVITE}${C.reset}`);

  const t0 = Date.now();
  const output = {
    runId: SEED_TAG,
    startedAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    options: { SEED_COUNT, SEED_DEPENDENTS, SEED_SLEEP, SEED_CUSTOM, SEED_INVITE },
    couples: [],
  };

  // warmup
  console.log(`\n${C.dim}aquecendo servidor...${C.reset}`);
  try { await http("warmup", "GET", "/"); } catch {}

  // cria casais
  for (let i = 1; i <= SEED_COUNT; i++) {
    try {
      const c = await seedCouple(i);
      output.couples.push(c);
    } catch (e) {
      console.error(`\n  ${C.red}✗ Casal #${i} falhou:${C.reset} ${e.message}`);
      output.couples.push({ idx: i, error: e.message });
    }
  }

  output.finishedAt = new Date().toISOString();
  output.durationMs = Date.now() - t0;
  output.metrics = metrics;

  fs.writeFileSync(SEED_OUT, JSON.stringify(output, null, 2));
  console.log(`\n${C.green}✓ Seed salvo em ${SEED_OUT}${C.reset}`);

  latencyReport();

  console.log(`\n${C.bold}${C.cyan}CONTAS CRIADAS${C.reset}`);
  for (const c of output.couples) {
    if (c.error) { console.log(`  casal #${c.idx}: ${C.red}ERRO — ${c.error}${C.reset}`); continue; }
    console.log(`  casal #${c.idx}`);
    console.log(`    owner:    ${c.owner.email} / ${c.owner.password}`);
    console.log(`    partner:  ${c.partner.email} / ${c.partner.password}`);
    console.log(`    outsider: ${c.outsider.email} / ${c.outsider.password}`);
    console.log(`    coupleId: ${c.coupleId}`);
    console.log(`    deps:     ${c.dependents.map(d => d.id).join(", ")}`);
    if (c.customType)  console.log(`    custom:   ${c.customType.id} (${c.customType.slug})`);
    if (c.inviteLink)  console.log(`    link:     ${c.inviteLink.url || c.inviteLink.token}`);
  }

  console.log(`\n${C.dim}Total: ${output.durationMs}ms${C.reset}\n`);
})();