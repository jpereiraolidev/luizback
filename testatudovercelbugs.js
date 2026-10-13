#!/usr/bin/env node
// ============================================================================
// TESTEMESTRE.JS — Suíte mestra de auditoria da API Luizback
// ----------------------------------------------------------------------------
// Roda com Node 18+. Sem dependências externas.
//
// Uso:
//   $env:PROMAX_BASE_URL = "https://luizback-y8qz.vercel.app"
//   node testemestre.js <modo>
//
// Modos disponíveis:
//   ── FASE 0 — DIAGNÓSTICO ─────────────────────────────────────
//   fase0              Inventário do ambiente (provider, headers, baseline)
//   fase0:baseline     Coleta baseline completo (roda tudo e salva JSON)
//
//   ── FASE 1 — INSTRUMENTAÇÃO ──────────────────────────────────
//   fase1              Detecta fragmentação de instância via /__diag/instance
//   fase1:carga        Mede fragmentação sob carga paralela
//
//   ── FASE 2 — TESTES DE CORREÇÃO ──────────────────────────────
//   fase2:race         Race no accept (100 paralelos)
//   fase2:timestamp    Validação de timestamp (contrato)
//   fase2:pool         Esgotamento de pool sob carga agressiva
//   fase2:singleton    Fragmentação do PrismaClient
//   fase2:integracao   Consistência API ↔ banco (amostragem)
//
//   ── FASE 3 — VALIDAÇÃO ───────────────────────────────────────
//   fase3:persist      Persistência após cold start
//   fase3:latencia     Latência p50/p95/p99 por endpoint
//   fase3:full         Bateria completa de validação
//
//   ── FASE 4 — AUDITORIAS ──────────────────────────────────────
//   fase4:cascade      Audita DELETE /couple/leave e cascade
//   fase4:exclusao     Mapeia rotas destrutivas
//   fase4:front        Simula padrões de leitura do frontend
//
//   ── COMPOSTOS ────────────────────────────────────────────────
//   smoke              Teste rápido (30s)
//   full               Todas as fases (5–10min)
//   audit              fase0 + fase1 + fase4 (diagnóstico puro)
//
// Env:
//   PROMAX_BASE_URL        obrigatório
//   PROMAX_TIMEOUT         default 20000
//   PROMAX_ALLOW_LOCALHOST permitir localhost
//   PROMAX_OUT             diretório de relatórios (default ./promax-reports)
//   DIAG_TOKEN             token do /__diag/instance (opcional)
// ============================================================================

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// ════════════════════════════════════════════════════════════════════════════
// CONFIG
// ════════════════════════════════════════════════════════════════════════════

const RAW_BASE = process.env.PROMAX_BASE_URL || "";
if (!RAW_BASE) {
  console.error("❌ Defina PROMAX_BASE_URL. Ex: https://luizback-y8qz.vercel.app");
  process.exit(1);
}
const BASE_URL = RAW_BASE.replace(/\/+$/, "");
if (/localhost|127\.0\.0\.1/.test(BASE_URL) && process.env.PROMAX_ALLOW_LOCALHOST !== "1") {
  console.error("❌ BASE_URL aponta para localhost. Use PROMAX_ALLOW_LOCALHOST=1 se for intencional.");
  process.exit(1);
}

const TIMEOUT_MS = Number(process.env.PROMAX_TIMEOUT || 20000);
const OUT_DIR = process.env.PROMAX_OUT || "promax-reports";
const DIAG_TOKEN = process.env.DIAG_TOKEN || "";
const RUN_ID = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
const CASAL_DATA_KEYS = ["mimos", "planos", "metas", "checkins"];

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

// ════════════════════════════════════════════════════════════════════════════
// CORES / UTILS
// ════════════════════════════════════════════════════════════════════════════

const C = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m",
  blue: "\x1b[34m", magenta: "\x1b[35m", cyan: "\x1b[36m",
};

const state = {
  runId: RUN_ID,
  startedAt: new Date().toISOString(),
  baseUrl: BASE_URL,
  findings: [],
  metrics: [],
  bugs: [],
  endpoints: {},
  snapshots: {},
};

const created = { users: [], couples: [], dependents: [], records: [], notifs: [], tasks: [] };

