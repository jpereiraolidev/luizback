// ============================================================
// testRotas.js — Testa todas as rotas da API local
// Pré-requisito: dev.js rodando em outra aba (node dev.js)
// Uso: node testRotas.js
// ============================================================

const BASE = process.env.BASE || "https://luizback.vercel.app";
const TEST_DATE = "2026-09-22";

// ------------------------------------------------------------
// Cores para o terminal
// ------------------------------------------------------------
const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[90m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
};

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------
let passou = 0;
let falhou = 0;

function log(msg) { console.log(msg); }
function titulo(msg) {
  console.log("");
  console.log(`${c.magenta}${c.bold}━━━ ${msg} ━━━${c.reset}`);
}

function mostrarResultado(nome, ok, dados) {
  if (ok) {
    passou++;
    console.log(`  ${c.green}✔${c.reset} ${nome}`);
  } else {
    falhou++;
    console.log(`  ${c.red}✘${c.reset} ${nome}`);
  }
  if (dados !== undefined) {
    const str = JSON.stringify(dados);
    const trunc = str.length > 120 ? str.slice(0, 120) + "…" : str;
    console.log(`    ${c.dim}${trunc}${c.reset}`);
  }
}

async function req(method, path, body) {
  const opts = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(BASE + path, opts);
  let data;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  return { status: res.status, data };
}

// ------------------------------------------------------------
// Testes
// ------------------------------------------------------------
async function testHealth() {
  titulo("Health check");
  const { status, data } = await req("GET", "/");
  const ok = status === 200 && data && data.ok === true;
  mostrarResultado(`GET / → ${status}`, ok, data);
  return ok;
}

async function testWater() {
  titulo("WATER — CRUD");

  // CREATE
  const novo = {
    amount: 150,
    reason: "Sede",
    timestamp: new Date().toISOString(),
    date: TEST_DATE,
  };
  const post = await req("POST", "/water", novo);
  const criadoOk = post.status === 201 && post.data && post.data.id;
  mostrarResultado(`POST /water → ${post.status}`, criadoOk, post.data);
  const idCriado = post.data?.id;

  // READ (por data)
  const get = await req("GET", `/water?date=${TEST_DATE}`);
  const getOk = get.status === 200 && Array.isArray(get.data) && get.data.length > 0;
  mostrarResultado(`GET /water?date=${TEST_DATE} → ${get.status} (${get.data?.length ?? 0} itens)`, getOk);

  // READ (por id)
  if (idCriado) {
    const getOne = await req("GET", `/water?id=${idCriado}`);
    const getOneOk = getOne.status === 200 && getOne.data?.id === idCriado;
    mostrarResultado(`GET /water?id=... → ${getOne.status}`, getOneOk, getOne.data);
  }

  // UPDATE
  if (idCriado) {
    const put = await req("PUT", `/water?id=${idCriado}`, { amount: 200, reason: "Calor" });
    const putOk = put.status === 200 && put.data?.amount === 200;
    mostrarResultado(`PUT /water?id=... → ${put.status}`, putOk, put.data);
  }

  // ERROS esperados
  const semBody = await req("POST", "/water", { amount: 100 });
  const erroOk = semBody.status === 400;
  mostrarResultado(`POST /water sem campos → ${semBody.status} (esperado 400)`, erroOk, semBody.data);

  return idCriado;
}

async function testPee() {
  titulo("PEE — CRUD");

  const novo = {
    size: "medio",
    type: "espontaneo",
    note: "teste automatizado",
    timestamp: new Date().toISOString(),
    date: TEST_DATE,
  };
  const post = await req("POST", "/pee", novo);
  const ok = post.status === 201 && post.data?.id;
  mostrarResultado(`POST /pee → ${post.status}`, ok, post.data);
  const id = post.data?.id;

  const get = await req("GET", `/pee?date=${TEST_DATE}`);
  mostrarResultado(`GET /pee?date=${TEST_DATE} → ${get.status} (${get.data?.length ?? 0} itens)`,
    get.status === 200 && Array.isArray(get.data));

  if (id) {
    const put = await req("PUT", `/pee?id=${id}`, { size: "grande", type: "acidente" });
    mostrarResultado(`PUT /pee?id=... → ${put.status}`,
      put.status === 200 && put.data?.size === "grande", put.data);
  }

  return id;
}

async function testPoop() {
  titulo("POOP — CRUD");

  const novo = {
    evacuated: true,
    consistency: "Normal",
    pain: 1,
    note: "teste automatizado",
    timestamp: new Date().toISOString(),
    date: TEST_DATE,
  };
  const post = await req("POST", "/poop", novo);
  const ok = post.status === 201 && post.data?.id;
  mostrarResultado(`POST /poop → ${post.status}`, ok, post.data);
  const id = post.data?.id;

  const get = await req("GET", `/poop?date=${TEST_DATE}`);
  mostrarResultado(`GET /poop?date=${TEST_DATE} → ${get.status} (${get.data?.length ?? 0} itens)`,
    get.status === 200 && Array.isArray(get.data));

  if (id) {
    const put = await req("PUT", `/poop?id=${id}`, { consistency: "Mole", pain: 2 });
    mostrarResultado(`PUT /poop?id=... → ${put.status}`,
      put.status === 200 && put.data?.consistency === "Mole", put.data);
  }

  return id;
}

