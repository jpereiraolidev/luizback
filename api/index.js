// ============================================================
// api/index.js — entrypoint único (local + Vercel)
// ------------------------------------------------------------
// Funciona dos dois jeitos:
//   - Local:   `node api/index.js`  → sobe em http://localhost:3000
//   - Vercel:  a plataforma importa `default` e chama como handler
// ============================================================

import express from "express";
import { ENV, prisma } from "../src/config.js";
import { cors, notFoundHandler, errorHandler } from "../src/middleware.js";
import routes from "../src/routes.js";

// ✅ NOVO: logger estruturado
import { requestLogger } from "../src/registerlogs.js";

const app = express();

// ✅ NOVO: confiança no proxy (Vercel)
// Faz req.ip refletir o IP real do cliente atrás do proxy da Vercel.
// Necessário para o requestLogger registrar o IP correto.
app.set("trust proxy", 1);

// ✅ NOVO: requestLogger ANTES de express.json
// Precisa vir primeiro para capturar:
//   - headers (Content-Length, User-Agent, X-Forwarded-For)
//   - body cru (mesmo quando o JSON for inválido)
// Se fosse depois do express.json, o body inválido mataria a request
// antes do logger conseguir ver.
app.use(requestLogger);

// ---------- MIDDLEWARES GLOBAIS ----------
app.use(express.json({ limit: "2mb" }));
app.use(cors);

// ---------- ROTAS ----------
app.use(routes);

// ---------- 404 + ERROR HANDLER ----------
app.use(notFoundHandler);
app.use(errorHandler);

// ---------- LISTEN (apenas fora da Vercel) ----------
// A Vercel define `process.env.VERCEL = "1"` automaticamente.
// Rodando local (`node api/index.js`) essa env não existe → dá listen.
if (!process.env.VERCEL) {
  const PORT = ENV.PORT || 3000;
  const server = app.listen(PORT, () => {
    console.log(`🚀 http://localhost:${PORT}`);
    console.log(`   env: ${ENV.NODE_ENV}`);
    console.log(`   log mode: ${process.env.LOG_MODE || "stdout"}`);
  });

  // ✅ NOVO: graceful shutdown em local/staging
  // Fecha o HTTP server e desconecta o Prisma antes de sair.
  // Em Vercel isso não roda (o container é gerenciado pela plataforma).
  const shutdown = async (signal) => {
    console.log(`\n${signal} recebido, encerrando graciosamente...`);
    server.close(async () => {
      try {
        await prisma.$disconnect();
        console.log("Prisma desconectado. Bye.");
      } catch (e) {
        console.error("Erro ao desconectar Prisma:", e.message);
      }
      process.exit(0);
    });

    // Se não fechar em 10s, força saída
    setTimeout(() => {
      console.error("Timeout no shutdown, forçando saída.");
      process.exit(1);
    }, 10_000).unref();
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

// ---------- EXPORT ----------
// A Vercel usa esse default export como handler.
// O Express app já é uma função (req, res, next), então serve direto.
export default app;