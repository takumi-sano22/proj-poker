// ETIQUETTE の確認（Ack。#226・D142・D145・docs/06 §6）の E2E: 裁定（RULING）の後の作法の注意（ETIQUETTE）は、Hero が「確認しました」を
// 押すまで進行（CPU・Hero の操作・次の Hand の開始）を止め、画面の移動・再読み込み・SSE の切断・Hand や Session の終わり・Drill の卓を
// 挟んでも待ちが残ることを、実サーバー（RuleBot・固定の山札）で確かめる。確認はテストの手順としてだけ送る（プロダクトは自動で確認しない）。
// HAND_ABORTED・CPU の障害との重なりは、E2E で障害を起こす手段が無い（RuleBot は失敗しない・実モデルを呼ばない）ので扱わない。
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, connect, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  ackButton,
  countRequests,
  etiquetteOverlay,
  isEtiquetteAck,
  isHandOperation,
  lastSeqOf,
  playUntilSessionEndsAwaitingAck,
  readStream,
  rulingOverlay,
  untilHeroFacesBet,
} from "../support/etiquette.js";
import { startNextHand } from "../support/next-hand.js";
import { countHandStarts, startFirstHand } from "../support/play.js";
import {
  E2E_WEB_PORT,
  startServer,
  stopServer,
  type RunningServer,
} from "../support/server.js";

/** 既定の 6 人卓で、最初の Hand の Hero の手番に Call 額がある山札（table-layout.spec.ts と同じ）。 */
const SEED = "20261042";

/** 宣言の Button の名前（Hero 欄の「宣言（Declaration）」の中）。 */
const DECLARATIONS = [
  "フォールド（Fold）",
  "チェック（Check）",
  "コール（Call）",
  "ベット（Bet）",
  "レイズ（Raise）",
  "オールイン（All-in）",
] as const;

let dir = "";
let server: RunningServer | null = null;
let proxy: CuttableProxy | null = null;

test.beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "proj-poker-e2e-etiquette-"));
});

// Playwright は第 1 引数（fixture）を分割代入で受けることを求めるので、使わない fixture も {} で受ける。
// eslint-disable-next-line no-empty-pattern
test.afterEach(async ({}, testInfo) => {
  if (server !== null) {
    // 失敗したら server のログを添付する（原因の手がかり）。
    if (testInfo.status !== testInfo.expectedStatus) {
      await testInfo.attach("server.log", {
        body: server.output(),
        contentType: "text/plain",
      });
    }
    await stopServer(server);
    server = null;
  }
  if (proxy !== null) {
    await proxy.close();
    proxy = null;
  }
  rmSync(dir, { recursive: true, force: true });
});

function dockOf(page: Page) {
  return page.getByRole("region", { name: "Hero" });
}

function declarationButton(page: Page, name: string) {
  return dockOf(page)
    .getByRole("group", { name: "宣言（Declaration）" })
    .getByRole("button", { name });
}

/** 上部のナビゲーションで領域を選び、その領域が今の領域（aria-current）になるのを待つ。 */
async function goTo(page: Page, area: "Home" | "Play" | "Learn") {
  const tab = page
    .getByRole("navigation", { name: "画面の切り替え" })
    .getByRole("button", { name: area });
  await tab.click();
  await expect(tab).toHaveAttribute("aria-current", "page");
}

/** 最初の Hand の Hero の手番で、Call 額があるのに Check を宣言して check_facing_bet（確認が要る）の RULING → ETIQUETTE を出す。 */
async function checkFacingBet(page: Page): Promise<void> {
  const dock = dockOf(page);
  await expect(dock.getByText("Hero の手番です。")).toBeVisible();
  await expect(
    declarationButton(page, "コール（Call）").locator(".declaration__amount"),
  ).toBeVisible();
  await declarationButton(page, "チェック（Check）").click();
  await expect(rulingOverlay(page)).toContainText(
    "相手の Bet があるので、Check の宣言は受けられません。",
  );
  await expect(etiquetteOverlay(page)).toBeVisible();
}