const SENSITIVE = /(password|token|authorization|database_url|passwordhash|secret)/i;
function sanitize(obj) {
  if (obj == null) return obj;
  if (typeof obj === "string") return obj.length > 200 ? obj.slice(0, 200) + "…" : obj;
  if (Array.isArray(obj)) return obj.map(sanitize);
  if (typeof obj === "object") {
    const out = {};
    for (const [k, v] of Object.entries(obj)) out[k] = SENSITIVE.test(k) ? "***" : sanitize(v);
    return out;
  }
  return obj;
}
const truncate = (s, n = 200) => { s = String(s ?? ""); return s.length > n ? s.slice(0, n) + "…" : s; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const nowTs = () => new Date().toISOString();
const ymd = (d = new Date()) => d.toISOString().slice(0, 10);
const uniqueEmail = (tag) => `mestre+${RUN_ID}-${tag}-${crypto.randomBytes(2).toString("hex")}@test.local`;

function section(title) {
  console.log(`\n${C.bold}${C.cyan}━━━ ${title} ━━━${C.reset}`);
}
function info(msg) { console.log(`  ${C.dim}${msg}${C.reset}`); }
function ok(msg) { console.log(`  ${C.green}✓${C.reset} ${msg}`); }
function warn(msg) { console.log(`  ${C.yellow}⚠${C.reset} ${msg}`); }
function fail(msg) { console.log(`  ${C.red}✗${C.reset} ${msg}`); }

function finding({ id, phase, title, status, evidence = {}, note = "", fix = "" }) {
  const color = status === "CONFIRMADA" ? C.red
              : status === "DESCARTADA" ? C.green
              : C.yellow;
  console.log(`  ${color}[${status}]${C.reset} ${C.bold}${id}${C.reset} — ${title}`);
  if (note) console.log(`    ${C.dim}${note}${C.reset}`);
  if (fix && status !== "DESCARTADA") console.log(`    ${C.cyan}Fix:${C.reset} ${fix}`);
  state.findings.push({ id, phase, title, status, evidence: sanitize(evidence), note, fix });
  return state.findings[state.findings.length - 1];
}

// ════════════════════════════════════════════════════════════════════════════
// HTTP CLIENT
// ════════════════════════════════════════════════════════════════════════════

async function http(method, urlPath, { body, token, headers = {}, timeoutMs } = {}) {
  const url = urlPath.startsWith("http") ? urlPath : BASE_URL + urlPath;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs ?? TIMEOUT_MS);
  const h = { ...headers };
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
  const cold = res?.headers.get("x-vercel-cold") || null;

  trackEndpoint(method, urlPath, status);
  state.metrics.push({ method, path: urlPath.split("?")[0], status, ms, vercelId, cold, networkError });

  return {
    ok: status >= 200 && status < 300,
    status, json, text, ms, vercelId, cold,
    headers: res ? Object.fromEntries(res.headers) : {},
    networkError,
  };
}

function trackEndpoint(method, urlPath, status) {
  const key = `${method} ${urlPath.split("?")[0]}`;
  const e = (state.endpoints[key] ||= { calls: 0, statuses: {}, latencies: [] });
  e.calls++;
  e.statuses[status] = (e.statuses[status] || 0) + 1;
}

// ════════════════════════════════════════════════════════════════════════════
// FIXTURES
// ════════════════════════════════════════════════════════════════════════════

async function registerUser(tag) {
  const email = uniqueEmail(tag);
  const password = "mestre-" + crypto.randomBytes(4).toString("hex");
  const name = `MESTRE ${tag} ${RUN_ID}`;
  const r = await http("POST", "/auth/register", { body: { email, password, name } });
  if (r.status !== 201) throw new Error(`register ${tag}: ${r.status} ${truncate(r.text)}`);
  const u = { id: r.json.user.id, email, password, name, token: r.json.token };
  created.users.push({ id: u.id, email, password });
  return u;
}

async function createCouple(user) {
  const r = await http("POST", "/couple", { token: user.token });
  if (r.status !== 201) throw new Error(`couple: ${r.status} ${truncate(r.text)}`);
  const coupleId = r.json.couple.id;
  created.couples.push({ id: coupleId, ownerId: user.id });
  return coupleId;
}

async function createDependent(user, name = `MESTRE DEP ${RUN_ID}`) {
  const r = await http("POST", "/dependent", { token: user.token, body: { name } });
  if (r.status !== 201) throw new Error(`dependent: ${r.status} ${truncate(r.text)}`);
  created.dependents.push({ id: r.json.id, coupleId: r.json.coupleId });
  return r.json;
}

async function createRecord(user, dependentId, model, extra = {}) {
  const today = ymd();
  const base = {
    water:    { amount: 100, reason: "mestre", timestamp: nowTs(), date: today },
    pee:      { size: "medio", type: "espontaneo", note: "mestre", timestamp: nowTs(), date: today },
    poop:     { evacuated: true, consistency: "normal", pain: 0, timestamp: nowTs(), date: today },
    behavior: { observed: "mestre", rule: "r", action: "a", duration: 10, result: "ok", timestamp: nowTs(), date: today },
  }[model];
  const r = await http("POST", `/${model}`, {
    token: user.token,
    body: { ...base, ...extra, dependentId },
  });
  if (r.status === 201) created.records.push({ model, id: r.json.id, dependentId });
  return r;
}

// ════════════════════════════════════════════════════════════════════════════
// FASE 0 — DIAGNÓSTICO
// ════════════════════════════════════════════════════════════════════════════

