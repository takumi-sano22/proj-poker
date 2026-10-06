// Solver の子プロセスを 1 回だけ動かす（#81）。Timeout と Cancel（AbortSignal）で SIGKILL し、
// プロセスが終わる（close）まで待ってから結果を返すので、戻った時点で孤児は残っていない（implementation-guidance async）。
// 途中結果は無いので、止めたら「結果なし」（呼び出し側が Fallback する）。
import { spawn } from "node:child_process";

export interface ProcessCommand {
  readonly file: string;
  readonly args: readonly string[];
}

export type ProcessOutcome =
  | {
      readonly kind: "exited";
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
      readonly stdout: string;
      readonly stderr: string;
      readonly wallMs: number;
    }
  | { readonly kind: "timeout"; readonly wallMs: number }
  | { readonly kind: "cancelled"; readonly wallMs: number }
  /** 起動できない（実行ファイルが無い等）・出力が上限を超えた。 */
  | {
      readonly kind: "failed";
      readonly message: string;
      readonly wallMs: number;
    };

/** stdout / stderr を溜める上限。Root の戦略だけを出す想定なので、超えたら異常として止める。 */
export const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

export function runProcess(
  command: ProcessCommand,
  stdin: string,
  options: { readonly timeoutMs: number; readonly signal?: AbortSignal },
): Promise<ProcessOutcome> {
  return new Promise((resolve) => {
    const started = performance.now();
    const elapsed = () => Math.round(performance.now() - started);
    if (options.signal?.aborted) {
      resolve({ kind: "cancelled", wallMs: 0 });
      return;
    }

    // 止めた理由（close のときに結果の種類を決める）。
    let stopReason: "timeout" | "cancelled" | "overflow" | null = null;
    let spawnError: string | null = null;
    const child = spawn(command.file, [...command.args], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stop = (reason: "timeout" | "cancelled" | "overflow") => {
      if (stopReason !== null) return;
      stopReason = reason;
      // Solver は SIGTERM で穏当に止まるか未検証（#76）なので、確実に回収できる SIGKILL にする。
      child.kill("SIGKILL");
    };

    const timer = setTimeout(() => stop("timeout"), options.timeoutMs);
    const onAbort = () => stop("cancelled");
    options.signal?.addEventListener("abort", onAbort, { once: true });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    const collect = (into: Buffer[]) => (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) {
        stop("overflow");
        return;
      }
      into.push(chunk);
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    // 子が stdin を読まずに終わると EPIPE になる。失敗は close の exit code / 出力で判定するので、ここでは扱わない。
    child.stdin.on("error", () => undefined);
    child.on("error", (error) => {
      spawnError = error.message;
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      const wallMs = elapsed();
      if (spawnError !== null) {
        resolve({ kind: "failed", message: spawnError, wallMs });
      } else if (stopReason === "timeout") {
        resolve({ kind: "timeout", wallMs });
      } else if (stopReason === "cancelled") {
        resolve({ kind: "cancelled", wallMs });
      } else if (stopReason === "overflow") {
        resolve({
          kind: "failed",
          message: `出力が上限（${MAX_OUTPUT_BYTES} bytes）を超えた`,
          wallMs,
        });
      } else {
        resolve({
          kind: "exited",
          code,
          signal,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
          wallMs,
        });
      }
    });

    child.stdin.end(stdin);
  });
}
