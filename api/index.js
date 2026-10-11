// ============================================================
// api/index.js — entrypoint único (local + Vercel)
// ============================================================
// Funciona dos dois jeitos:
//   - Local:   `node api/index.js`  → sobe em http://localhost:3000
//   - Vercel:  a plataforma importa `default` e chama como handler
// ============================================================

import express from "express";
import { ENV } from "../src/config.js";
import { cors, notFoundHandler, errorHandler } from "../src/middleware.js";
import routes from "../src/routes.js";

const app = express();

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
  app.listen(PORT, () => {
    console.log(`🚀 http://localhost:${PORT}`);
  });
}

// ---------- EXPORT ----------
// A Vercel usa esse default export como handler.
// O Express app já é uma função (req, res, next), então serve direto.
export default app;