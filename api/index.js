// ============================================================
// api/index.js — entrypoint único (local + Vercel)
// ============================================================

import express from "express";
import { ENV, prisma } from "../src/config.js";
import { cors, notFoundHandler, errorHandler } from "../src/middleware.js";
import { requestLogger } from "../src/registerlogs.js";
import routes from "../src/routes.js";

const app = express();

app.set("trust proxy", 1);

// requestLogger ANTES de express.json
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
if (!process.env.VERCEL) {
  const PORT = ENV.PORT || 3000;
  const server = app.listen(PORT, () => {
    console.log(`🚀 http://localhost:${PORT}`);
    console.log(`   env: ${ENV.NODE_ENV}`);
    console.log(`   log mode: ${process.env.LOG_MODE || "stdout"}`);
  });

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
    setTimeout(() => {
      console.error("Timeout no shutdown, forçando saída.");
      process.exit(1);
    }, 10_000).unref();
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

export default app;