#!/usr/bin/env node
// ============================================================================
// verify-persistence.js — Verifica se os dados do seed sobreviveram
// ----------------------------------------------------------------------------
// Uso:
//   node verify-persistence.js                    (verifica imediatamente)
//   node verify-persistence.js --wait 300         (espera 5min antes)
//   node verify-persistence.js --rounds 3         (verifica 3x, 60s entre cada)
//
// Lê seed-output.json, reautentica cada user, e reconsulta:
//   - /auth/me         (user ainda existe? coupleId correto?)
//   - /couple/me       (casal ainda existe? membros corretos?)
//   - /dependent       (todos os deps ainda listados?)
//   - /summary         (todos os registros do dia ainda lá?)
//   - /casal           (tarefa ainda existe?)
//   - /casal/data      (dado ainda existe com valor correto?)
//   - outsider        (ainda bloqueado por IDOR?)
// ============================================================================

import fs from "node:fs";
import crypto from "node:crypto";

const BASE_URL = (process.env.PROMAX_BASE_URL || "https://luizback-y8qz.vercel.app/").replace(/\/+$/, "");
if (!BASE_URL) { console.error("❌ Defina PROMAX_BASE_URL"); process.exit(1); }
const TIMEOUT_MS = Number(process.env.PROMAX_TIMEOUT || 20000);
const SNAPSHOT = process.env.SEED_OUT || "seed-output.json";

// parse args
const args = process.argv.slice(2);
const waitIdx = args.indexOf("--wait");
const WAIT_SEC = waitIdx >= 0 ? Number(args[waitIdx + 1] || 0) : 0;
const roundsIdx = args.indexOf("--rounds");
const ROUNDS = roundsIdx >= 0 ? Number(args[roundsIdx + 1] || 1) : 1;
const BETWEEN_ROUNDS = 60;

const C = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m",
  blue: "\x1b[34m", magenta: "\x1b[35m", cyan: "\x1b[36m",
};

