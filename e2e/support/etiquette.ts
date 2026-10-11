// ETIQUETTE の確認（Ack。#226・D145）の E2E の共通手順: RULING → ETIQUETTE の欄の Locator、要求の数え方、server の SSE の読み取り、
// Hero が Bet に直面する手番までの進め方。テストの手順だけの待ち・読み取りで、プロダクトの挙動は変えない（自動で確認しない）。
import { expect, type Locator, type Page } from "@playwright/test";
import { startNextHand } from "./next-hand.js";
import { E2E_SERVER_PORT } from "./server.js";

/** RULING の欄（裁定の事実。数秒で自動で閉じる）。 */
export function rulingOverlay(page: Page): Locator {
  return page.getByRole("status", { name: "Dealer の裁定", exact: true });
}

/** ETIQUETTE の欄（作法の注意。「確認しました」を押すまで閉じない）。 */
export function etiquetteOverlay(page: Page): Locator {
  return page.getByRole("alertdialog", {
    name: "Dealer からの作法の注意",
    exact: true,
  });
}

/** ETIQUETTE の欄の「確認しました」。 */
export function ackButton(page: Page): Locator {
  return etiquetteOverlay(page).getByRole("button", { name: "確認しました" });
}

/** 卓の操作（Action・物理的な操作）の要求か。 */
export function isHandOperation(method: string, url: string): boolean {
  const path = new URL(url).pathname;
  return (
    method === "POST" &&
    /^\/api\/hands\/[^/]+\/(actions|physical-actions)$/.test(path)
  );
}

/** 確認（Ack）の要求か。 */
export function isEtiquetteAck(method: string, url: string): boolean {
  return (
    method === "POST" &&
    /^\/api\/hands\/[^/]+\/etiquette-ack$/.test(new URL(url).pathname)
  );
}

/** match に合う要求を数え始める。返す関数で、それまでに送った数を読む。 */
export function countRequests(
  page: Page,
  match: (method: string, url: string) => boolean,
): () => number {
  let count = 0;
  page.on("request", (request) => {
    if (match(request.method(), request.url())) count++;
  });
  return () => count;
}

/** server の HeroView のうち、E2E で読む部分（apps/server の応答の形）。 */
export interface StreamView {
  readonly handId: string;
  readonly status: "in_progress" | "complete";
  readonly pot: number;
  readonly actorId: string | null;
  readonly viewerId: string;
  readonly legalActions: { readonly toCall: number } | null;
  readonly seats: readonly {
    readonly playerId: string;
    readonly stack: number;
  }[];
  readonly log: readonly { readonly seq: number; readonly type: string }[];
}

export interface EtiquetteState {
  readonly revision: number;
  readonly pendingRulingSeq: number | null;
}

export interface StreamSnapshot {
  readonly view: StreamView;
  readonly etiquette: EtiquetteState | null;
  readonly session: { readonly state: string } | null;
}

/** View の log の最後の seq（操作の要求の lastSeq）。 */
export function lastSeqOf(view: StreamView): number {
  return view.log.at(-1)?.seq ?? -1;
}

/**
 * server の卓の SSE（/api/hands/:handId/stream）を、ブラウザを通さずに直接読み、until に合う View が届いたらその時点の
 * View・確認・Session の状態を返す（接続の直後に確認の状態・View が 1 回ずつ届く。until を省くと最初の View で返す）。
 * GET の照会が無いので、Hero の画面と同じ Push を観測して最新の lastSeq を得るために使う。
 */
