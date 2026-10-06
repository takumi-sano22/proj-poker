// Property テスト（fast-check）の共通パラメータ（#95・poker-engine-testing §5）。
// fast-check の seed は既定では実行ごとに変わり、失敗の再現にも記録にも使えない。ここで seed を 1 つに決めて fc.assert へ渡し、
//  - 失敗したとき: fast-check の出力（`{ seed: …, path: … }` と縮小済みの Counterexample）で、そのまま再現できる
//  - 失敗しない検査（網羅の確認など）が落ちたとき: 呼び出し側が `params.seed` をメッセージへ入れられる
// ようにする。環境変数で注入できる（Engine は I/O を持たないので型を持ち込まず、globalThis から読む）。
//   POKER_PROPERTY_SEED=<整数>          その seed で全 Property を流す（失敗の再現）
//   POKER_PROPERTY_RUNS_FACTOR=<整数>   ケース数を何倍にするか（数万ケースの Soak 用。既定 1）
type Env = Record<string, string | undefined>;
const env: Env = (globalThis as { process?: { env?: Env } }).process?.env ?? {};

function intFromEnv(name: string): number | undefined {
  const raw = env[name];
  if (raw === undefined || raw === "") return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${name} は整数で指定する（指定値: ${raw}）`);
  }
  return value;
}

const runsFactor = intFromEnv("POKER_PROPERTY_RUNS_FACTOR") ?? 1;
if (runsFactor < 1) throw new Error("POKER_PROPERTY_RUNS_FACTOR は 1 以上");
const envSeed = intFromEnv("POKER_PROPERTY_SEED");

export interface PropertyParams {
  numRuns: number;
  seed: number;
}

/** fc.assert の第 2 引数。`numRuns` は factor 倍され、`seed` は環境変数があればそれ、無ければ実行ごとの乱数。 */
export function propertyParams(numRuns = 100): PropertyParams {
  return {
    numRuns: numRuns * runsFactor,
    seed: envSeed ?? Math.floor(Math.random() * 2 ** 31),
  };
}