/** 卓の Pot の実額（aria-label の数字）。 */
async function potOf(page: Page): Promise<number> {
  const label =
    (await page
      .getByRole("region", { name: "卓" })
      .locator(".pot")
      .getAttribute("aria-label")) ?? "";
  return Number(/([\d,]+)\s*$/.exec(label)?.[1]?.replace(/,/g, "") ?? NaN);
}

/**
 * listenPort で待ち受け、targetPort へ TCP をそのまま中継する。cut で今の卓の SSE の接続を実際に切り、restore まで新しい SSE の接続を
 * 保留する（応答を返さないので、ブラウザの EventSource は「再接続中」のまま待つ）。restore で保留した接続を先へつなぐ。
 * server・web のプロセスと server の状態（確認の待ち）は残したまま、ネットワークの切断だけを起こすための手順。
 */
interface CuttableProxy {
  cut(): void;
  restore(): void;
  close(): Promise<void>;
}

async function startCuttableProxy(
  listenPort: number,
  targetPort: number,
): Promise<CuttableProxy> {
  // 切るのは HTTP の接続（卓の SSE を含む）だけで、Vite の HMR の WebSocket は切らない（切ると Vite の client がページを再読み込みして
  // しまい、SSE の再接続ではなく再読み込みの確認になる）。ブラウザは keep-alive の接続を SSE に使い回すので、要求の行では分けない。
  const cuttable = new Set<Socket>();
  const all = new Set<Socket>();
  let held: { client: Socket; head: Buffer }[] = [];
  let cutting = false;
  /** http: 切る対象（WebSocket でない HTTP の接続）か。 */
  const relay = (client: Socket, head: Buffer, http: boolean) => {
    const upstream = connect(targetPort, "127.0.0.1");
    for (const s of [client, upstream]) {
      all.add(s);
      if (http) cuttable.add(s);
    }
    const close = () => {
      for (const s of [client, upstream]) {
        s.destroy();
        all.delete(s);
        cuttable.delete(s);
      }
    };
    client.on("error", close).on("close", close);
    upstream.on("error", close).on("close", close);
    upstream.write(head);
    client.pipe(upstream);
    upstream.pipe(client);
  };
  const listener: Server = createServer((client) => {
    client.once("data", (head: Buffer) => {
      const http = !/^upgrade:\s*websocket/im.test(head.toString("latin1"));
      if (cutting && http) {
        client.pause();
        client.on("error", () => client.destroy());
        held.push({ client, head });
        return;
      }
      relay(client, head, http);
    });
  });
  await new Promise<void>((resolve) =>
    listener.listen(listenPort, "127.0.0.1", resolve),
  );
  return {
    cut() {
      cutting = true;
      for (const s of cuttable) s.destroy();
    },
    restore() {
      cutting = false;
      const waiting = held;
      held = [];
      for (const { client, head } of waiting) {
        if (!client.destroyed) relay(client, head, true);
      }
    },
    close() {
      for (const s of all) s.destroy();
      for (const { client } of held) client.destroy();
      return new Promise<void>((resolve) => listener.close(() => resolve()));
    },
  };
}

