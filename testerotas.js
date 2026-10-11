// ============================================================
// testRotas.js — testa TODAS as rotas da API (local ou prod)
// Uso:
//   node testRotas.js
//   BASE=http://localhost:3000 node testRotas.js
//   BASE=https://luizback.vercel.app node testRotas.js
// ============================================================

const BASE = process.env.BASE || "https://luizback-y8qz.vercel.app/";

// ------------------------------------------------------------
// Cores
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
    const trunc = str.length > 140 ? str.slice(0, 140) + "…" : str;
    console.log(`    ${c.dim}${trunc}${c.reset}`);
  }
}

// Sessão do usuário logado (token atual)
let TOKEN = null;

async function req(method, path, body, opts = {}) {
  const headers = { "Content-Type": "application/json" };
  const token = opts.token !== undefined ? opts.token : TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;

  const fetchOpts = { method, headers };
  if (body) fetchOpts.body = JSON.stringify(body);

  const res = await fetch(BASE + path, fetchOpts);
  let data;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  return { status: res.status, data };
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

const TEST_DATE = new Date().toISOString().slice(0, 10);

// ============================================================
// HEALTH
// ============================================================
async function testHealth() {
  titulo("Health check");
  const { status, data } = await req("GET", "/", null, { token: null });
  const ok = status === 200 && data && data.ok === true;
  mostrarResultado(`GET / → ${status}`, ok, data);
}

// ============================================================
// AUTH
// ============================================================
async function testAuth() {
  titulo("AUTH — register / login / me");

  const email = `joao_${uid()}@teste.com`;
  const password = "senha123456";

  // Register
  const reg = await req("POST", "/auth/register", { email, password, name: "João Teste" }, { token: null });
  const regOk = reg.status === 201 && reg.data?.token && reg.data?.user?.id;
  mostrarResultado(`POST /auth/register → ${reg.status}`, regOk, {
    user: reg.data?.user?.email,
    hasToken: !!reg.data?.token,
  });
  if (!regOk) throw new Error("Falha no register — não dá pra continuar");
  TOKEN = reg.data.token;
  const userJoao = reg.data.user;

  // Register duplicado → 409
  const dup = await req("POST", "/auth/register", { email, password, name: "X" }, { token: null });
  mostrarResultado(`POST /auth/register (dup) → ${dup.status} (esperado 409)`, dup.status === 409);

  // Register email inválido → 400
  const badEmail = await req("POST", "/auth/register", { email: "abc", password, name: "X" }, { token: null });
  mostrarResultado(`POST /auth/register (email inválido) → ${badEmail.status} (esperado 400)`, badEmail.status === 400);

  // Register senha curta → 400
  const badPwd = await req("POST", "/auth/register", { email: `x_${uid()}@t.com`, password: "123", name: "X" }, { token: null });
  mostrarResultado(`POST /auth/register (senha curta) → ${badPwd.status} (esperado 400)`, badPwd.status === 400);

  // Login
  const login = await req("POST", "/auth/login", { email, password }, { token: null });
  mostrarResultado(`POST /auth/login → ${login.status}`, login.status === 200 && login.data?.token);

  // Login senha errada → 401
  const loginBad = await req("POST", "/auth/login", { email, password: "errada" }, { token: null });
  mostrarResultado(`POST /auth/login (senha errada) → ${loginBad.status} (esperado 401)`, loginBad.status === 401);

  // Me
  const me = await req("GET", "/auth/me");
  mostrarResultado(`GET /auth/me → ${me.status}`, me.status === 200 && me.data?.user?.id === userJoao.id);

  // Me sem token → 401
  const meNoToken = await req("GET", "/auth/me", null, { token: null });
  mostrarResultado(`GET /auth/me (sem token) → ${meNoToken.status} (esperado 401)`, meNoToken.status === 401);

  // Me com token inválido → 401
  const meBad = await req("GET", "/auth/me", null, { token: "xxx.yyy.zzz" });
  mostrarResultado(`GET /auth/me (token inválido) → ${meBad.status} (esperado 401)`, meBad.status === 401);

  // Salva pra próxima etapa
  globalThis.__joao = { email, password, user: userJoao };
}

// ============================================================
// COUPLE
// ============================================================
async function testCouple() {
  titulo("COUPLE — criar / me / invite / prefs");

  // Cria casal (João)
  const create = await req("POST", "/couple");
  const createOk = create.status === 201 && create.data?.couple?.id;
  mostrarResultado(`POST /couple → ${create.status}`, createOk, {
    id: create.data?.couple?.id,
    members: create.data?.couple?.members?.length,
  });
  if (!createOk) throw new Error("Falha ao criar casal");
  const coupleId = create.data.couple.id;

  // Criar casal de novo → 409
  const dup = await req("POST", "/couple");
  mostrarResultado(`POST /couple (dup) → ${dup.status} (esperado 409)`, dup.status === 409);

  // Me
  const me = await req("GET", "/couple/me");
  mostrarResultado(`GET /couple/me → ${me.status}`, me.status === 200 && me.data?.couple?.id === coupleId);

  // Prefs
  const prefs = await req("PUT", "/couple/prefs", { color: "purple", theme: "glass" });
  mostrarResultado(
    `PUT /couple/prefs → ${prefs.status}`,
    prefs.status === 200 && prefs.data?.couple?.color === "purple"
  );

  globalThis.__couple = { coupleId };
}

// ============================================================
// COUPLE INVITE + NOTIFICATIONS (fluxo completo)
// ============================================================
async function testInviteFlow() {
  titulo("COUPLE INVITE + NOTIFICATIONS");

  // Cria a Lais
  const emailLais = `lais_${uid()}@teste.com`;
  const passwordLais = "senha123456";
  const regLais = await req(
    "POST",
    "/auth/register",
    { email: emailLais, password: passwordLais, name: "Lais Teste" },
    { token: null }
  );
  mostrarResultado(`POST /auth/register (Lais) → ${regLais.status}`, regLais.status === 201);
  const tokenLais = regLais.data?.token;
  const userLais = regLais.data?.user;

  // João convida Lais
  const invite = await req("POST", "/couple/invite", { email: emailLais });
  const inviteOk = invite.status === 201 && invite.data?.notification?.id;
  mostrarResultado(`POST /couple/invite → ${invite.status}`, inviteOk, {
    id: invite.data?.notification?.id,
    status: invite.data?.notification?.status,
  });
  const notifId = invite.data?.notification?.id;

  // Convidar email que não existe → 404
  const inviteNo = await req("POST", "/couple/invite", { email: `naoexiste_${uid()}@x.com` });
  mostrarResultado(`POST /couple/invite (inexistente) → ${inviteNo.status} (esperado 404)`, inviteNo.status === 404);

  // Convidar a si mesmo → 400
  const inviteSelf = await req("POST", "/couple/invite", { email: globalThis.__joao.email });
  mostrarResultado(`POST /couple/invite (self) → ${inviteSelf.status} (esperado 400)`, inviteSelf.status === 400);

  // Convidar de novo a mesma → 409
  const inviteDup = await req("POST", "/couple/invite", { email: emailLais });
  mostrarResultado(`POST /couple/invite (dup) → ${inviteDup.status} (esperado 409)`, inviteDup.status === 409);

  // Lais vê notificações
  const notifs = await req("GET", "/notifications?status=PENDING", null, { token: tokenLais });
  const listOk = notifs.status === 200 && Array.isArray(notifs.data) && notifs.data.length === 1;
  mostrarResultado(
    `GET /notifications (Lais) → ${notifs.status} (${notifs.data?.length ?? 0} itens)`,
    listOk,
    notifs.data?.[0]
  );

  // Lais tenta aceitar notif do João (que não é dela) → 403
  // Primeiro: João tenta aceitar a própria notif → 403
  const acceptWrong = await req("POST", `/notifications/${notifId}/accept`);
  mostrarResultado(
    `POST /notifications/:id/accept (remetente) → ${acceptWrong.status} (esperado 403)`,
    acceptWrong.status === 403
  );

  // Lais aceita
  const accept = await req("POST", `/notifications/${notifId}/accept`, null, { token: tokenLais });
  mostrarResultado(
    `POST /notifications/:id/accept (Lais) → ${accept.status}`,
    accept.status === 200 && accept.data?.accepted === true,
    accept.data
  );

  // Lais agora tem coupleId
  const meLais = await req("GET", "/auth/me", null, { token: tokenLais });
  const coupleOk = meLais.data?.user?.coupleId === globalThis.__couple.coupleId;
  mostrarResultado(
    `GET /auth/me (Lais) tem coupleId → ${meLais.status}`,
    coupleOk,
    { coupleId: meLais.data?.user?.coupleId }
  );

  // Aceitar de novo → 409 (já não está PENDING)
  const acceptAgain = await req("POST", `/notifications/${notifId}/accept`, null, { token: tokenLais });
  mostrarResultado(
    `POST /notifications/:id/accept (repetido) → ${acceptAgain.status} (esperado 409)`,
    acceptAgain.status === 409
  );

  // Couple agora tem 2 membros
  const meCouple = await req("GET", "/couple/me");
  const membersOk = meCouple.data?.couple?.members?.length === 2;
  mostrarResultado(
    `GET /couple/me (2 membros) → ${meCouple.status}`,
    membersOk,
    { members: meCouple.data?.couple?.members?.length }
  );

  globalThis.__lais = { email: emailLais, password: passwordLais, token: tokenLais, user: userLais };
}

// ============================================================
// NOTIFICAÇÕES — reject e cancel
// ============================================================
async function testNotifRejectCancel() {
  titulo("NOTIFICATIONS — reject / cancel");

  // Cria um terceiro user pra testar reject
  const email3 = `outro_${uid()}@teste.com`;
  const reg3 = await req(
    "POST",
    "/auth/register",
    { email: email3, password: "senha123456", name: "Outro" },
    { token: null }
  );
  const token3 = reg3.data?.token;
  const user3 = reg3.data?.user;

  // João convida esse terceiro
  const invite = await req("POST", "/couple/invite", { email: email3 });
  const notifId = invite.data?.notification?.id;
  mostrarResultado(`POST /couple/invite (terceiro) → ${invite.status}`, invite.status === 201);

  // Terceiro rejeita
  const reject = await req("POST", `/notifications/${notifId}/reject`, null, { token: token3 });
  mostrarResultado(
    `POST /notifications/:id/reject → ${reject.status}`,
    reject.status === 200 && reject.data?.rejected === true
  );

  // Terceiro não tem coupleId
  const me3 = await req("GET", "/auth/me", null, { token: token3 });
  mostrarResultado(
    `GET /auth/me (terceiro) sem coupleId → ${me3.status}`,
    me3.data?.user?.coupleId === null
  );

  // Convidar de novo (agora que foi rejeitado) → 201
  const invite2 = await req("POST", "/couple/invite", { email: email3 });
  mostrarResultado(`POST /couple/invite (após reject) → ${invite2.status}`, invite2.status === 201);
  const notifId2 = invite2.data?.notification?.id;

  // João cancela (DELETE)
  const cancel = await req("DELETE", `/notifications/${notifId2}`);
  mostrarResultado(
    `DELETE /notifications/:id (cancelar) → ${cancel.status}`,
    cancel.status === 200 && cancel.data?.cancelled === true
  );

  // Terceiro tenta cancelar (não foi ele que enviou) → 403
  const cancelWrong = await req("DELETE", `/notifications/${notifId2}`, null, { token: token3 });
  mostrarResultado(
    `DELETE /notifications/:id (destinatário) → ${cancelWrong.status} (esperado 403)`,
    cancelWrong.status === 403
  );
}

// ============================================================
// DEPENDENT
// ============================================================
async function testDependent() {
  titulo("DEPENDENT — CRUD");

  // Lista vazia
  const empty = await req("GET", "/dependent");
  mostrarResultado(
    `GET /dependent (inicial) → ${empty.status} (${empty.data?.length ?? 0} itens)`,
    empty.status === 200 && Array.isArray(empty.data)
  );

  // Cria
  const post = await req("POST", "/dependent", {
    name: "Luiz Teste",
    birthDate: "2020-05-10",
  });
  const criadoOk = post.status === 201 && post.data?.id && post.data.name === "Luiz Teste";
  mostrarResultado(`POST /dependent → ${post.status}`, criadoOk, post.data);
  const depId = post.data?.id;

  // Sem name → 400
  const semName = await req("POST", "/dependent", { birthDate: "2020-01-01" });
  mostrarResultado(`POST /dependent (sem name) → ${semName.status} (esperado 400)`, semName.status === 400);

  // birthDate inválida → 400
  const badDate = await req("POST", "/dependent", { name: "X", birthDate: "10/05/2020" });
  mostrarResultado(`POST /dependent (birthDate inválida) → ${badDate.status} (esperado 400)`, badDate.status === 400);

  // GET /:id
  const getOne = await req("GET", `/dependent/${depId}`);
  mostrarResultado(`GET /dependent/:id → ${getOne.status}`, getOne.status === 200 && getOne.data?.id === depId);

  // GET id inexistente → 404
  const getNo = await req("GET", `/dependent/naoexiste`);
  mostrarResultado(`GET /dependent/inexistente → ${getNo.status} (esperado 404)`, getNo.status === 404);

  // UPDATE
  const put = await req("PUT", `/dependent/${depId}`, { name: "Luiz Atualizado", avatar: "🦁" });
  mostrarResultado(
    `PUT /dependent/:id → ${put.status}`,
    put.status === 200 && put.data?.name === "Luiz Atualizado" && put.data?.avatar === "🦁"
  );

  globalThis.__dependent = { id: depId };
}

// ============================================================
// WATER / PEE / POOP / BEHAVIOR (do dependente)
// ============================================================
async function testRegistros() {
  titulo("WATER — CRUD (dependente)");
  const depId = globalThis.__dependent.id;

  const post = await req("POST", "/water", {
    dependentId: depId,
    amount: 150,
    reason: "Sede",
    timestamp: new Date().toISOString(),
    date: TEST_DATE,
  });
  const criadoOk = post.status === 201 && post.data?.id;
  mostrarResultado(`POST /water → ${post.status}`, criadoOk, post.data);
  const id = post.data?.id;

  const get = await req("GET", `/water?dependentId=${depId}&date=${TEST_DATE}`);
  mostrarResultado(
    `GET /water?dependentId=...&date=... → ${get.status} (${get.data?.length ?? 0} itens)`,
    get.status === 200 && Array.isArray(get.data)
  );

  if (id) {
    const put = await req("PUT", `/water?id=${id}`, { amount: 200, reason: "Calor" });
    mostrarResultado(`PUT /water?id=... → ${put.status}`, put.status === 200 && put.data?.amount === 200);
  }

  // Sem dependentId → 400
  const semDep = await req("POST", "/water", {
    amount: 100,
    timestamp: new Date().toISOString(),
    date: TEST_DATE,
  });
  mostrarResultado(`POST /water (sem dependentId) → ${semDep.status} (esperado 400)`, semDep.status === 400);

  // Sem campos → 400
  const semCampos = await req("POST", "/water", { dependentId: depId, amount: 100 });
  mostrarResultado(`POST /water (sem date/timestamp) → ${semCampos.status} (esperado 400)`, semCampos.status === 400);

  // dependentId de outro casal → 403
  // (não temos como testar isso facilmente sem criar outro casal, skip)

  if (id) await req("DELETE", `/water?id=${id}`);

  // ----- PEE -----
  titulo("PEE — CRUD (dependente)");
  const pee = await req("POST", "/pee", {
    dependentId: depId,
    size: "medio",
    type: "espontaneo",
    note: "teste",
    timestamp: new Date().toISOString(),
    date: TEST_DATE,
  });
  mostrarResultado(`POST /pee → ${pee.status}`, pee.status === 201 && pee.data?.id);
  const peeId = pee.data?.id;

  const peeGet = await req("GET", `/pee?dependentId=${depId}&date=${TEST_DATE}`);
  mostrarResultado(`GET /pee → ${peeGet.status} (${peeGet.data?.length ?? 0} itens)`, peeGet.status === 200);

  if (peeId) {
    const peePut = await req("PUT", `/pee?id=${peeId}`, { size: "grande", type: "acidente" });
    mostrarResultado(`PUT /pee → ${peePut.status}`, peePut.status === 200 && peePut.data?.size === "grande");
    await req("DELETE", `/pee?id=${peeId}`);
  }

  // ----- POOP -----
  titulo("POOP — CRUD (dependente)");
  const poop = await req("POST", "/poop", {
    dependentId: depId,
    evacuated: true,
    consistency: "Normal",
    pain: 1,
    note: "teste",
    timestamp: new Date().toISOString(),
    date: TEST_DATE,
  });
  mostrarResultado(`POST /poop → ${poop.status}`, poop.status === 201 && poop.data?.id);
  const poopId = poop.data?.id;

  const poopGet = await req("GET", `/poop?dependentId=${depId}&date=${TEST_DATE}`);
  mostrarResultado(`GET /poop → ${poopGet.status} (${poopGet.data?.length ?? 0} itens)`, poopGet.status === 200);

  if (poopId) {
    const poopPut = await req("PUT", `/poop?id=${poopId}`, { consistency: "Mole", pain: 2 });
    mostrarResultado(`PUT /poop → ${poopPut.status}`, poopPut.status === 200 && poopPut.data?.consistency === "Mole");
    await req("DELETE", `/poop?id=${poopId}`);
  }

  // ----- BEHAVIOR -----
  titulo("BEHAVIOR — CRUD (dependente)");
  const beh = await req("POST", "/behavior", {
    dependentId: depId,
    observed: "Jogou objeto",
    rule: "Não jogar objetos",
    action: "Pausa de 5 min",
    duration: 5,
    result: "Voltou à atividade",
    timestamp: new Date().toISOString(),
    date: TEST_DATE,
  });
  mostrarResultado(`POST /behavior → ${beh.status}`, beh.status === 201 && beh.data?.id);
  const behId = beh.data?.id;

  const behGet = await req("GET", `/behavior?dependentId=${depId}&date=${TEST_DATE}`);
  mostrarResultado(`GET /behavior → ${behGet.status} (${behGet.data?.length ?? 0} itens)`, behGet.status === 200);

  if (behId) {
    const behPut = await req("PUT", `/behavior?id=${behId}`, { duration: 10, result: "Acalmou" });
    mostrarResultado(`PUT /behavior → ${behPut.status}`, behPut.status === 200 && behPut.data?.duration === 10);
    await req("DELETE", `/behavior?id=${behId}`);
  }
}

// ============================================================
// SUMMARY
// ============================================================
async function testSummary() {
  titulo("SUMMARY — agregado 7 dias");

  const depId = globalThis.__dependent.id;

  const { status, data } = await req("GET", `/summary?dependentId=${depId}&date=${TEST_DATE}`);
  const ok =
    status === 200 &&
    data &&
    Array.isArray(data.water) &&
    Array.isArray(data.pee) &&
    Array.isArray(data.poop) &&
    Array.isArray(data.behavior) &&
    data.weekly?.water?.length === 7 &&
    data.weekly?.pee?.length === 7;

  mostrarResultado(`GET /summary → ${status}`, ok, {
    water: data?.water?.length,
    pee: data?.pee?.length,
    poop: data?.poop?.length,
    behavior: data?.behavior?.length,
    weeklyWater: data?.weekly?.water?.length,
    weeklyPee: data?.weekly?.pee?.length,
  });

  const semDate = await req("GET", `/summary?dependentId=${depId}`);
  mostrarResultado(`GET /summary (sem date) → ${semDate.status} (esperado 400)`, semDate.status === 400);

  const semDep = await req("GET", `/summary?date=${TEST_DATE}`);
  mostrarResultado(`GET /summary (sem dependentId) → ${semDep.status} (esperado 400)`, semDep.status === 400);
}

// ============================================================
// CASAL — tarefas
// ============================================================
async function testCasalTarefas() {
  titulo("CASAL — Tarefas (CoupleTask)");

  // CREATE completo
  const nova = {
    text: "Lavar a louça — teste",
    owner: "Eu",
    priority: "alta",
    due: TEST_DATE,
    note: "criada pelo teste",
  };
  const post = await req("POST", "/casal", nova);
  const criadoOk =
    post.status === 201 &&
    post.data?.id &&
    post.data.text === nova.text &&
    post.data.owner === "Eu" &&
    post.data.priority === "alta" &&
    post.data.done === false;
  mostrarResultado(`POST /casal → ${post.status}`, criadoOk, post.data);
  const id = post.data?.id;

  // CREATE só com texto
  const soTexto = await req("POST", "/casal", { text: "Só texto" });
  const soTextoOk =
    soTexto.status === 201 &&
    soTexto.data?.owner === "Qualquer um" &&
    soTexto.data?.priority === "media" &&
    soTexto.data?.done === false;
  mostrarResultado(`POST /casal (só text) → ${soTexto.status}`, soTextoOk);
  const idSoTexto = soTexto.data?.id;

  // Sem text → 400
  const semText = await req("POST", "/casal", { owner: "Eu" });
  mostrarResultado(`POST /casal (sem text) → ${semText.status} (esperado 400)`, semText.status === 400);

  // Text vazio → 400
  const vazio = await req("POST", "/casal", { text: "   " });
  mostrarResultado(`POST /casal (vazio) → ${vazio.status} (esperado 400)`, vazio.status === 400);

  // GET
  const get = await req("GET", "/casal");
  mostrarResultado(
    `GET /casal → ${get.status} (${get.data?.length ?? 0} itens)`,
    get.status === 200 && Array.isArray(get.data)
  );

  // GET ?done=false
  const getPending = await req("GET", "/casal?done=false");
  mostrarResultado(
    `GET /casal?done=false → ${getPending.status} (${getPending.data?.length ?? 0} itens)`,
    getPending.status === 200 && getPending.data?.every((t) => t.done === false)
  );

  // GET ?done=true
  const getDone = await req("GET", "/casal?done=true");
  mostrarResultado(
    `GET /casal?done=true → ${getDone.status} (${getDone.data?.length ?? 0} itens)`,
    getDone.status === 200 && getDone.data?.every((t) => t.done === true)
  );

  // PUT done
  if (id) {
    const put = await req("PUT", `/casal?id=${id}`, { done: true });
    mostrarResultado(
      `PUT /casal done:true → ${put.status}`,
      put.status === 200 && put.data?.done === true
    );
  }

  // PUT text/priority
  if (id) {
    const put2 = await req("PUT", `/casal?id=${id}`, { text: "Louça lavada", priority: "baixa" });
    mostrarResultado(
      `PUT /casal text/priority → ${put2.status}`,
      put2.status === 200 && put2.data?.text === "Louça lavada" && put2.data?.priority === "baixa"
    );
  }

  // PUT sem id → 400
  const putSemId = await req("PUT", "/casal", { done: true });
  mostrarResultado(`PUT /casal (sem id) → ${putSemId.status} (esperado 400)`, putSemId.status === 400);

  // DELETE
  if (id) {
    const del = await req("DELETE", `/casal?id=${id}`);
    mostrarResultado(
      `DELETE /casal?id=... → ${del.status}`,
      del.status === 200 && del.data?.deleted === true
    );
  }
  if (idSoTexto) await req("DELETE", `/casal?id=${idSoTexto}`);

  // DELETE sem id → 400
  const delSemId = await req("DELETE", "/casal");
  mostrarResultado(`DELETE /casal (sem id) → ${delSemId.status} (esperado 400)`, delSemId.status === 400);
}

// ============================================================
// CASAL — dados genéricos
// ============================================================
async function testCasalData() {
  titulo("CASAL — Dados genéricos (CoupleData)");

  // GET key que não existe → { key, value: null }
  const getVazio = await req("GET", "/casal/data?key=mimos");
  const getVazioOk = getVazio.status === 200 && getVazio.data?.key === "mimos" && getVazio.data?.value === null;
  mostrarResultado(`GET /casal/data?key=mimos (vazio) → ${getVazio.status}`, getVazioOk, getVazio.data);

  // PUT mimos
  const mimosPayload = {
    value: {
      historico: [{ data: TEST_DATE, mimo: "Café na cama", para: "Lais" }],
      custom: ["Massagem nos pés", "Bilhete de amor"],
    },
  };
  const put = await req("PUT", "/casal/data?key=mimos", mimosPayload);
  const putOk =
    put.status === 200 &&
    put.data?.key === "mimos" &&
    put.data?.value?.historico?.length === 1 &&
    put.data?.value?.custom?.length === 2;
  mostrarResultado(`PUT /casal/data?key=mimos → ${put.status}`, putOk, put.data);

  // GET de volta
  const get = await req("GET", "/casal/data?key=mimos");
  const getOk =
    get.status === 200 && get.data?.value?.historico?.[0]?.mimo === "Café na cama";
  mostrarResultado(`GET /casal/data?key=mimos → ${get.status}`, getOk, get.data);

  // PUT planos
  const putPlanos = await req("PUT", "/casal/data?key=planos", {
    value: [
      { id: "p1", nome: "Conhecer Pipa", categoria: "viagem", feito: false },
      { id: "p2", nome: "Jantar italiano", categoria: "date", feito: true },
    ],
  });
  mostrarResultado(
    `PUT /casal/data?key=planos → ${putPlanos.status}`,
    putPlanos.status === 200 && putPlanos.data?.value?.length === 2
  );

  // PUT metas
  const putMetas = await req("PUT", "/casal/data?key=metas", {
    value: [{ id: "m1", nome: "Economizar", progresso: 45, prazo: "2027-03-01" }],
  });
  mostrarResultado(
    `PUT /casal/data?key=metas → ${putMetas.status}`,
    putMetas.status === 200 && putMetas.data?.value?.[0]?.progresso === 45
  );

  // PUT checkins
  const putCheckins = await req("PUT", "/casal/data?key=checkins", {
    value: [{ data: TEST_DATE, quem: "João", humor: 5, nota: "Dia leve" }],
  });
  mostrarResultado(
    `PUT /casal/data?key=checkins → ${putCheckins.status}`,
    putCheckins.status === 200 && putCheckins.data?.value?.length === 1
  );

  // GET sem key → 400
  const semKey = await req("GET", "/casal/data");
  mostrarResultado(`GET /casal/data (sem key) → ${semKey.status} (esperado 400)`, semKey.status === 400);

  // GET key inválida → 400
  const keyInvalida = await req("GET", "/casal/data?key=foobar");
  mostrarResultado(`GET /casal/data?key=foobar → ${keyInvalida.status} (esperado 400)`, keyInvalida.status === 400);

  // PUT sem value → 400
  const semValue = await req("PUT", "/casal/data?key=mimos", {});
  mostrarResultado(`PUT /casal/data (sem value) → ${semValue.status} (esperado 400)`, semValue.status === 400);

  // PUT key inválida → 400
  const putKeyInv = await req("PUT", "/casal/data?key=foobar", { value: {} });
  mostrarResultado(`PUT /casal/data?key=foobar → ${putKeyInv.status} (esperado 400)`, putKeyInv.status === 400);
}

// ============================================================
// 404
// ============================================================
async function test404() {
  titulo("404 — rota inexistente");
  const { status, data } = await req("GET", "/rota-que-nao-existe");
  mostrarResultado(`GET /rota-que-nao-existe → ${status} (esperado 404)`, status === 404, data);
}

// ============================================================
// RUNNER
// ============================================================
async function main() {
  console.log("");
  console.log(`${c.cyan}${c.bold}╔══════════════════════════════════════════════════════╗${c.reset}`);
  console.log(`${c.cyan}${c.bold}║  🧪 testRotas.js — testando API                      ║${c.reset}`);
  console.log(`${c.cyan}${c.bold}║  ➜  ${BASE.padEnd(46)}║${c.reset}`);
  console.log(`${c.cyan}${c.bold}╚══════════════════════════════════════════════════════╝${c.reset}`);

  try {
    const ping = await fetch(BASE + "/");
    if (!ping.ok && ping.status !== 500) throw new Error("Servidor respondeu " + ping.status);
  } catch (e) {
    console.log("");
    console.log(`${c.red}❌ Não consegui conectar em ${BASE}${c.reset}`);
    console.log(`   ${c.dim}(${e.message})${c.reset}`);
    process.exit(1);
  }

  try {
    await testHealth();
    await testAuth();
    await testCouple();
    await testInviteFlow();
    await testNotifRejectCancel();
    await testDependent();
    await testRegistros();
    await testSummary();
    await testCasalTarefas();
    await testCasalData();
    await test404();
  } catch (e) {
    console.log("");
    console.log(`${c.red}❌ Erro inesperado: ${e.message}${c.reset}`);
    console.error(e);
  }

  console.log("");
  console.log(`${c.magenta}${c.bold}━━━ Resultado ━━━${c.reset}`);
  console.log(`  ${c.green}✔ Passou: ${passou}${c.reset}`);
  console.log(`${falhou > 0 ? c.red : c.green}  ✘ Falhou: ${falhou}${c.reset}`);
  console.log("");

  process.exit(falhou === 0 ? 0 : 1);
}

main();