async function fase0_diagnostico() {
  section("FASE 0 — Diagnóstico de ambiente");

  // 0.1 — Ping básico
  const ping = await http("GET", "/");
  if (ping.status === 200) ok(`API online (${ping.ms}ms, vercel-id=${ping.vercelId?.slice(0, 12)})`);
  else fail(`API respondeu ${ping.status}`);

  // 0.2 — Headers de infraestrutura
  info("Headers da infraestrutura:");
  const interesting = ["server", "x-vercel-id", "x-vercel-cache", "x-vercel-cold",
                       "x-vercel-execution-region", "x-matched-path", "cache-control"];
  for (const h of interesting) {
    if (ping.headers?.[h]) info(`  ${h}: ${truncate(ping.headers[h], 80)}`);
  }

  // 0.3 — Descoberta de provider via headers + comportamento
  const region = ping.headers?.["x-vercel-execution-region"] || "?";
  info(`Região de execução: ${region}`);

  // 0.4 — CORS preflight
  const opt = await http("OPTIONS", "/auth/login");
  if (opt.status === 204) ok("Preflight OPTIONS → 204");
  else warn(`Preflight OPTIONS → ${opt.status}`);

  // 0.5 — Rota inexistente
  const nf = await http("GET", "/__mestre_inexistente__");
  if (nf.status === 404 && nf.json?.error) ok("404 JSON correto");
  else warn(`404 handler: ${nf.status}`);

  // 0.6 — Payload grande
  const big = "x".repeat(2.5 * 1024 * 1024);
  const bigRes = await http("POST", "/auth/register", {
    body: { email: "a@b.co", password: "123456", name: big },
    timeoutMs: 30000,
  });
  if ([413, 400].includes(bigRes.status)) ok(`Payload 2.5MB → ${bigRes.status}`);
  else finding({
    id: "F0-01", phase: "0", title: "Payload grande não é rejeitado corretamente",
    status: "CONFIRMADA",
    evidence: { status: bigRes.status, body: truncate(bigRes.text) },
    note: `Esperado 413/400, recebeu ${bigRes.status}`,
    fix: "Verificar express.json limit e limites da Vercel.",
  });

  // 0.7 — Detecta presença do /__diag/instance
  const diag = await http("GET", "/__diag/instance", {
    headers: DIAG_TOKEN ? { "x-diag-token": DIAG_TOKEN } : {},
  });
  if (diag.status === 200 && diag.json?.instanceId) {
    ok(`/__diag/instance disponível — instanceId=${diag.json.instanceId.slice(0, 8)}`);
    state.snapshots.diagAvailable = true;
    state.snapshots.firstInstanceId = diag.json.instanceId;
  } else {
    warn("/__diag/instance não disponível — Fase 1 ficará limitada a x-vercel-id");
    state.snapshots.diagAvailable = false;
  }
}

async function fase0_baseline() {
  section("FASE 0 — Baseline completo");
  info("Este modo cria dados, mede latências e salva tudo em JSON.");
  info("Rode ANTES de qualquer mudança para comparar depois.");

  await fase0_diagnostico();

  // cria 3 casais com dependentes e registros
  const couples = [];
  for (let i = 1; i <= 3; i++) {
    info(`Casal #${i}...`);
    const owner = await registerUser(`c${i}-own`);
    const coupleId = await createCouple(owner);
    const partner = await registerUser(`c${i}-part`);

    const inv = await http("POST", "/couple/invite", { token: owner.token, body: { email: partner.email } });
    if (inv.status === 201) {
      const invId = inv.json.notification.id;
      await http("POST", `/notifications/${invId}/accept`, { token: partner.token });
    }

    const deps = [];
    for (let d = 1; d <= 2; d++) {
      const dep = await createDependent(owner, `DEP ${i}.${d} ${RUN_ID}`);
      deps.push(dep.id);
      for (const m of ["water", "pee", "poop", "behavior"]) {
        await createRecord(owner, dep.id, m);
      }
    }

    await http("POST", "/casal", { token: owner.token, body: { text: `TASK ${i} ${RUN_ID}` } });
    await http("PUT", `/casal/data?key=${CASAL_DATA_KEYS[0]}`, {
      token: owner.token, body: { value: { baseline: RUN_ID, coupleIdx: i } },
    });

    couples.push({ idx: i, owner: { email: owner.email, password: owner.password },
                   coupleId, dependents: deps });
  }

  const out = path.join(OUT_DIR, `baseline-${RUN_ID}.json`);
  fs.writeFileSync(out, JSON.stringify({
    runId: RUN_ID, at: nowTs(), baseUrl: BASE_URL, couples,
    endpoints: state.endpoints, metrics: state.metrics,
  }, null, 2));
  ok(`Baseline salvo em ${out}`);
}

// ════════════════════════════════════════════════════════════════════════════
// FASE 1 — INSTRUMENTAÇÃO
// ════════════════════════════════════════════════════════════════════════════

async function fase1_fragmentacao() {
  section("FASE 1 — Fragmentação de instância");

  const total = 20;
  const reqs = Array.from({ length: total }, () =>
    http("GET", "/__diag/instance", { headers: DIAG_TOKEN ? { "x-diag-token": DIAG_TOKEN } : {} })
  );
  const rs = await Promise.all(reqs);

  const diagOk = rs.filter(r => r.status === 200 && r.json?.instanceId);
  const vercelIds = new Set(rs.map(r => r.vercelId).filter(Boolean));
  const instanceIds = new Set(diagOk.map(r => r.json.instanceId));

  info(`${total} requests paralelos:`);
  info(`  x-vercel-id únicos:  ${vercelIds.size}`);
  info(`  instanceId únicos:   ${diagOk.length ? instanceIds.size : "N/A (rota ausente)"}`);
  info(`  avg latência:        ${Math.round(rs.reduce((s, r) => s + r.ms, 0) / rs.length)}ms`);

  if (diagOk.length > 0) {
    if (instanceIds.size === 1) {
      finding({
        id: "F1-01", phase: "1", title: "Singleton do PrismaClient funciona",
        status: "DESCARTADA",
        evidence: { total, instanceIds: instanceIds.size, vercelIds: vercelIds.size },
        note: `1 instanceId para ${total} requests → container reaproveitado.`,
      });
    } else if (instanceIds.size < total / 2) {
      finding({
        id: "F1-01", phase: "1", title: "Singleton funciona mas fragmentação parcial",
        status: "INCONCLUSIVA",
        evidence: { total, instanceIds: instanceIds.size, vercelIds: vercelIds.size },
        note: `${instanceIds.size} instâncias para ${total} requests.`,
      });
    } else {
      finding({
        id: "F1-01", phase: "1", title: "Fragmentação real de instância",
        status: "CONFIRMADA",
        evidence: { total, instanceIds: instanceIds.size, vercelIds: vercelIds.size },
        note: `${instanceIds.size} instâncias distintas em ${total} requests.`,
        fix: "Aplicar singleton em globalThis (sempre). Dimensionar connection_limit conforme nº de instâncias.",
      });
    }
  } else {
    // sem /__diag/instance, só x-vercel-id como indicador
    finding({
      id: "F1-01", phase: "1", title: "Fragmentação (indicador x-vercel-id)",
      status: vercelIds.size > total / 2 ? "INCONCLUSIVA" : "DESCARTADA",
      evidence: { total, vercelIds: vercelIds.size },
      note: `x-vercel-id é apenas indicador — implementar /__diag/instance para prova.`,
      fix: "Adicionar endpoint /__diag/instance à API.",
    });
  }
}

