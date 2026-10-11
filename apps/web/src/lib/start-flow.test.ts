// Hand の開始の流れ（runStart。#218 の 2 段階の開始・#226 の ETIQUETTE の確認待ち）。偽の request 関数で、送る回数・
// afterHandId・失敗からの復帰を確かめる。
import { describe, expect, it } from "vitest";
import { ApiError, type StartHandResponse } from "./api.js";
import { runStart, type StartRequest } from "./start-flow.js";

const SESSION = { preset: "cash" } as never;

/** 結果を見ていない終わった Session の最後の Hand（view.status complete・session.state ended）。 */
function endedHand(handId: string, etiquette?: unknown): StartHandResponse {
  return {
    handId,
    view: { status: "complete" },
    session: { state: "ended" },
    etiquette,
  } as unknown as StartHandResponse;
}

function liveHand(handId: string): StartHandResponse {
  return {
    handId,
    view: { status: "in_progress" },
    session: { state: "in_hand" },
  } as unknown as StartHandResponse;
}

/** 呼ばれた afterHandId を記録し、渡した結果を順に返す（Error は reject）偽の request。 */
function fakeRequest(...results: (StartHandResponse | Error)[]) {
  const calls: (string | null)[] = [];
  const request: StartRequest = (after) => {
    calls.push(after);
    const r = results[calls.length - 1];
    if (r === undefined) return Promise.reject(new Error("想定外の呼び出し"));
    return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
  };
  return { request, calls };
}

describe("runStart", () => {
  it("通常は 1 回だけ送る", async () => {
    const res = liveHand("h2");
    const { request, calls } = fakeRequest(res);
    const out = await runStart(request, "h1", SESSION);
    expect(out).toEqual({ kind: "started", res, awaitingEtiquette: false });
    expect(calls).toEqual(["h1"]);
  });

  it("終わった Session の最後の Hand が ETIQUETTE の確認を待っていれば、2 回目を送らず確認待ちで開く", async () => {
    const first = endedHand("h9", { revision: 1, pendingRulingSeq: 7 });
    const { request, calls } = fakeRequest(first);
    const out = await runStart(request, "h1", SESSION);
    expect(out).toEqual({
      kind: "started",
      res: first,
      awaitingEtiquette: true,
    });
    expect(calls).toEqual(["h1"]);
  });

  it("確認を待っていなければ（pendingRulingSeq が null）、その Hand を見たものとして 2 回目を送る", async () => {
    const first = endedHand("h9", { revision: 1, pendingRulingSeq: null });
    const second = liveHand("h10");
    const { request, calls } = fakeRequest(first, second);
    const out = await runStart(request, "h1", SESSION);
    expect(out).toEqual({
      kind: "started",
      res: second,
      awaitingEtiquette: false,
    });
    expect(calls).toEqual(["h1", "h9"]);
  });

  it("etiquette の形が不正（revision が文字列）なら待ちなしとして扱い、2 回目を送る", async () => {
    const first = endedHand("h9", { revision: "x" });
    const second = liveHand("h10");
    const { request, calls } = fakeRequest(first, second);
    const out = await runStart(request, "h1", SESSION);
    expect(out.kind).toBe("started");
    expect(calls).toEqual(["h1", "h9"]);
  });

  it("2 回目が etiquette_ack_required なら failed で、1 回目の応答（Hand ID と etiquette）を失わず、再送しない", async () => {
    // 1 回目では待ちが見えなかった（etiquette 無し）が、server は確認待ちと判断した場合。
    const first = endedHand("h9");
    const error = new ApiError("etiquette_ack_required", "確認が必要");
    const { request, calls } = fakeRequest(first, error);
    const out = await runStart(request, "h1", SESSION);
    expect(out).toEqual({
      kind: "failed",
      error,
      sentAfter: "h9",
      awaitingHand: first,
    });
    expect(calls).toEqual(["h1", "h9"]);
  });

  it("2 回目が別のエラーなら awaitingHand は null で、sentAfter は 1 回目の handId", async () => {
    const first = endedHand("h9");
    const error = new ApiError("network", "届かない");
    const { request, calls } = fakeRequest(first, error);
    const out = await runStart(request, "h1", SESSION);
    expect(out).toEqual({
      kind: "failed",
      error,
      sentAfter: "h9",
      awaitingHand: null,
    });
    expect(calls).toHaveLength(2);
  });

  it("1 回目が失敗したら sentAfter は元の afterHandId", async () => {
    const error = new ApiError("network", "届かない");
    const { request, calls } = fakeRequest(error);
    const out = await runStart(request, "h1", SESSION);
    expect(out).toEqual({
      kind: "failed",
      error,
      sentAfter: "h1",
      awaitingHand: null,
    });
    expect(calls).toEqual(["h1"]);
  });
});