async function testBehavior() {
  titulo("BEHAVIOR — CRUD");

  const novo = {
    observed: "Jogou objeto",
    rule: "Não jogar objetos",
    action: "Pausa de 5 min",
    duration: 5,
    result: "Voltou à atividade",
    timestamp: new Date().toISOString(),
    date: TEST_DATE,
  };
  const post = await req("POST", "/behavior", novo);
  const ok = post.status === 201 && post.data?.id;
  mostrarResultado(`POST /behavior → ${post.status}`, ok, post.data);
  const id = post.data?.id;

  const get = await req("GET", `/behavior?date=${TEST_DATE}`);
  mostrarResultado(`GET /behavior?date=${TEST_DATE} → ${get.status} (${get.data?.length ?? 0} itens)`,
    get.status === 200 && Array.isArray(get.data));

  if (id) {
    const put = await req("PUT", `/behavior?id=${id}`, { duration: 10, result: "Acalmou" });
    mostrarResultado(`PUT /behavior?id=... → ${put.status}`,
      put.status === 200 && put.data?.duration === 10, put.data);
  }

  return id;
}

async function testSummary() {
  titulo("SUMMARY — agregado 7 dias");

  const { status, data } = await req("GET", `/summary?date=${TEST_DATE}`);
  const ok =
    status === 200 &&
    data &&
    Array.isArray(data.water) &&
    Array.isArray(data.pee) &&
    Array.isArray(data.poop) &&
    Array.isArray(data.behavior) &&
    data.weekly &&
    Array.isArray(data.weekly.water) &&
    data.weekly.water.length === 7 &&
    Array.isArray(data.weekly.pee) &&
    data.weekly.pee.length === 7;

  mostrarResultado(`GET /summary?date=${TEST_DATE} → ${status}`, ok, {
    water: data?.water?.length,
    pee: data?.pee?.length,
    poop: data?.poop?.length,
    behavior: data?.behavior?.length,
    weeklyWater: data?.weekly?.water,
    weeklyPee: data?.weekly?.pee,
  });

  // Erro esperado: sem ?date=
  const semDate = await req("GET", "/summary");
  mostrarResultado(`GET /summary (sem date) → ${semDate.status} (esperado 400)`,
    semDate.status === 400, semDate.data);
}

async function test404() {
  titulo("404 — rota inexistente");
  const { status, data } = await req("GET", "/rota-que-nao-existe");
  mostrarResultado(`GET /rota-que-nao-existe → ${status} (esperado 404)`,
    status === 404, data);
}

async function cleanup(ids) {
  titulo("Cleanup — apagando registros de teste");
  const apagados = [];

  for (const [recurso, id] of Object.entries(ids)) {
    if (!id) continue;
    const { status, data } = await req("DELETE", `/${recurso}?id=${id}`);
    const ok = status === 200 && data?.deleted === true;
    mostrarResultado(`DELETE /${recurso}?id=... → ${status}`, ok, data);
    if (ok) apagados.push(`${recurso}:${id}`);
  }

  // Confirma que sumiram
  console.log("");
  console.log(`  ${c.dim}Registros apagados: ${apagados.length}${c.reset}`);
}

// ------------------------------------------------------------
// Runner
// ------------------------------------------------------------
async function main() {
  console.log("");
  console.log(`${c.cyan}${c.bold}╔══════════════════════════════════════════════════╗${c.reset}`);
  console.log(`${c.cyan}${c.bold}║  🧪 testRotas.js — testando API local            ║${c.reset}`);
  console.log(`${c.cyan}${c.bold}║  ➜  ${BASE.padEnd(42)}║${c.reset}`);
  console.log(`${c.cyan}${c.bold}╚══════════════════════════════════════════════════╝${c.reset}`);

  // Verifica se o servidor está no ar
  try {
    const ping = await fetch(BASE + "/");
    if (!ping.ok && ping.status !== 500) throw new Error("Servidor respondeu " + ping.status);
  } catch (e) {
    console.log("");
    console.log(`${c.red}❌ Não consegui conectar em ${BASE}${c.reset}`);
    console.log(`${c.yellow}   Abre outro terminal e roda: ${c.bold}node dev.js${c.reset}`);
    console.log(`   ${c.dim}(${e.message})${c.reset}`);
    process.exit(1);
  }

  const ids = {};

  try {
    await testHealth();
    ids.water = await testWater();
    ids.pee = await testPee();
    ids.poop = await testPoop();
    ids.behavior = await testBehavior();
    await testSummary();
    await test404();

    // Descomenta se quiser limpar os registros de teste:
    // await cleanup(ids);
  } catch (e) {
    console.log("");
    console.log(`${c.red}❌ Erro inesperado: ${e.message}${c.reset}`);
    console.error(e);
  }

  // Resumo final
  console.log("");
  console.log(`${c.magenta}${c.bold}━━━ Resultado ━━━${c.reset}`);
  console.log(`  ${c.green}✔ Passou: ${passou}${c.reset}`);
  console.log(`  ${c.red}✘ Falhou: ${falhou}${c.reset}`);
  console.log("");

  process.exit(falhou === 0 ? 0 : 1);
}

main();