async function fase1_carga() {
  section("FASE 1 — Fragmentação sob carga");

  const u = await registerUser("f1");
  await createCouple(u);
  const dep = await createDependent(u);

  const total = 50;
  const reqs = Array.from({ length: total }, () =>
    http("GET", `/dependent/${dep.id}`, { token: u.token })
  );
  const rs = await Promise.all(reqs);

  const statuses = {};
  for (const r of rs) statuses[r.status] = (statuses[r.status] || 0) + 1;
  const latencies = rs.map(r => r.ms).sort((a, b) => a - b);
  const p50 = latencies[Math.floor(total * 0.5)];
  const p95 = latencies[Math.floor(total * 0.95)];
  const max = latencies[total - 1];

  info(`${total} requests paralelos a /dependent/:id`);
  info(`  status:  ${JSON.stringify(statuses)}`);
  info(`  p50/p95/max: ${p50}ms / ${p95}ms / ${max}ms`);

  const errors = (statuses[500] || 0) + (statuses[503] || 0) + (statuses[0] || 0);
  if (errors > 0) {
    finding({
      id: "F1-02", phase: "1", title: "Erros sob carga paralela",
      status: "CONFIRMADA",
      evidence: { statuses, p50, p95, max },
      note: `${errors} erros em ${total} requests.`,
      fix: "Investigar pool. Considerar connection_limit adequado.",
    });
  } else {
    finding({
      id: "F1-02", phase: "1", title: "Erros sob carga paralela",
      status: "DESCARTADA",
      evidence: { statuses, p50, p95, max },
      note: `Sem erros. p95=${p95}ms.`,
    });
  }
}

// ════════════════════════════════════════════════════════════════════════════
// FASE 2 — TESTES DE CORREÇÃO
// ════════════════════════════════════════════════════════════════════════════

async function fase2_race() {
  section("FASE 2 — Race no accept (100 paralelos)");

  const owner = await registerUser("f2-race-own");
  await createCouple(owner);
  const target = await registerUser("f2-race-tgt");
  const inv = await http("POST", "/couple/invite", { token: owner.token, body: { email: target.email } });
  if (inv.status !== 201) {
    finding({ id: "F2-01", phase: "2", title: "Race accept", status: "INCONCLUSIVA",
              note: `invite falhou: ${inv.status}` });
    return;
  }
  const inviteId = inv.json.notification.id;

  const N = 100;
  const reqs = Array.from({ length: N }, () =>
    http("POST", `/notifications/${inviteId}/accept`, { token: target.token })
  );
  const rs = await Promise.all(reqs);

  const ok_ = rs.filter(r => r.status === 200).length;
  const conflict = rs.filter(r => r.status === 409).length;
  const other = rs.filter(r => ![200, 409].includes(r.status));

  info(`${N} accepts paralelos: 200=${ok_} 409=${conflict} outros=${other.length}`);

  if (ok_ === 1) {
    finding({
      id: "F2-01", phase: "2", title: "Race no accept",
      status: "DESCARTADA",
      evidence: { total: N, ok: ok_, conflict, other: other.map(r => r.status) },
      note: "Exatamente 1 sucesso — operação atômica.",
    });
  } else {
    finding({
      id: "F2-01", phase: "2", title: "Race no accept",
      status: "CONFIRMADA",
      evidence: { total: N, ok: ok_, conflict, other: other.map(r => r.status) },
      note: `${ok_} accepts bem-sucedidos (esperado 1).`,
      fix: "updateMany({ where: { id, status: PENDING }, data: { status: ACCEPTED } }) dentro de transação + checar count.",
    });
  }
}

