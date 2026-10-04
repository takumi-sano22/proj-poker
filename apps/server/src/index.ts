import { buildApp } from "./app.js";

// ローカル専用（D61・非目標: Auth / Online Multiplayer）。外部 NIC へ公開しないため loopback に固定し、設定で変えさせない。
const HOST = "127.0.0.1";
const PORT = Number(process.env["PORT"] ?? 3001);

const app = buildApp();

try {
  await app.listen({ host: HOST, port: PORT });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