export async function readStream(
  handId: string,
  until: (s: StreamSnapshot) => boolean = () => true,
  timeoutMs = 15_000,
): Promise<StreamSnapshot> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const res = await fetch(
      `http://127.0.0.1:${E2E_SERVER_PORT}/api/hands/${handId}/stream`,
      { signal: abort.signal },
    );
    if (!res.ok || res.body === null) {
      throw new Error(`SSE を開けなかった: ${res.status}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let etiquette: EtiquetteState | null = null;
    let session: { state: string } | null = null;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error("条件に合う View の前に SSE が閉じた");
      buffer += decoder.decode(value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const chunk = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const name = /^event: (\w+)$/m.exec(chunk)?.[1];
        const data = /^data: (.*)$/m.exec(chunk)?.[1];
        if (name === undefined || data === undefined) continue;
        const parsed: unknown = JSON.parse(data);
        if (name === "etiquette") etiquette = parsed as EtiquetteState;
        if (name === "session") session = parsed as { state: string };
        if (name === "view") {
          const snapshot = { view: parsed as StreamView, etiquette, session };
          if (until(snapshot)) return snapshot;
        }
      }
    }
  } finally {
    clearTimeout(timer);
    abort.abort();
  }
}

/** server へ直接 JSON を POST する（ブラウザの画面を通さない手順。応答の status と本文を返す）。 */
export async function postServer(
  path: string,
  body: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${E2E_SERVER_PORT}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return {
    status: res.status,
    json: (await res.json()) as Record<string, unknown>,
  };
}

/** 宣言 Button の補助の額（Call は Legal Action の額。合法でなければ出ない）。 */
async function callAmount(page: Page): Promise<number | null> {
  const amount = page
    .getByRole("region", { name: "Hero" })
    .getByRole("button", { name: /^コール（Call）/ })
    .locator(".declaration__amount");
  if ((await amount.count()) === 0) return null;
  const match = /^\d+/.exec((await amount.innerText()).replace(/[,，]/g, ""));
  return match === null ? null : Number(match[0]);
}

/**
 * Hero が Bet に直面した手番（Call の額がある Hero の手番）まで、画面の操作で進める（Call 額の無い手番は Check、Hand が終われば
 * 「次の Hand へ」）。その手番の Hand の handId を返す。handId は今の Hand（開始の応答の値）。
 */
export async function untilHeroFacesBet(
  page: Page,
  handId: string,
): Promise<string> {
  const dock = page.getByRole("region", { name: "Hero" });
  const log = page.getByRole("region", { name: "Hand の進行" }).locator("li");
  let current = handId;
  for (let turn = 0; turn < 60; turn++) {
    const done = dock.getByText("Hand が終了しました。");
    await expect(dock.getByText("Hero の手番です。").or(done)).toBeVisible({
      timeout: 30_000,
    });
    if (await done.isVisible()) {
      current = await startNextHand(page);
      continue;
    }
    if ((await callAmount(page)) !== null) return current;
    const before = await log.count();
    await dock.getByRole("button", { name: /^チェック（Check）/ }).click();
    await expect
      .poll(() => log.count(), { timeout: 30_000 })
      .toBeGreaterThan(before);
  }
  throw new Error("Hero が Bet に直面する手番が来なかった");
}

/**
 * 2 人卓の Session を、画面を通さずに server の API だけで、Ack の確認を待ったまま終わるまで進め、その最後の Hand の handId を返す。
 * Hero は Call できれば Call、できなければ Check。Call が All-in になる手番（Action を閉じ、残りの Board を配って Hand が終わる）だけ、
 * 宣言を 2 つ送る（2 つ目は declaration_ignored で、確認が要る。Hand は Hero の Call で終わるので、確認の待ちは Hand の後に残る）。
 * その Hand で Session が終わらなければ、確認して次の Hand へ進む。確認はテストの手順としてだけ送る（プロダクトは自動で確認しない）。
 */
export async function playUntilSessionEndsAwaitingAck(
  maxHands = 80,
): Promise<string> {
  const turnOrEnd = (s: StreamSnapshot) =>
    s.view.legalActions !== null ||
    s.view.status === "complete" ||
    s.etiquette?.pendingRulingSeq != null;
  let started = await postServer("/api/hands", {
    afterHandId: null,
    session: { mode: "cash" },
  });
  for (let hand = 0; hand < maxHands; hand++) {
    expect(started.status, "Hand の開始").toBeLessThan(300);
    const handId = started.json["handId"] as string;
    for (let turn = 0; turn < 40; turn++) {
      const { view, etiquette } = await readStream(handId, turnOrEnd);
      expect(etiquette?.pendingRulingSeq ?? null, "確認の待ち").toBeNull();
      if (view.status === "complete") break;
      const toCall = view.legalActions?.toCall ?? 0;
      const stack =
        view.seats.find((s) => s.playerId === view.viewerId)?.stack ?? 0;
      const declare = {
        type: "declare",
        declaration: { kind: toCall > 0 ? "call" : "check" },
      };
      const allInCall = toCall > 0 && toCall >= stack;
      const res = await postServer(`/api/hands/${handId}/physical-actions`, {
        lastSeq: lastSeqOf(view),
        actions: allInCall ? [declare, declare] : [declare],
      });
      expect(res.status, "Hero の操作").toBe(200);
      if (!allInCall) continue;
      const session = res.json["session"] as { state: string } | null;
      const pending = (res.json["etiquette"] as EtiquetteState | null)
        ?.pendingRulingSeq;
      expect(pending, "2 つ目の宣言は確認が要る").not.toBeNull();
      if (session?.state === "ended") return handId;
      const ack = await postServer(`/api/hands/${handId}/etiquette-ack`, {
        rulingSeq: pending,
      });
      expect(ack.status, "確認").toBe(200);
    }
    started = await postServer("/api/hands", { afterHandId: handId });
  }
  throw new Error(`${maxHands} Hand で Session が終わらなかった`);
}