async function fase2_timestamp() {
  section("FASE 2 — Validação de timestamp");

  const u = await registerUser("f2-ts");
  await createCouple(u);
  const dep = await createDependent(u);
  const today = ymd();

  const cases = [
    { label: "ISO válido",        value: nowTs() },
    { label: "data simples",      value: "2024-01-01" },
    { label: "unix ms (número)",  value: Date.now() },
    { label: "unix s (número)",   value: Math.floor(Date.now() / 1000) },
    { label: "string inválida",   value: "nao-e-data" },
    { label: "string vazia",      value: "" },
    { label: "null",              value: null },
    { label: "objeto",            value: { foo: "bar" } },
    { label: "array",             value: [1, 2, 3] },
  ];

  for (const model of ["water", "pee", "poop", "behavior"]) {
    info(`\n  ${model}:`);
    for (const c of cases) {
      const body = {
        water:    { amount: 100, date: today, dependentId: dep.id },
        pee:      { size: "medio", type: "espontaneo", date: today, dependentId: dep.id },
        poop:     { evacuated: true, date: today, dependentId: dep.id },
        behavior: { observed: "x", date: today, dependentId: dep.id },
      }[model];
      body.timestamp = c.value;

      const r = await http("POST", `/${model}`, { token: u.token, body });
      const expected = [201, 400, 422];
      if (!expected.includes(r.status)) {
        warn(`    ${c.label.padEnd(20)} → ${r.status} ${C.dim}(inesperado)${C.reset}`);
      } else {
        info(`    ${c.label.padEnd(20)} → ${r.status}`);
      }
      if (r.status === 500) {
        finding({
          id: `F2-02-${model}-${c.label}`, phase: "2",
          title: `Timestamp inválido (${c.label}) → 500 em ${model}`,
          status: "CONFIRMADA",
          evidence: { model, input: c.label, status: r.status, body: truncate(r.text) },
          note: `Esperado 400/422, recebeu 500.`,
          fix: "Validar `new Date(str)` com isNaN antes do Prisma. Retornar 400.",
        });
      }
    }
  }
}

async function fase2_pool() {
  section("FASE 2 — Esgotamento de pool");

  const u = await registerUser("f2-pool");
  await createCouple(u);
  const dep = await createDependent(u);

  const total = 200;
  const burst = 50;
  const statuses = {};
  const latencies = [];

  for (let i = 0; i < total; i += burst) {
    const slice = Math.min(burst, total - i);
    const reqs = Array.from({ length: slice }, () =>
      http("GET", `/dependent/${dep.id}`, { token: u.token })
    );
    const rs = await Promise.all(reqs);
    for (const r of rs) {
      statuses[r.status] = (statuses[r.status] || 0) + 1;
      latencies.push(r.ms);
    }
  }

  latencies.sort((a, b) => a - b);
  const p95 = latencies[Math.floor(latencies.length * 0.95)];
  const p99 = latencies[Math.floor(latencies.length * 0.99)];
  const max = latencies[latencies.length - 1];

  info(`${total} requests em rajadas de ${burst}`);
  info(`  status: ${JSON.stringify(statuses)}`);
  info(`  p95/p99/max: ${p95}ms / ${p99}ms / ${max}ms`);

  const errors = (statuses[500] || 0) + (statuses[503] || 0) + (statuses[0] || 0);
  const rate = errors / total;

  if (rate > 0.01) {
    finding({
      id: "F2-03", phase: "2", title: "Pool esgotado sob carga",
      status: "CONFIRMADA",
      evidence: { total, burst, statuses, p95, p99, max },
      note: `${(rate * 100).toFixed(2)}% de falhas.`,
      fix: "connection_limit=1 + pgbouncer (se provider suportar). Singleton global. Retry no front.",
    });
  } else if (p95 > 3000) {
    finding({
      id: "F2-03", phase: "2", title: "Pool esgotado sob carga",
      status: "INCONCLUSIVA",
      evidence: { p95, p99, max, statuses },
      note: `Sem falhas, mas p95=${p95}ms sugere saturação.`,
    });
  } else {
    finding({
      id: "F2-03", phase: "2", title: "Pool esgotado sob carga",
      status: "DESCARTADA",
      evidence: { p95, p99, max, statuses },
      note: "Sem falhas em 200 requests.",
    });
  }
}

async function fase2_singleton() {
  section("FASE 2 — Fragmentação de PrismaClient");

  // igual a fase1_fragmentacao, mas com mais carga e estatística
  const rounds = 3;
  const perRound = 20;
  const allVercelIds = new Set();
  let diagAvailable = state.snapshots.diagAvailable;
  const allInstanceIds = new Set();

  for (let r = 1; r <= rounds; r++) {
    const reqs = Array.from({ length: perRound }, () =>
      http("GET", "/__diag/instance", { headers: DIAG_TOKEN ? { "x-diag-token": DIAG_TOKEN } : {} })
    );
    const rs = await Promise.all(reqs);
    rs.forEach(x => {
      if (x.vercelId) allVercelIds.add(x.vercelId);
      if (x.json?.instanceId) allInstanceIds.add(x.json.instanceId);
    });
    await sleep(1500);
  }

  info(`${rounds} rounds × ${perRound} requests`);
  info(`  x-vercel-id únicos: ${allVercelIds.size}`);
  info(`  instanceId únicos:  ${diagAvailable ? allInstanceIds.size : "N/A"}`);

  if (diagAvailable && allInstanceIds.size > 1) {
    finding({
      id: "F2-04", phase: "2", title: "Fragmentação de instância",
      status: "CONFIRMADA",
      evidence: { vercelIds: allVercelIds.size, instanceIds: allInstanceIds.size },
      note: `${allInstanceIds.size} instâncias distintas.`,
      fix: "globalThis.prisma sempre (inclusive em produção).",
    });
  } else {
    finding({
      id: "F2-04", phase: "2", title: "Fragmentação de instância",
      status: diagAvailable ? "DESCARTADA" : "INCONCLUSIVA",
      evidence: { vercelIds: allVercelIds.size, instanceIds: allInstanceIds.size },
      note: diagAvailable ? "Instância única." : "Instrumentação ausente.",
      fix: diagAvailable ? "" : "Adicionar /__diag/instance à API.",
    });
  }
}

