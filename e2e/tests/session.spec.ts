// 6-max Session の Critical E2E（docs/09 §8・D98）:
// Session 開始 → Hand を Play（Chip 操作と宣言）→ Hand 終了 → Review（Pass A の段階評価 → Pass B → Follow-up）
// → Replay（Important Spot へのジャンプ）→ 次の Hand → server を再起動して Resume（同じ Session・Stack を持ち越す）。
// 山札の seed を固定し、CPU は RuleBot、Review AI は固定応答（REVIEW_PROVIDER=fake）なので Claude を呼ばない。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  startServer,
  stopServer,
  type RunningServer,
} from "../support/server.js";

/** E2E の固定応答の印（apps/server/src/review/fake-review-query.ts の FAKE_REVIEW_MARK）。 */
const FAKE_MARK = "（E2E 用の固定応答）";

/** Chip の額面（大きい順）。PHASE1_CASH_PRESET の額面（OI-004 の暫定値）。 */
const DENOMINATIONS = [500, 100, 25, 5, 1] as const;

interface SeatSnapshot {
  readonly playerId: string;
  readonly stack: number;
}

interface ReplayStep {
  readonly seats: readonly SeatSnapshot[];
}

interface ReplayHandResponse {
  readonly handId: string;
  readonly steps: readonly ReplayStep[];
}

let dir = "";
let server: RunningServer | null = null;

test.beforeEach(() => {
  // テストごとに空の DB から始め、再起動をまたいで同じ DB を使う（Resume は保存済みの Session Projection から戻す）。
  dir = mkdtempSync(join(tmpdir(), "proj-poker-e2e-"));
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
  rmSync(dir, { recursive: true, force: true });
});

/** 額を Chip の額面に分ける（大きい額面から）。 */
function chipsFor(amount: number): number[] {
  const chips: number[] = [];
  let rest = amount;
  for (const d of DENOMINATIONS) {
    while (rest >= d) {
      chips.push(d);
      rest -= d;
    }
  }
  return chips;
}

/** 宣言 Button の補助の額（Call は Legal Action の額。手番でなければ出ない）。 */
async function declaredAmount(button: Locator): Promise<number | null> {
  const amount = button.locator(".declaration__amount");
  if ((await amount.count()) === 0) return null;
  const text = (await amount.innerText()).replace(/[,，]/g, "");
  const match = /^\d+/.exec(text);
  return match === null ? null : Number(match[0]);
}

/**
 * Hero の手番ごとに 1 回操作し、Hand の終了まで進める。
 * - useChips: 最初に Call する手番で、Call の額の Chip を手に取り Betting Area に出して「確定して Dealer に渡す」（宣言なしの Chip 操作）
 * - それ以外は宣言 Button（Call できれば Call、できなければ Check）
 * 返り値は Chip 操作をしたか。
 */
async function playHand(page: Page, useChips: boolean): Promise<boolean> {
  const dock = page.getByRole("region", { name: "Hero" });
  const log = page.getByRole("region", { name: "Hand の進行" }).locator("li");
  let usedChips = false;
  for (let turn = 0; turn < 30; turn++) {
    const done = dock.getByText(
      /Hand が終了しました。|Session が終了しました。/,
    );
    await expect(dock.getByText("Hero の手番です。").or(done)).toBeVisible({
      timeout: 30_000,
    });
    if (await done.isVisible()) return usedChips;

    const before = await log.count();
    const call = dock.getByRole("button", { name: /^コール（Call）/ });
    const toCall = await declaredAmount(call);
    if (toCall !== null && useChips && !usedChips) {
      for (const chip of chipsFor(toCall)) {
        await dock
          .getByRole("button", { name: `${chip} の Chip を手に取る` })
          .click();
      }
      await dock
        .getByRole("button", {
          name: /^手に取った Chip .* を Betting Area に出す$/,
        })
        .click();
      await dock
        .getByRole("button", { name: "確定して Dealer に渡す" })
        .click();
      usedChips = true;
    } else if (toCall !== null) {
      await call.click();
    } else {
      await dock.getByRole("button", { name: /^チェック（Check）/ }).click();
    }
    // 操作が裁定されて卓の状態が進む（ログの行が増える）まで待ってから、次の手番を読む（古い画面で二重に操作しない）。
    await expect
      .poll(() => log.count(), { timeout: 30_000 })
      .toBeGreaterThan(before);
  }
  throw new Error("Hand が 30 手番で終わらなかった");
}

/** 保存済みの Hand（新しい順）。 */
async function replayHands(page: Page): Promise<{ handId: string }[]> {
  const res = await page.request.get("/api/replay/hands");
  expect(res.ok()).toBe(true);
  return ((await res.json()) as { hands: { handId: string }[] }).hands;
}

async function replayHand(
  page: Page,
  handId: string,
): Promise<ReplayHandResponse> {
  const res = await page.request.get(`/api/replay/hands/${handId}`);
  expect(res.ok()).toBe(true);
  return (await res.json()) as ReplayHandResponse;
}