test("ETIQUETTE の間は CPU・Hero の操作が進まず、確認を連打しても確認の要求は 1 回で、その後に進行が再開する", async ({
  page,
}) => {
  // CPU の思考の待ちを置いて、CPU の手番の間に Hero が手番外（Out of Turn）の宣言をできるようにする。
  server = await startServer(join(dir, "poker.sqlite"), {
    POKER_SEED: SEED,
    BOT_THINK_DELAY_MS: "1500",
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  const dock = dockOf(page);
  const log = page.getByRole("region", { name: "Hand の進行" }).locator("li");
  const table = page.getByRole("region", { name: "卓" });
  const operations = countRequests(page, isHandOperation);
  const acks = countRequests(page, isEtiquetteAck);
  await page.goto("/");
  const handId = await startFirstHand(page);

  await test.step("CPU の手番に Hero が宣言する → 手番外の RULING → ETIQUETTE", async () => {
    await expect(dock.getByText(/^CPU \d+ の手番/)).toBeVisible();
    await declarationButton(page, "フォールド（Fold）").click();
    await expect(rulingOverlay(page)).toContainText("手番ではない操作です。");
    await expect(etiquetteOverlay(page)).toContainText(
      "手番が来るまで操作を待ちましょう。",
    );
    await expect(rulingOverlay(page)).toHaveCount(0);
    await expect(
      dock.getByText(
        "Dealer の作法の注意を確認するまで、進行は止まっています。",
      ),
    ).toBeVisible();
  });

  await test.step("ETIQUETTE の間: CPU が進まず、Hero の宣言を押せず、操作の要求を送らない", async () => {
    const sentBefore = operations();
    const rows = await log.count();
    const tableText = await table.innerText();
    for (const name of DECLARATIONS) {
      await expect(declarationButton(page, name)).toBeDisabled();
    }
    await expect(dock.getByRole("button", { name: /確定して/ })).toBeDisabled();
    // CPU の思考の待ち（1.5 秒）の 2 倍を超えて待っても、進行のログ・卓が変わらない（進まないことの確認だけの固定の待ち）。
    await page.waitForTimeout(3_500);
    expect(await log.count(), "進行のログの行が増えない").toBe(rows);
    expect(await table.innerText(), "卓が変わらない").toBe(tableText);
    expect(operations(), "操作の要求を送らない").toBe(sentBefore);
    // server でも確認を待っている（画面だけが止まっているのではない）。
    const { view, etiquette } = await readStream(handId);
    expect(etiquette?.pendingRulingSeq).not.toBeNull();
    expect(view.log.length).toBeGreaterThan(0);
    await expect(etiquetteOverlay(page)).toBeVisible();
  });

  await test.step("「確認しました」を連打（Enter・click）しても確認の要求は 1 回で、その後に CPU が進む", async () => {
    const rows = await log.count();
    const button = ackButton(page);
    await expect(button).toBeFocused();
    await button.click({ trial: true });
    const box = await button.boundingBox();
    expect(box).not.toBeNull();
    if (box === null) return;
    // フォーカスのある Button への Enter の連打と、同じ位置の click の連打。
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, {
      clickCount: 3,
    });
    await page.keyboard.press("Enter");
    await expect(etiquetteOverlay(page)).toHaveCount(0);
    await expect
      .poll(() => log.count(), { timeout: 15_000 })
      .toBeGreaterThan(rows);
    expect(acks(), "確認の要求は 1 回").toBe(1);
    await expect(
      dock.getByText(
        "Dealer の作法の注意を確認するまで、進行は止まっています。",
      ),
    ).toHaveCount(0);
  });
});

test("ETIQUETTE の間に Home / Learn へ移って Play に戻ると、開始を送らずに ETIQUETTE が再び出る。再読み込みの後も RULING → ETIQUETTE が出る", async ({
  page,
}) => {
  server = await startServer(join(dir, "poker.sqlite"), { POKER_SEED: SEED });
  await page.setViewportSize({ width: 1280, height: 900 });
  const starts = countHandStarts(page);
  await page.goto("/");
  const handId = await startFirstHand(page);
  await checkFacingBet(page);

  await test.step("Home・Learn へ移って Play に戻る", async () => {
    await goTo(page, "Home");
    await expect(page.getByRole("heading", { name: "Home" })).toBeVisible();
    await expect(etiquetteOverlay(page)).toHaveCount(0);
    await goTo(page, "Learn");
    await expect(page.getByRole("heading", { name: "Learn" })).toBeVisible();
    await goTo(page, "Play");
    await expect(etiquetteOverlay(page)).toBeVisible();
    await expect(ackButton(page)).toBeFocused();
    expect(starts(), "画面の移動で開始を送らない").toBe(1);
  });

  await test.step("再読み込み → Home の「続きから遊ぶ」で、同じ Hand の RULING → ETIQUETTE が出る", async () => {
    await page.reload();
    const resumed = await startFirstHand(page, "続きから遊ぶ");
    expect(resumed, "同じ Hand に戻る").toBe(handId);
    await expect(rulingOverlay(page)).toContainText(
      "相手の Bet があるので、Check の宣言は受けられません。",
    );
    await expect(etiquetteOverlay(page)).toBeVisible();
    await expect(rulingOverlay(page)).toHaveCount(0);
    expect(starts(), "再読み込みの後の開始は「続きから遊ぶ」の 1 回").toBe(2);
  });

  await test.step("確認すると Hero の手番の操作が再開する", async () => {
    await ackButton(page).click();
    await expect(etiquetteOverlay(page)).toHaveCount(0);
    await expect(declarationButton(page, "コール（Call）")).toBeEnabled();
  });
});

test("SSE が切れて再接続しても ETIQUETTE が残り、確認の後に最新へ追いつく（二重に出ない）", async ({
  page,
}) => {
  server = await startServer(join(dir, "poker.sqlite"), { POKER_SEED: SEED });
  // ブラウザ → 中継（別のポート）→ Vite（web）→ server。中継でブラウザの接続（SSE を含む）を実際に切る。
  const relayPort = E2E_WEB_PORT + 1;
  proxy = await startCuttableProxy(relayPort, E2E_WEB_PORT);
  const origin = `http://127.0.0.1:${relayPort}`;
  // 中継の origin にも、ほかの spec と同じ演出の速度（超高速）を置く（storageState は Vite の origin だけに効く）。
  await page.addInitScript(() => {
    try {
      window.localStorage.setItem(
        "proj-poker.display.presentationSpeed",
        "turbo",
      );
    } catch {
      // 保存できなくても演出の速度が既定になるだけ
    }
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  const dock = dockOf(page);
  const notice = dock.locator(".notice");
  await page.goto(`${origin}/`);
  const handId = await startFirstHand(page);
  await checkFacingBet(page);
  await expect(rulingOverlay(page)).toHaveCount(0);

  await test.step("接続を切ると再接続中の案内が出て、ETIQUETTE は残る", async () => {
    proxy?.cut();
    await expect(notice).toContainText("サーバーとの接続を再開しています…");
    await expect(etiquetteOverlay(page)).toBeVisible();
  });

  await test.step("復旧すると案内が消え、ETIQUETTE が 1 つだけ残る（RULING を出し直さない）", async () => {
    proxy?.restore();
    await expect(notice).toHaveCount(0, { timeout: 20_000 });
    await expect(etiquetteOverlay(page)).toHaveCount(1);
    await expect(rulingOverlay(page)).toHaveCount(0);
  });

  await test.step("確認すると進行が再開し、卓が server の最新に追いつく", async () => {
    await ackButton(page).click();
    await expect(etiquetteOverlay(page)).toHaveCount(0);
    await declarationButton(page, "コール（Call）").click();
    const done = dock.getByText(/Hand が終了しました。|Hero の手番です。/);
    await expect(done).toBeVisible({ timeout: 30_000 });
    // server の今の View（Hero の手番か Hand の終わり）と、画面の Pot が同じ。
    const { view } = await readStream(
      handId,
      (s) => s.view.legalActions !== null || s.view.status === "complete",
    );
    await expect.poll(() => potOf(page)).toBe(view.pot);
    await expect(etiquetteOverlay(page)).toHaveCount(0);
    await expect(rulingOverlay(page)).toHaveCount(0);
  });
});

test("Hand が終わった後も確認を待つ: 結果は確認まで出ず、次の Hand の開始は 409、確認の後に結果と「次の Hand へ」が出る", async ({
  page,
}) => {
  server = await startServer(join(dir, "poker.sqlite"), {
    POKER_SEED: "1",
    TABLE_SIZE: "2",
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  const dock = dockOf(page);
  await page.goto("/");
  const handId = await untilHeroFacesBet(page, await startFirstHand(page));

  await test.step("Bet に直面した手番で、Fold の宣言を 2 つ送る（2 つ目は declaration_ignored で確認が要る）", async () => {
    // 画面が受けている Push と同じ SSE から、今の View の lastSeq を得る。
    const { view } = await readStream(handId);
    expect(view.legalActions?.toCall ?? 0).toBeGreaterThan(0);
    const fold = { type: "declare", declaration: { kind: "fold" } };
    const res = await page.request.post(
      `/api/hands/${handId}/physical-actions`,
      { data: { lastSeq: lastSeqOf(view), actions: [fold, fold] } },
    );
    expect(res.ok()).toBe(true);
    const body = (await res.json()) as {
      view: { status: string };
      etiquette: { pendingRulingSeq: number | null };
    };
    // 2 人卓の Fold で Hand は終わるが、確認の待ちは残る。
    expect(body.view.status).toBe("complete");
    expect(body.etiquette.pendingRulingSeq).not.toBeNull();
  });

  await test.step("RULING → ETIQUETTE。確認まで Hand の結果・「次の Hand へ」は出ない", async () => {
    await expect(rulingOverlay(page)).toBeVisible();
    await expect(etiquetteOverlay(page)).toBeVisible();
    await expect(dock.getByText("Hand が終了しました。")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "次の Hand へ" }),
    ).toHaveCount(0);
  });

  await test.step("確認の前の次の Hand の開始は 409 etiquette_ack_required", async () => {
    const res = await page.request.post("/api/hands", {
      data: { afterHandId: handId },
    });
    expect(res.status()).toBe(409);
    const body = (await res.json()) as { error: { kind: string } };
    expect(body.error.kind).toBe("etiquette_ack_required");
  });

  await test.step("確認すると結果と「次の Hand へ」が出て、次の Hand を始められる", async () => {
    await ackButton(page).click();
    await expect(etiquetteOverlay(page)).toHaveCount(0);
    await expect(dock.getByText("Hand が終了しました。")).toBeVisible();
    const next = await startNextHand(page);
    expect(next).not.toBe(handId);
  });
});

test.describe("Session が確認を待ったまま終わった後の「新しい Session を始める」", () => {
  // 2 人卓・Maniac の CPU で、Hero の All-in の Call（宣言を 2 つ）で Session が終わる山札（API だけの手順で探した）。
  const ENDING_ENV = {
    POKER_SEED: "1",
    TABLE_SIZE: "2",
    CPU_PERSONAS: "maniac",
  } as const;

  test("再読み込みの Home から始めると、前の Session の最後の Hand の ETIQUETTE と案内が出て、2 回目の開始を送らない。確認の後にもう一度押すと新しい Session になる", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    server = await startServer(join(dir, "poker.sqlite"), ENDING_ENV);
    const lastHandId = await playUntilSessionEndsAwaitingAck();
    await page.setViewportSize({ width: 1280, height: 900 });
    const dock = dockOf(page);
    const starts = countHandStarts(page);
    await page.goto("/");
    await page.reload();

    await test.step("「新しい Session を始める」→ 前の Session の最後の Hand の RULING → ETIQUETTE と案内", async () => {
      const opened = await startFirstHand(page, "新しい Session を始める");
      expect(opened, "前の Session の最後の Hand を開く").toBe(lastHandId);
      await expect(rulingOverlay(page)).toBeVisible();
      await expect(etiquetteOverlay(page)).toBeVisible();
      await expect(dock.locator(".notice")).toContainText(
        "前の Session の最後の Hand に、まだ確認していない",
      );
      // 少し待っても 2 回目の開始を送らない（送っても etiquette_ack_required になる）。
      await page.waitForTimeout(1_000);
      expect(starts(), "開始の要求は 1 回").toBe(1);
    });

    await test.step("確認の後にもう一度押すと、新しい Session の Hand になる", async () => {
      await ackButton(page).click();
      await expect(etiquetteOverlay(page)).toHaveCount(0);
      await expect(dock.getByText("Session が終了しました。")).toBeVisible();
      const next = await startNextHand(page, "新しい Session を始める");
      expect(next).not.toBe(lastHandId);
      await expect(dock.getByText("Session が終了しました。")).toHaveCount(0);
    });
  });

  test("1 回目の応答に確認の状態が無くても、2 回目の開始の 409 から 1 回目の Hand を開き、SSE の確認の状態で ETIQUETTE に至る", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    server = await startServer(join(dir, "poker.sqlite"), ENDING_ENV);
    const lastHandId = await playUntilSessionEndsAwaitingAck();
    await page.setViewportSize({ width: 1280, height: 900 });
    const dock = dockOf(page);
    // 1 回目の開始の応答から etiquette を取り除く（client は確認の待ちを知らないまま 2 回目を送る）。2 回目以降はそのまま通す。
    let stripped = 0;
    await page.route("**/api/hands", async (route) => {
      if (route.request().method() !== "POST" || stripped > 0) {
        await route.fallback();
        return;
      }
      stripped++;
      const response = await route.fetch();
      const body = (await response.json()) as Record<string, unknown>;
      delete body["etiquette"];
      await route.fulfill({ response, json: body });
    });
    const statuses: number[] = [];
    page.on("response", (r) => {
      if (
        r.request().method() === "POST" &&
        new URL(r.url()).pathname === "/api/hands"
      ) {
        statuses.push(r.status());
      }
    });
    await page.goto("/");
    await page.getByRole("button", { name: "新しい Session を始める" }).click();

    await expect(etiquetteOverlay(page)).toBeVisible();
    await expect(dock.locator(".notice")).toContainText(
      "前の Session の最後の Hand に、まだ確認していない",
    );
    expect(stripped, "1 回目の応答を書き換えた").toBe(1);
    // 1 回目は書き換えた応答（成功）、2 回目は実サーバーの 409（etiquette_ack_required）。
    expect(statuses, "開始の要求は 2 回").toHaveLength(2);
    expect(statuses[0], "1 回目は成功").toBeLessThan(300);
    expect(statuses[1], "2 回目は実サーバーの 409").toBe(409);
    // 開いたのは 1 回目の Hand（終わった Session の最後の Hand）で、その Hand の待っている裁定の注意を出している。
    const { etiquette } = await readStream(lastHandId);
    expect(etiquette?.pendingRulingSeq).not.toBeNull();
    await expect(etiquetteOverlay(page)).toHaveAttribute(
      "data-ruling-seq",
      String(etiquette?.pendingRulingSeq),
    );
    await ackButton(page).click();
    await expect(dock.getByText("Session が終了しました。")).toBeVisible();
    const next = await startNextHand(page, "新しい Session を始める");
    expect(next).not.toBe(lastHandId);
  });
});

test("通常の卓が確認を待つ間も Drill を始められ、Drill の卓に通常の卓の ETIQUETTE は出ず、通常の卓へ戻ると出る", async ({
  page,
}) => {
  test.setTimeout(180_000);
  // 2 人卓・Pass A を「改善の余地あり」にして、Review した判断を Recommended Drill の候補にする（learning.spec.ts と同じ）。
  server = await startServer(join(dir, "poker.sqlite"), {
    POKER_SEED: "2",
    TABLE_SIZE: "2",
    FAKE_REVIEW_ASSESSMENT: "improvement_suggested",
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  const dock = dockOf(page);
  const learning = page.locator("main.learning");
  await page.goto("/");
  let handId = await startFirstHand(page);

  await test.step("Hero の判断のある Hand を終え、その判断の Review（Pass A）を作る", async () => {
    for (let hand = 0; hand < 10; hand++) {
      const log = page
        .getByRole("region", { name: "Hand の進行" })
        .locator("li");
      for (let turn = 0; turn < 30; turn++) {
        const done = dock.getByText("Hand が終了しました。");
        await expect(dock.getByText("Hero の手番です。").or(done)).toBeVisible({
          timeout: 30_000,
        });
        if (await done.isVisible()) break;
        const before = await log.count();
        const call = declarationButton(page, "コール（Call）");
        if ((await call.locator(".declaration__amount").count()) > 0) {
          await call.click();
        } else {
          await declarationButton(page, "チェック（Check）").click();
        }
        await expect
          .poll(() => log.count(), { timeout: 30_000 })
          .toBeGreaterThan(before);
      }
      await dock.getByRole("button", { name: "この Hand の Review" }).click();
      await expect(
        page.getByRole("heading", { name: "Hand Review" }),
      ).toBeVisible();
      const spots = page.locator(".spot-row");
      if ((await spots.count()) > 0) {
        await spots.first().click();
        await page.getByRole("button", { name: "Review を作る" }).click();
        await expect(
          page.locator(".review-body .assessment").first(),
        ).toContainText("改善の余地あり");
        await page.getByRole("button", { name: "卓に戻る" }).click();
        break;
      }
      // Hero の判断の無い Hand（CPU が先に Fold した）は飛ばす。
      await page.getByRole("button", { name: "卓に戻る" }).click();
      handId = await startNextHand(page);
    }
    handId = await startNextHand(page);
  });

  await test.step("通常の卓で check_facing_bet の RULING → ETIQUETTE を出す", async () => {
    handId = await untilHeroFacesBet(page, handId);
    await declarationButton(page, "チェック（Check）").click();
    await expect(rulingOverlay(page)).toBeVisible();
    await expect(etiquetteOverlay(page)).toBeVisible();
  });

  await test.step("Learn の Session Review から Drill を始める。Drill の卓に通常の卓の ETIQUETTE は出ない", async () => {
    // Learn は前に開いていた画面（Hand Review）に戻るので、一覧へ移ってから Session Review を開く。
    await goTo(page, "Learn");
    await page.getByRole("button", { name: "Learn の一覧へ" }).click();
    await expect(page.getByRole("heading", { name: "Learn" })).toBeVisible();
    await page.getByRole("button", { name: "Session Review を開く" }).click();
    await expect(
      page.getByRole("heading", {
        name: "Session の振り返り（Session Review）",
      }),
    ).toBeVisible();
    const [res] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.request().method() === "POST" &&
          new URL(r.url()).pathname === "/api/drills",
      ),
      learning.getByRole("button", { name: "Drill を始める" }).click(),
    ]);
    expect(res.ok(), "Drill の開始").toBe(true);
    await expect(
      page.getByRole("heading", { name: "Targeted Drill（練習）" }),
    ).toBeVisible();
    await expect(
      dock.getByText(/Hero の手番です。|Drill の Hand が終了しました。/),
    ).toBeVisible({ timeout: 30_000 });
    await expect(etiquetteOverlay(page)).toHaveCount(0);
    await expect(rulingOverlay(page)).toHaveCount(0);
  });

  await test.step("通常の卓へ戻ると ETIQUETTE が出て、確認すると再開する", async () => {
    await goTo(page, "Play");
    await expect(etiquetteOverlay(page)).toBeVisible();
    await ackButton(page).click();
    await expect(etiquetteOverlay(page)).toHaveCount(0);
    await expect(declarationButton(page, "コール（Call）")).toBeEnabled();
    // Drill の卓へ戻っても、通常の卓の注意は出ない。
    await goTo(page, "Learn");
    await expect(
      page.getByRole("heading", { name: "Targeted Drill（練習）" }),
    ).toBeVisible();
    await expect(etiquetteOverlay(page)).toHaveCount(0);
  });
});