async function fase2_integracao() {
  section("FASE 2 — Consistência API ↔ banco (amostragem)");

  const u = await registerUser("f2-integ");
  await createCouple(u);
  const dep = await createDependent(u);

  // cria 10 registros variados
  const ids = [];
  for (let i = 0; i < 10; i++) {
    const r = await createRecord(u, dep.id, "water", { amount: 100 + i });
    if (r.status === 201) ids.push({ id: r.json.id, expectedAmount: 100 + i });
  }

  // relê por listagem
  const list = await http("GET", `/water?dependentId=${dep.id}`, { token: u.token });
  const fromApi = new Map((list.json || []).map(x => [x.id, x]));

  let ok_ = 0, missing = 0, divergent = 0;
  for (const { id, expectedAmount } of ids) {
    const got = fromApi.get(id);
    if (!got) { missing++; continue; }
    if (got.amount === expectedAmount) ok_++;
    else divergent++;
  }

  info(`  criados: ${ids.length}`);
  info(`  ok:      ${ok_}`);
  info(`  missing: ${missing}`);
  info(`  diverg:  ${divergent}`);

  if (missing > 0 || divergent > 0) {
    finding({
      id: "F2-05", phase: "2", title: "Divergência API ↔ banco",
      status: "CONFIRMADA",
      evidence: { created: ids.length, ok: ok_, missing, divergent },
      note: `${missing} ausentes, ${divergent} divergentes.`,
      fix: "Investigar leitura. Comparar direto no banco.",
    });
  } else {
    finding({
      id: "F2-05", phase: "2", title: "Divergência API ↔ banco",
      status: "DESCARTADA",
      evidence: { created: ids.length, ok: ok_ },
      note: "Todos os 10 registros consistentes.",
    });
  }
}

// ════════════════════════════════════════════════════════════════════════════
// FASE 3 — VALIDAÇÃO
// ════════════════════════════════════════════════════════════════════════════

async function fase3_persist(waitSec = 0) {
  section(`FASE 3 — Persistência ${waitSec ? `(espera ${waitSec}s)` : "(imediata)"}`);

  const u = await registerUser("f3-persist");
  await createCouple(u);
  const dep = await createDependent(u);
  const today = ymd();

  const records = {};
  for (const m of ["water", "pee", "poop", "behavior"]) {
    const r = await createRecord(u, dep.id, m);
    if (r.status === 201) records[m] = { id: r.json.id, body: r.json };
  }

  if (waitSec > 0) {
    info(`aguardando ${waitSec}s...`);
    await sleep(waitSec * 1000);
  }

  let lost = 0, ok_ = 0;
  for (const [model, rec] of Object.entries(records)) {
    const r = await http("GET", `/${model}?dependentId=${dep.id}`, { token: u.token });
    if (r.status === 200 && Array.isArray(r.json) && r.json.some(x => x.id === rec.id)) {
      ok_++;
    } else {
      lost++;
      finding({
        id: `F3-01-${model}`, phase: "3", title: `Registro ${model} sumiu`,
        status: "CONFIRMADA",
        evidence: { model, id: rec.id, readStatus: r.status },
        note: `Após ${waitSec}s, registro não encontrado.`,
        fix: "Investigar retenção/leitura.",
      });
    }
  }

  if (lost === 0) {
    finding({
      id: "F3-01", phase: "3", title: "Persistência de registros",
      status: "DESCARTADA",
      evidence: { ok: ok_, lost },
      note: `Todos os ${ok_} registros sobreviveram.`,
    });
  }
}

async function fase3_latencia() {
  section("FASE 3 — Latência por endpoint");

  const u = await registerUser("f3-lat");
  await createCouple(u);
  const dep = await createDependent(u);

  const targets = [
    ["GET", "/"],
    ["GET", "/auth/me", { token: u.token }],
    ["GET", "/couple/me", { token: u.token }],
    ["GET", "/dependent", { token: u.token }],
    ["GET", `/dependent/${dep.id}`, { token: u.token }],
    ["GET", `/summary?dependentId=${dep.id}&date=${ymd()}`, { token: u.token }],
    ["GET", "/casal", { token: u.token }],
    ["GET", `/casal/data?key=${CASAL_DATA_KEYS[0]}`, { token: u.token }],
  ];

  const samples = 20;
  const results = [];

  for (const [method, url, opts = {}] of targets) {
    const lats = [];
    for (let i = 0; i < samples; i++) {
      const r = await http(method, url, opts);
      lats.push(r.ms);
    }
    lats.sort((a, b) => a - b);
    const p50 = lats[Math.floor(samples * 0.5)];
    const p95 = lats[Math.floor(samples * 0.95)];
    const p99 = lats[Math.floor(samples * 0.99)];
    const max = lats[samples - 1];
    results.push({ method, url, p50, p95, p99, max });
    const color = p95 > 1000 ? C.red : p95 > 500 ? C.yellow : C.green;
    console.log(`  ${color}${method} ${url.padEnd(45)} p50=${p50} p95=${p95} p99=${p99} max=${max}${C.reset}`);
  }

  const bad = results.filter(r => r.p95 > 1000);
  if (bad.length) {
    finding({
      id: "F3-02", phase: "3", title: "Latência p95 acima de 1s",
      status: "CONFIRMADA",
      evidence: { endpoints: bad },
      note: `${bad.length} endpoints com p95 > 1s.`,
      fix: "Investigar pool, cold start, provider.",
    });
  }
}

async function fase3_full() {
  await fase3_persist(0);
  await fase3_persist(60);
  await fase3_latencia();
}

// ════════════════════════════════════════════════════════════════════════════
// FASE 4 — AUDITORIAS
// ════════════════════════════════════════════════════════════════════════════