function stackOf(step: ReplayStep | undefined, playerId: string): number {
  const seat = step?.seats.find((s) => s.playerId === playerId);
  if (seat === undefined) throw new Error(`席が無い: ${playerId}`);
  return seat.stack;
}

test("6-max の Session を Play → Review → Replay → 次の Hand → 再起動して Resume まで通す", async ({
  page,
}) => {
  const dbPath = join(dir, "poker.sqlite");
  server = await startServer(dbPath);

  await test.step("6-max の Session を始め、Chip 操作と宣言で Hand を最後まで Play する", async () => {
    await page.goto("/");
    await page.getByRole("button", { name: "Hand を始める" }).click();
    await expect(page.getByRole("region", { name: "卓" })).toHaveAttribute(
      "data-seat-count",
      "6",
    );
    const usedChips = await playHand(page, true);
    expect(usedChips, "Chip 操作で Call する手番があった").toBe(true);
    await expect(
      page
        .getByRole("region", { name: "Hero" })
        .getByText("Hand が終了しました。"),
    ).toBeVisible();
  });

  await test.step("Review を開き、判断時点の Review（Pass A）の段階評価を出す", async () => {
    await page.getByRole("button", { name: "この Hand の Review" }).click();
    await expect(
      page.getByRole("heading", { name: "Hand Review" }),
    ).toBeVisible();
    // Important Spot を先に並べる（要点先行）。最初の判断を開く。
    await page.locator(".spot-row").first().click();
    await page.getByRole("button", { name: "Review を作る" }).click();
    await expect(page.getByText(`${FAKE_MARK}Pot Odds`)).toBeVisible();
    // 段階評価（固定応答は reasonable =「妥当」）。
    await expect(
      page.locator(".review-body .assessment").first(),
    ).toContainText("妥当");
  });

  await test.step("Hand 後の答え合わせ（Pass B）と Follow-up を出す", async () => {
    await page.getByRole("button", { name: "Hand 後の答え合わせ" }).click();
    await page.getByRole("button", { name: "答え合わせを作る" }).click();
    await expect(
      page.getByText(`${FAKE_MARK}判断時点に仮定した Range`),
    ).toBeVisible();
    await expect(page.getByRole("heading", { name: "全員の札" })).toBeVisible();

    await page
      .getByRole("textbox", { name: "質問" })
      .fill("相手の札は想定の Range のどこにありましたか？");
    await page.getByRole("button", { name: "質問する" }).click();
    await expect(
      page.getByText(`${FAKE_MARK}Evidence の範囲で答えると`),
    ).toBeVisible();
  });

  await test.step("Replay で Important Spot へジャンプする", async () => {
    await page.getByRole("button", { name: "判断の一覧へ" }).click();
    await page.getByRole("button", { name: "Replay で最初から見る" }).click();
    await expect(page.getByText("Replay（Hero の視点）")).toBeVisible();
    const jump = page
      .getByRole("group", {
        name: "Important Spot へ移動（Jump to Important Spot）",
      })
      .getByRole("button")
      .first();
    await jump.click();
    await expect(jump).toHaveAttribute("aria-pressed", "true");
    // ジャンプした場面は Hero の判断の直前なので、その判断の Review へ戻れる。
    await expect(
      page.getByRole("button", { name: "この判断の Review を見る" }),
    ).toBeVisible();
  });

  let secondHandId = "";
  await test.step("卓に戻って次の Hand を Play する", async () => {
    await page.getByRole("button", { name: "卓に戻る" }).click();
    await page.getByRole("button", { name: "次の Hand へ" }).click();
    await playHand(page, false);
    await expect(
      page
        .getByRole("region", { name: "Hero" })
        .getByText("Hand が終了しました。"),
    ).toBeVisible();
    // 次の Hand へ進める（Session が続いている）ことを確かめてから再起動する。
    await expect(
      page.getByRole("button", { name: "次の Hand へ" }),
    ).toBeVisible();
    const hands = await replayHands(page);
    expect(hands).toHaveLength(2);
    secondHandId = hands[0]?.handId ?? "";
  });

  await test.step("server を再起動し、同じ Session を Stack を持ち越して続ける（Resume）", async () => {
    const second = await replayHand(page, secondHandId);
    const endStacks = (second.steps.at(-1)?.seats ?? []).map((s) => ({
      playerId: s.playerId,
      stack: s.stack,
    }));
    expect(endStacks).toHaveLength(6);

    await stopServer(server as RunningServer);
    server = await startServer(dbPath);
    await page.reload();
    await page.getByRole("button", { name: "Hand を始める" }).click();
    await expect(page.getByRole("region", { name: "卓" })).toBeVisible();

    const hands = await replayHands(page);
    expect(hands).toHaveLength(3);
    const third = await replayHand(page, hands[0]?.handId ?? "");
    // 3 Hand 目の開始時の Stack は、2 Hand 目の終わりの Stack と同じ（新しい Session なら全員 200 の均等 Stack に戻る）。
    const startStep = third.steps.find((s) => s.seats.length > 0);
    for (const seat of endStacks) {
      expect(stackOf(startStep, seat.playerId), seat.playerId).toBe(seat.stack);
    }
    expect(endStacks.some((s) => s.stack !== 200)).toBe(true);
    // Chip の総量は変わらない（6 人 × 200）。
    expect(endStacks.reduce((sum, s) => sum + s.stack, 0)).toBe(1200);

    // Resume した Hand も最後まで遊べる。
    await playHand(page, false);
  });
});