test("REST の応答の確認の状態が不正な形でも画面は壊れず、SSE の正しい状態で ETIQUETTE が出て、確認で閉じる", async ({
  page,
}) => {
  server = await startServer(join(dir, "poker.sqlite"), { POKER_SEED: SEED });
  await page.setViewportSize({ width: 1280, height: 900 });
  const dock = dockOf(page);
  // 操作と確認の応答の etiquette を、形の合わない値に書き換える（View 等はそのまま）。
  let rewritten = 0;
  const corrupt = async (
    route: Parameters<Parameters<Page["route"]>[1]>[0],
    value: unknown,
  ) => {
    const response = await route.fetch();
    const body = (await response.json()) as Record<string, unknown>;
    body["etiquette"] = value;
    rewritten++;
    await route.fulfill({ response, json: body });
  };
  await page.route("**/api/hands/*/physical-actions", (route) =>
    corrupt(route, { revision: "x" }),
  );
  await page.route("**/api/hands/*/etiquette-ack", (route) =>
    corrupt(route, { revision: -1, pendingRulingSeq: "y" }),
  );
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await startFirstHand(page);

  await checkFacingBet(page);
  expect(rewritten, "操作の応答を書き換えた").toBe(1);
  await expect(page.getByRole("region", { name: "卓" })).toBeVisible();
  await ackButton(page).click();
  await expect(etiquetteOverlay(page)).toHaveCount(0);
  expect(rewritten, "確認の応答も書き換えた").toBe(2);
  await expect(declarationButton(page, "コール（Call）")).toBeEnabled();
  await expect(dock.getByText("Hero の手番です。")).toBeVisible();
  expect(errors, "画面のエラーが無い").toEqual([]);
});