async function fase4_cascade() {
  section("FASE 4 — Cascade em DELETE /couple/leave");

  const owner = await registerUser("f4-casc");
  const coupleId = await createCouple(owner);
  const partner = await registerUser("f4-casc-p");
  const inv = await http("POST", "/couple/invite", { token: owner.token, body: { email: partner.email } });
  if (inv.status === 201) {
    await http("POST", `/notifications/${inv.json.notification.id}/accept`, { token: partner.token });
  }
  const dep = await createDependent(owner, `CASCADE ${RUN_ID}`);
  const water = await createRecord(owner, dep.id, "water");

  info(`Antes: dep=${dep.id} water=${water.json?.id}`);
  const before = await http("GET", `/dependent/${dep.id}`, { token: owner.token });
  info(`  GET /dependent/${dep.id} → ${before.status}`);

  // partner sai — dep deve sobreviver
  const leaveP = await http("DELETE", "/couple/leave", { token: partner.token });
  info(`  DELETE /couple/leave (partner) → ${leaveP.status}`);
  const afterP = await http("GET", `/dependent/${dep.id}`, { token: owner.token });
  info(`  GET /dependent/${dep.id} → ${afterP.status}`);

  // owner sai — agora o couple vira órfão e cascade dispara
  const leaveO = await http("DELETE", "/couple/leave", { token: owner.token });
  info(`  DELETE /couple/leave (owner) → ${leaveO.status}`);

  // tenta reler (owner agora está sem casal → requireCouple bloqueia)
  const afterO = await http("GET", `/dependent/${dep.id}`, { token: owner.token });
  info(`  GET /dependent/${dep.id} pós-leave total → ${afterO.status}`);

  if (afterP.status === 200 && afterO.status !== 200) {
    finding({
      id: "F4-01", phase: "4", title: "Cascade em leave",
      status: "CONFIRMADA",
      evidence: {
        before: before.status,
        afterPartnerLeaves: afterP.status,
        afterOwnerLeaves: afterO.status,
      },
      note: "Dependente some quando o último membro sai — cascade confirmado.",
      fix: "Decisão de produto: excluir, soft delete ou transferir. Documentar.",
    });
  } else if (afterP.status === 200 && afterO.status === 403) {
    finding({
      id: "F4-01", phase: "4", title: "Cascade em leave",
      status: "INCONCLUSIVA",
      evidence: { afterPartnerLeaves: afterP.status, afterOwnerLeaves: afterO.status },
      note: "403 pós-leave (requireCouple bloqueia antes de checar cascade). Necessário reentrar em outro casal para confirmar.",
    });
  } else {
    finding({
      id: "F4-01", phase: "4", title: "Cascade em leave",
      status: "DESCARTADA",
      evidence: { before: before.status, afterPartnerLeaves: afterP.status, afterOwnerLeaves: afterO.status },
      note: "Dependente sobreviveu aos dois leaves.",
    });
  }
}

async function fase4_exclusao() {
  section("FASE 4 — Rotas destrutivas");

  const rotas = [
    ["DELETE", "/couple/leave"],
    ["DELETE", "/dependent/:id"],
    ["DELETE", "/water?id="],
    ["DELETE", "/pee?id="],
    ["DELETE", "/poop?id="],
    ["DELETE", "/behavior?id="],
    ["DELETE", "/casal?id="],
    ["DELETE", "/notifications/:id"],
  ];
  info("Rotas destrutivas identificadas no código:");
  for (const [m, r] of rotas) console.log(`    ${m} ${r}`);
  info("Todas exigem authRequired. Cascade relevante: Dependent → Couple, CoupleData/Task/Notification → Couple/User.");
}

async function fase4_front() {
  section("FASE 4 — Simulação de padrões de leitura");

  const u = await registerUser("f4-front");
  await createCouple(u);
  const dep = await createDependent(u);
  await createRecord(u, dep.id, "water");

  // Padrão 1: front chama /summary com data errada
  const wrongDate = await http("GET", `/summary?dependentId=${dep.id}&date=1999-01-01`, { token: u.token });
  info(`  summary data sem dados → ${wrongDate.status} (esperado 200 com arrays vazios)`);
  if (wrongDate.status === 200) {
    const empty = wrongDate.json?.water?.length === 0;
    info(`  retorna arrays vazios: ${empty}`);
    if (!empty) {
      finding({
        id: "F4-02", phase: "4", title: "Summary de dia vazio retorna dados",
        status: "CONFIRMADA",
        evidence: { waterCount: wrongDate.json.water?.length },
        fix: "Verificar filtro por data.",
      });
    }
  }

  // Padrão 2: front usa token velho
  const old = await http("GET", "/auth/me", { token: u.token.slice(0, -3) + "xxx" });
  info(`  token inválido → ${old.status} (front deve tratar como logout, não como "sem dados")`);
  if (old.status === 200) {
    finding({
      id: "F4-03", phase: "4", title: "Token inválido aceito",
      status: "CONFIRMADA",
      evidence: { status: old.status },
      fix: "Revisar verifyToken.",
    });
  }

  // Padrão 3: front chama ID inexistente
  const ghost = await http("GET", `/dependent/naoexiste-${RUN_ID}`, { token: u.token });
  info(`  ID inexistente → ${ghost.status} (front deve mostrar "não encontrado", não "vazio")`);

  finding({
    id: "F4-04", phase: "4", title: "Padrões de leitura documentados",
    status: "INCONCLUSIVA",
    evidence: {
      summaryEmpty: wrongDate.status,
      tokenInvalid: old.status,
      idGhost: ghost.status,
    },
    note: "Verificar no frontend se 500/404 são tratados como dados vazios (fonte do sintoma percebido).",
  });
}