test.describe("狭い画面（375px）での卓の配置（#5）", () => {
  test.use({
    viewport: { width: 375, height: 667 },
    hasTouch: true,
    isMobile: true,
  });

  test("Hand の結果は Hero の欄に出て、席と重ならずに次の Hand へ・Review を押せる。横スクロールは出ない", async ({
    page,
  }) => {
    server = await startServer(join(dir, "poker.sqlite"));
    await page.goto("/");
    await page.getByRole("button", { name: "Hand を始める" }).click();
    await playHand(page, false);

    const dock = page.getByRole("region", { name: "Hero" });
    // 結果（獲得額・次の Hand へ）は、席と重なる卓の中央ではなく Hero の欄に出す。
    await expect(page.locator(".table .result")).toHaveCount(0);
    await expect(dock.locator(".result")).toContainText("獲得");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      ),
    ).toBe(0);

    // Playwright の click は、押す位置に別の要素（席など）があると待ち続けて失敗する。重なっていれば通らない。
    await dock.getByRole("button", { name: "この Hand の Review" }).click();
    await expect(
      page.getByRole("heading", { name: "Hand Review" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "卓に戻る" }).click();
    await dock.getByRole("button", { name: "次の Hand へ" }).click();
    await expect(dock.getByText("Hand が終了しました。")).toBeHidden();
    await expect(page.getByRole("region", { name: "卓" })).toBeVisible();
  });
});

/**
 * Hero の手番に読み（User Read）を記録し、CPU の Note / Tag を残してから、その Hand を最後まで進める（#115・D112）。
 * 読みは Hero 自身の行として進行ログに出て、読みの後の操作も通る（読みで Log が進んだ後の lastSeq で送る）。
 * Playwright の click は覆われた Button で失敗するので、狭い画面でも入力が席・Hero 欄の操作と重ならないことの検査になる。
 */
async function recordReadAndNotes(page: Page): Promise<void> {
  const dock = page.getByRole("region", { name: "Hero" });
  const log = page.getByRole("region", { name: "Hand の進行" });
  await expect(dock.getByText("Hero の手番です。")).toBeVisible({
    timeout: 30_000,
  });
  await dock.getByRole("button", { name: "読みを記録" }).click();
  await dock.getByRole("combobox").selectOption({ label: "CPU 1" });
  await dock.getByRole("textbox", { name: "読み" }).fill("Value が多そう");
  await dock.getByRole("button", { name: "記録する" }).click();
  await expect(
    log.getByText("Hero の読み（CPU 1）: Value が多そう"),
  ).toBeVisible();
  await expect(
    dock.getByRole("button", { name: "読みを記録" }),
  ).toBeVisible();

  const notes = page.locator(".opponent-notes");
  await notes.getByText("CPU の Note / Tag").click();
  await notes.getByRole("combobox").selectOption({ label: "CPU 2" });
  await notes.getByRole("textbox", { name: "Tag" }).fill("Loose");
  await notes.getByRole("button", { name: "Tag を付ける" }).click();
  await expect(notes.locator(".opponent-notes__tag")).toHaveText(["Loose"]);
  await notes
    .getByRole("textbox", { name: "Note" })
    .fill("River は Value 寄り");
  await notes.getByRole("button", { name: "Note を残す" }).click();
  await expect(notes.getByText("River は Value 寄り")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    ),
  ).toBe(0);

  // 読みの後の操作も通り、Hand を最後まで進められる。
  await playHand(page, false);
}

test.describe("User Read と Note / Tag（#115）", () => {
  test("広い画面: 手番に読みを記録し、CPU の Note / Tag を残して Hand を進める", async ({
    page,
  }) => {
    server = await startServer(join(dir, "poker.sqlite"));
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/");
    await page.getByRole("button", { name: "Hand を始める" }).click();
    await recordReadAndNotes(page);
  });

  test.describe("狭い画面（375px）", () => {
    test.use({
      viewport: { width: 375, height: 667 },
      hasTouch: true,
      isMobile: true,
    });

    test("手番に読みを記録し、CPU の Note / Tag を残して Hand を進める。横スクロールは出ない", async ({
      page,
    }) => {
      server = await startServer(join(dir, "poker.sqlite"));
      await page.goto("/");
      await page.getByRole("button", { name: "Hand を始める" }).click();
      await recordReadAndNotes(page);
    });
  });
});
