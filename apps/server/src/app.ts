import Fastify from "fastify";

// listen と分けて組み立てだけを export する。後続 Issue でテストから起動せずに叩けるようにするため。
export function buildApp() {
  const app = Fastify({ logger: true });

  // Phase 0 は疎通確認用の health だけ。ドメイン API は Phase 1 以降で足す。
  app.get("/api/health", async () => ({ status: "ok" }));

  return app;
}