// ════════════════════════════════════════════════════════════════════════════
// RELATÓRIO FINAL
// ════════════════════════════════════════════════════════════════════════════

function finalize() {
  state.finishedAt = new Date().toISOString();
  const durationMs = new Date(state.finishedAt) - new Date(state.startedAt);

  const confirmed = state.findings.filter(f => f.status === "CONFIRMADA");
  const discarded = state.findings.filter(f => f.status === "DESCARTADA");
  const inconclusive = state.findings.filter(f => f.status === "INCONCLUSIVA");

  section("RESUMO FINAL");
  console.log(`  Base URL:     ${BASE_URL}`);
  console.log(`  Duração:      ${durationMs}ms`);
  console.log(`  Endpoints:    ${Object.keys(state.endpoints).length}`);
  console.log(`  Requisições:  ${state.metrics.length}`);
  console.log(`  Findings:     ${state.findings.length}`);
  console.log(`    ${C.red}CONFIRMADAS:   ${confirmed.length}${C.reset}`);
  console.log(`    ${C.green}DESCARTADAS:   ${discarded.length}${C.reset}`);
  console.log(`    ${C.yellow}INCONCLUSIVAS: ${inconclusive.length}${C.reset}`);

  if (confirmed.length) {
    console.log(`\n  ${C.bold}${C.red}CONFIRMADAS:${C.reset}`);
    confirmed.forEach(f => console.log(`    ${C.red}✗${C.reset} ${f.id} — ${f.title}`));
  }
  if (inconclusive.length) {
    console.log(`\n  ${C.bold}${C.yellow}INCONCLUSIVAS:${C.reset}`);
    inconclusive.forEach(f => console.log(`    ${C.yellow}?${C.reset} ${f.id} — ${f.title}`));
  }

  // Latência global
  const lat = state.metrics.map(m => m.ms).sort((a, b) => a - b);
  if (lat.length) {
    console.log(`\n  ${C.bold}Latência global:${C.reset}`);
    console.log(`    min=${lat[0]} p50=${lat[Math.floor(lat.length * 0.5)]} p95=${lat[Math.floor(lat.length * 0.95)]} p99=${lat[Math.floor(lat.length * 0.99)]} max=${lat[lat.length - 1]}`);
  }

  const out = path.join(OUT_DIR, `report-${RUN_ID}.json`);
  fs.writeFileSync(out, JSON.stringify({
    ...state,
    durationMs,
    summary: {
      confirmed: confirmed.length,
      discarded: discarded.length,
      inconclusive: inconclusive.length,
    },
  }, null, 2));
  console.log(`\n  ${C.green}Relatório:${C.reset} ${out}\n`);

  return confirmed.length;
}

// ════════════════════════════════════════════════════════════════════════════
// RUNNER
// ════════════════════════════════════════════════════════════════════════════

const MODES = {
  // Fase 0
  fase0: fase0_diagnostico,
  "fase0:baseline": fase0_baseline,

  // Fase 1
  fase1: fase1_fragmentacao,
  "fase1:carga": fase1_carga,

  // Fase 2
  "fase2:race": fase2_race,
  "fase2:timestamp": fase2_timestamp,
  "fase2:pool": fase2_pool,
  "fase2:singleton": fase2_singleton,
  "fase2:integracao": fase2_integracao,

  // Fase 3
  "fase3:persist": () => fase3_persist(0),
  "fase3:latencia": fase3_latencia,
  "fase3:full": fase3_full,

  // Fase 4
  "fase4:cascade": fase4_cascade,
  "fase4:exclusao": fase4_exclusao,
  "fase4:front": fase4_front,

  // Compostos
  smoke: async () => {
    await fase0_diagnostico();
    await fase1_fragmentacao();
  },
  audit: async () => {
    await fase0_diagnostico();
    await fase1_fragmentacao();
    await fase4_exclusao();
  },
  full: async () => {
    await fase0_diagnostico();
    await fase0_baseline();
    await fase1_fragmentacao();
    await fase1_carga();
    await fase2_race();
    await fase2_timestamp();
    await fase2_pool();
    await fase2_singleton();
    await fase2_integracao();
    await fase3_persist(0);
    await fase3_persist(60);
    await fase3_latencia();
    await fase4_cascade();
    await fase4_exclusao();
    await fase4_front();
  },
};

(async () => {
  const mode = process.argv[2] || "smoke";
  const fn = MODES[mode];
  if (!fn) {
    console.error(`❌ Modo inválido: ${mode}`);
    console.error(`   Modos: ${Object.keys(MODES).join(" | ")}`);
    process.exit(1);
  }

  console.log(`${C.bold}${C.magenta}🔬 TESTEMESTRE — ${mode}${C.reset}`);
  console.log(`${C.dim}base: ${BASE_URL}  run: ${RUN_ID}  timeout: ${TIMEOUT_MS}ms  out: ${OUT_DIR}/${C.reset}`);

  try {
    await fn();
  } catch (e) {
    console.error(`\n${C.red}💥 Erro fatal:${C.reset}`, e);
    state.findings.push({ id: "FATAL", phase: "?", title: e.message, status: "CONFIRMADA" });
  } finally {
    const confirmed = finalize();
    process.exit(confirmed > 0 ? 1 : 0);
  }
})();