async function http(method, urlPath, { body, token } = {}) {
  const url = BASE_URL + urlPath;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const h = {};
  if (token) h["Authorization"] = `Bearer ${token}`;
  if (body !== undefined) h["Content-Type"] = "application/json";
  const t0 = Date.now();
  let res, text, json = null;
  try {
    res = await fetch(url, {
      method, headers: h,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    text = await res.text();
    if (text) { try { json = JSON.parse(text); } catch {} }
  } catch (e) { clearTimeout(t); return { status: 0, error: e.message, ms: Date.now() - t0 }; }
  clearTimeout(t);
  return { status: res.status, json, text, ms: Date.now() - t0 };
}

const sleep = (s) => new Promise(r => setTimeout(r, s * 1000));

// ============================================================================
async function checkCouple(c) {
  const log = [];
  const record = (label, ok, detail) => {
    log.push({ label, ok, detail });
    const icon = ok ? `${C.green}✓${C.reset}` : `${C.red}✗${C.reset}`;
    console.log(`    ${icon} ${label}${detail ? ` ${C.dim}— ${detail}${C.reset}` : ""}`);
  };

  // 1) Owner ainda existe?
  let ownerToken = c.owner.token;
  let me = await http("GET", "/auth/me", { token: ownerToken });
  if (me.status === 401) {
    // token expirou, tenta login
    const login = await http("POST", "/auth/login", { body: { email: c.owner.email, password: c.owner.password } });
    if (login.status === 200) { ownerToken = login.json.token; me = await http("GET", "/auth/me", { token: ownerToken }); }
  }
  record("owner /auth/me", me.status === 200, `status=${me.status}`);
  if (me.status !== 200) return { log, verdict: "owner-desapareceu" };

  const ownerCoupleId = me.json?.user?.coupleId;
  record("owner.coupleId correto", ownerCoupleId === c.coupleId,
    `esperado=${c.coupleId} got=${ownerCoupleId}`);

  // 2) Partner ainda está no casal?
  let partnerToken = c.partner.token;
  let pme = await http("GET", "/auth/me", { token: partnerToken });
  if (pme.status === 401) {
    const login = await http("POST", "/auth/login", { body: { email: c.partner.email, password: c.partner.password } });
    if (login.status === 200) { partnerToken = login.json.token; pme = await http("GET", "/auth/me", { token: partnerToken }); }
  }
  record("partner /auth/me", pme.status === 200, `status=${pme.status}`);
  if (pme.status === 200) {
    record("partner.coupleId correto", pme.json?.user?.coupleId === c.coupleId,
      `esperado=${c.coupleId} got=${pme.json?.user?.coupleId}`);
  }

  // 3) Casal ainda existe?
  const couple = await http("GET", "/couple/me", { token: ownerToken });
  record("GET /couple/me", couple.status === 200, `status=${couple.status}`);
  if (couple.status === 200) {
    const members = couple.json?.couple?.members?.map(m => m.id) || [];
    record("casal tem owner + partner", members.includes(c.owner.id) && members.includes(c.partner.id),
      `membros=${members.length}`);
  }

  // 4) Dependentes ainda existem?
  const deps = await http("GET", "/dependent", { token: ownerToken });
  record("GET /dependent", deps.status === 200, `status=${deps.status}`);
  if (deps.status === 200) {
    const foundIds = new Set(deps.json.map(d => d.id));
    for (const expectedDep of c.dependents) {
      record(`dep ${expectedDep.id} presente`, foundIds.has(expectedDep.id));
    }
  }

  // 5) Summary do dia — registros ainda lá?
  const today = new Date().toISOString().slice(0, 10);
  for (const dep of c.dependents) {
    const sum = await http("GET", `/summary?dependentId=${dep.id}&date=${today}`, { token: ownerToken });
    if (sum.status !== 200) { record(`summary ${dep.id}`, false, `status=${sum.status}`); continue; }
    const w = sum.json?.water?.length ?? 0;
    const p = sum.json?.pee?.length ?? 0;
    const po = sum.json?.poop?.length ?? 0;
    const b = sum.json?.behavior?.length ?? 0;
    const ok = w >= 1 && p >= 1 && po >= 1 && b >= 1;
    record(`summary ${dep.id}`, ok, `w=${w} p=${p} po=${po} b=${b}`);
    if (!ok) {
      console.log(`      ${C.red}⚠ REGISTROS DESAPARECERAM — esperado 1 de cada, got w=${w} p=${p} po=${po} b=${b}${C.reset}`);
    }
  }

  // 6) Tarefa ainda existe?
  const tasks = await http("GET", "/casal", { token: ownerToken });
  if (tasks.status === 200 && c.taskId) {
    const found = tasks.json.some(t => t.id === c.taskId);
    record(`task ${c.taskId} presente`, found);
  }

  // 7) CasalData ainda existe?
  const cd = await http("GET", `/casal/data?key=${c.casalDataKey}`, { token: ownerToken });
  if (cd.status === 200) {
    const v = cd.json?.value;
    const ok = v && v.seededBy && v.coupleIdx === c.idx;
    record(`casalData[${c.casalDataKey}]`, ok, `value=${JSON.stringify(v).slice(0, 80)}`);
  }

  // 8) Outsider ainda bloqueado?
  let outToken = c.outsider.token;
  let outMe = await http("GET", "/auth/me", { token: outToken });
  if (outMe.status === 401) {
    const login = await http("POST", "/auth/login", { body: { email: c.outsider.email, password: c.outsider.password || "?" } });
    if (login.status === 200) { outToken = login.json.token; }
  }
  if (outToken) {
    const idor = await http("GET", `/dependent/${c.dependents[0].id}`, { token: outToken });
    record("outsider ainda bloqueado (403/404)", [403, 404].includes(idor.status), `status=${idor.status}`);
  }

  const failures = log.filter(l => !l.ok).length;
  const verdict = failures === 0 ? "OK" : `${failures} falhas`;
  return { log, verdict };
}

// ============================================================================
async function run() {
  if (!fs.existsSync(SNAPSHOT)) {
    console.error(`❌ ${SNAPSHOT} não encontrado. Rode seed.js primeiro.`);
    process.exit(1);
  }
  const seed = JSON.parse(fs.readFileSync(SNAPSHOT, "utf-8"));
  console.log(`${C.bold}${C.magenta}🔎 VERIFY PERSISTENCE — ${SNAPSHOT}${C.reset}`);
  console.log(`${C.dim}seed runId: ${seed.runId}  criado em: ${seed.startedAt}${C.reset}`);
  console.log(`${C.dim}base: ${BASE_URL}  casais: ${seed.couples.length}  rounds: ${ROUNDS}${C.reset}\n`);

  if (WAIT_SEC > 0) {
    console.log(`${C.yellow}⏳ Aguardando ${WAIT_SEC}s para forçar reciclagem de container...${C.reset}`);
    for (let i = WAIT_SEC; i > 0; i -= 10) {
      process.stdout.write(`\r   ${i}s restantes...   `);
      await sleep(Math.min(10, i));
    }
    console.log("\r   pronto.                              \n");
  }

  const allResults = [];

  for (let r = 1; r <= ROUNDS; r++) {
    console.log(`${C.bold}${C.cyan}━━━ ROUND ${r}/${ROUNDS} — ${new Date().toISOString()} ━━━${C.reset}`);
    const roundResults = [];

    for (const c of seed.couples) {
      if (c.error) { console.log(`  ${C.dim}casal #${c.idx} ignorado (erro no seed)${C.reset}`); continue; }
      console.log(`\n  ${C.bold}▶ Casal #${c.idx}${C.reset}  coupleId=${c.coupleId}`);
      const { log, verdict } = await checkCouple(c);
      roundResults.push({ idx: c.idx, verdict, log });
      const color = verdict === "OK" ? C.green : C.red;
      console.log(`  ${color}→ ${verdict}${C.reset}`);
    }

    allResults.push({ round: r, at: new Date().toISOString(), results: roundResults });

    if (r < ROUNDS) {
      console.log(`\n${C.yellow}⏳ Aguardando ${BETWEEN_ROUNDS}s antes do próximo round...${C.reset}\n`);
      await sleep(BETWEEN_ROUNDS);
    }
  }

  // resumo final
  console.log(`\n${C.bold}${C.cyan}═══════════════════════════════════════════════${C.reset}`);
  console.log(`${C.bold}  RESUMO FINAL${C.reset}`);
  console.log(`${C.cyan}═══════════════════════════════════════════════${C.reset}`);

  const allLogs = allResults.flatMap(r => r.results.flatMap(x => x.log));
  const total = allLogs.length;
  const ok = allLogs.filter(l => l.ok).length;
  const failures = allLogs.filter(l => !l.ok);

  console.log(`  Verificações:  ${total}`);
  console.log(`  OK:            ${ok}`);
  console.log(`  Falhas:        ${failures.length}`);

  if (failures.length) {
    console.log(`\n  ${C.bold}${C.red}Falhas detectadas:${C.reset}`);
    for (const f of failures) {
      console.log(`    ${C.red}✗${C.reset} ${f.label} ${C.dim}— ${f.detail}${C.reset}`);
    }
    console.log(`\n  ${C.red}⚠ DADOS NÃO SOBREVIVERAM — bug confirmado.${C.reset}`);
  } else {
    console.log(`\n  ${C.green}✓ Todos os dados sobreviveram entre rounds.${C.reset}`);
  }

  const out = {
    verifiedAt: new Date().toISOString(),
    seedRunId: seed.runId,
    rounds: ROUNDS,
    waitSec: WAIT_SEC,
    summary: { total, ok, failures: failures.length },
    failures,
    detail: allResults,
  };
  const outPath = `verify-report-${Date.now()}.json`;
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`\n  ${C.green}Relatório:${C.reset} ${outPath}\n`);

  process.exit(failures.length > 0 ? 1 : 0);
}

run().catch(e => { console.error(`${C.red}💥${C.reset}`, e); process.exit(2); });