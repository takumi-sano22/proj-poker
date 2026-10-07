// E2E の Local Runtime（apps/server）の起動と停止。Resume（再起動後に同じ Session を続ける。D62・D95）を確かめるため、
// テストの途中で止めて同じ DB で起動し直せるよう、Playwright の webServer ではなくテストから子プロセスとして動かす。
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

export const SERVER_DIR = fileURLToPath(
  new URL("../../apps/server/", import.meta.url),
);

/** E2E の server のポート。手元の `pnpm dev`（3001）と重ならない値（web の proxy も同じ値を PORT で受ける）。 */
export const E2E_SERVER_PORT = 3101;
/** E2E の web（Vite）のポート。 */
export const E2E_WEB_PORT = 5174;

/**
 * 決定論にするための設定（D98）: 山札の seed を固定し、CPU は RuleBot、Review AI は固定応答（Claude を呼ばない）。
 * CPU の思考の演出の待ちは 0 にする。Solver は導入先を渡さない（Unsupported として Fallback する）。
 * overrides はテストごとの差分（卓の人数・固定応答の段階評価など。#119）で、既定の値より優先する。
 */
export function e2eServerEnv(
  dbPath: string,
  overrides: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  // 手元の環境に Solver・Claude・Persona の設定が残っていても E2E には持ち込まない（Persona の順番は RuleBot の判断を変える）。
  for (const key of [
    "POKER_SOLVER_HOME",
    "CPU_PERSONAS",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "FAKE_REVIEW_ASSESSMENT",
  ]) {
    delete env[key];
  }
  return {
    ...env,
    PORT: String(E2E_SERVER_PORT),
    POKER_DB_PATH: dbPath,
    POKER_SEED: "20261006",
    TABLE_SIZE: "6",
    OPPONENT_PROVIDER: "rulebot",
    REVIEW_PROVIDER: "fake",
    BOT_THINK_DELAY_MS: "0",
    ...overrides,
  };
}

export interface RunningServer {
  readonly process: ChildProcess;
  /** 起動からの標準出力・標準エラー（失敗時の手がかり）。 */
  readonly output: () => string;
}

async function healthy(): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${E2E_SERVER_PORT}/api/health`);
    return res.ok;
  } catch {
    return false;
  }
}

/** server を起動し、/api/health が応答するまで待つ。overrides は e2eServerEnv の既定の値への差分。 */
export async function startServer(
  dbPath: string,
  overrides: Readonly<Record<string, string>> = {},
): Promise<RunningServer> {
  // 別の server がポートを使っていると、その応答を起動の完了と取り違える（違う DB・設定で通ってしまう）ので、先に止める。
  if (await healthy()) {
    throw new Error(
      `127.0.0.1:${E2E_SERVER_PORT} で別の server が動いている。止めてから E2E を実行する`,
    );
  }
  // tsx のローダーで src を直接動かす（dev と同じく Engine は build せずに src から読む）。watch はしない。
  const child = spawn(
    process.execPath,
    ["--conditions=@proj-poker/source", "--import", "tsx", "src/index.ts"],
    { cwd: SERVER_DIR, env: e2eServerEnv(dbPath, overrides), stdio: "pipe" },
  );
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
  const server = { process: child, output: () => output };
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`server が起動前に終了した:\n${output}`);
    }
    if (await healthy()) return server;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  await stopServer(server);
  throw new Error(`server が 30 秒で起動しなかった:\n${output}`);
}

/** server を止める（アプリの終了。SIGTERM で止まらなければ SIGKILL）。 */
export async function stopServer(server: RunningServer): Promise<void> {
  const child = server.process;
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
  await exited;
  clearTimeout(timer);
}
