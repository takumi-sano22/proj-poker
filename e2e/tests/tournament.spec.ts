// 6-max STT（Tournament）の Critical E2E（docs/09 §8・D98・D108・D127〜D130）:
// 標準 Preset（stt6_hand_count）で開始 → Blind / Ante（Level 1 と Level 2 への上昇）→ 途中で server を再起動して Resume（同じ Level・
// 残人数・Stack で続く）→ Player の Elimination → Heads-Up への移行 → 終了 → Payout / Result → ICM の Review（Chip EV と ICM が別の項目）
// → Replay → 新しい Tournament を始める（Restart）。
// 山札の seed を固定し、CPU は RuleBot、Review AI は固定応答（REVIEW_PROVIDER=fake）なので Claude を呼ばない。
// 本番の Preset の値（D127）はそのまま使う。Hero は Heads-Up までは Check / Fold だけで Stack を守り（CPU 同士の Elimination で
// 残人数が減る）、Heads-Up では All-in で決着を早める。
// 経路は seed・RuleBot・再起動の位置で決まる（再起動すると seed の並びは先頭から使い直す）。この方針と 12 Hand 目の後の再起動で、
// Hero は 51 Hand 目で Heads-Up に入り、52 Hand 目で終わる（UI で 20 秒ほど）。RuleBot・Engine の変更で Hero が Heads-Up の前に
// Bust するようになったら、その旨の assert で落ちるので、再起動の位置か seed（startServer の overrides）を選び直す。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { startNextHand } from "../support/next-hand.js";
import { startFirstHand } from "../support/play.js";
import {
  startServer,
  stopServer,
  type RunningServer,
} from "../support/server.js";

/** E2E の固定応答の印（apps/server/src/review/fake-review-query.ts の FAKE_REVIEW_MARK）。 */
const FAKE_MARK = "（E2E 用の固定応答）";

/** 新しい Session の種類の選択肢（apps/web/src/lib/tournament.ts の SESSION_CHOICES）。 */
const TOURNAMENT_CHOICE = "Tournament（10 Hand ごと）";

/** 標準 6-max STT の Prize Pool と順位ごとの賞金（D127: 参加費 100pt × 6 人。D108: 50 / 30 / 20%）。 */
const PRIZE_POOL = 600;
const PAYOUTS_BY_PLACE = [300, 180, 120] as const;

/** Hand の上限（決定論の経路では 80 Hand 前後で終わる。終わらなければ方針か挙動が変わった）。 */
const MAX_HANDS = 200;

/** `GET /api/hands/:handId/tournament` の応答のうち、この E2E が読む項目。 */
interface TournamentStatus {
  readonly handId: string;
  readonly level: number;
  readonly handNumber: number;
  readonly smallBlind: number;
  readonly bigBlind: number;
  readonly ante: number;
  readonly result: {
    readonly status: "in_progress" | "finished" | "abandoned";
    readonly entrants: number;
    readonly remaining: number;
    readonly prizePool: number;
    readonly payoutsByPlace: readonly number[];
    readonly placements: readonly {
      readonly playerId: string;
      readonly place: number | null;
      readonly payout: number | null;
    }[];
  };
}

interface ReplayStep {
  readonly seats: readonly {
    readonly playerId: string;
    readonly stack: number;
  }[];
}

let dir = "";
let server: RunningServer | null = null;

test.beforeEach(() => {
  // テストごとに空の DB から始め、再起動をまたいで同じ DB を使う（Resume は保存済みの Event Log から戻す）。
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

async function tournamentOf(
  page: Page,
  handId: string,
): Promise<TournamentStatus> {
  const res = await page.request.get(`/api/hands/${handId}/tournament`);
  expect(res.ok(), `Tournament の状況: ${handId}`).toBe(true);
  const { tournament } = (await res.json()) as {
    tournament: TournamentStatus | null;
  };
  if (tournament === null)
    throw new Error(`Tournament の Hand でない: ${handId}`);
  return tournament;
}

async function replaySteps(
  page: Page,
  handId: string,
): Promise<readonly ReplayStep[]> {
  const res = await page.request.get(`/api/replay/hands/${handId}`);
  expect(res.ok()).toBe(true);
  return ((await res.json()) as { steps: ReplayStep[] }).steps;
}

/** 宣言 Button の補助の額があるか（Call / All-in は合法なときだけ額が出る）。 */
async function hasAmount(button: Locator): Promise<boolean> {
  return (await button.locator(".declaration__amount").count()) > 0;
}

/**
 * Hand の終わりまで Hero の手番ごとに 1 回操作する。
 * - "fold": Check できれば Check、できなければ Fold（Stack を守り、CPU 同士の Elimination を待つ）
 * - "shove": All-in できれば All-in、できなければ Call、どちらも無ければ Check（Heads-Up の決着を早める）
 */
async function playHand(page: Page, policy: "fold" | "shove"): Promise<void> {
  const dock = page.getByRole("region", { name: "Hero" });
  const log = page.getByRole("region", { name: "Hand の進行" }).locator("li");
  for (let turn = 0; turn < 30; turn++) {
    const done = dock.getByText(
      /Hand が終了しました。|Session が終了しました。/,
    );
    await expect(dock.getByText("Hero の手番です。").or(done)).toBeVisible({
      timeout: 30_000,
    });
    if (await done.isVisible()) return;

    const before = await log.count();
    const call = dock.getByRole("button", { name: /^コール（Call）/ });
    const allIn = dock.getByRole("button", { name: /^オールイン（All-in）/ });
    if (policy === "shove" && (await hasAmount(allIn))) {
      await allIn.click();
    } else if (policy === "shove" && (await hasAmount(call))) {
      await call.click();
    } else if (await hasAmount(call)) {
      await dock.getByRole("button", { name: /^フォールド（Fold）/ }).click();
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

/** 表示中の Hand を終わらせ、終わった後の Tournament の状況を返す。 */
async function finishHand(
  page: Page,
  handId: string,
  policy: "fold" | "shove",
): Promise<TournamentStatus> {
  await playHand(page, policy);
  await expect(
    page
      .getByRole("region", { name: "Hero" })
      .getByText(/Hand が終了しました。|Session が終了しました。/)
      .first(),
  ).toBeVisible();
  return tournamentOf(page, handId);
}

test("6-max STT を開始 → Blind / Ante → Resume → Elimination → Heads-Up → 終了 → Payout → ICM Review → Replay → 新しい Tournament まで通す", async ({
  page,
}) => {
  // 数十 Hand を UI で打つので、既定（120 秒）より長く取る。
  test.setTimeout(600_000);
  const dbPath = join(dir, "poker.sqlite");
  server = await startServer(dbPath);
  const panel = page.getByRole("region", { name: "Tournament" });
  const header = page.locator(".app__meta");
  const dock = page.getByRole("region", { name: "Hero" });

  let handId = "";
  let status: TournamentStatus | null = null;

  await test.step("最初の画面で Tournament を選び、6-max STT を Level 1 の Blind / BB Ante で始める", async () => {
    await page.goto("/");
    await page
      .getByLabel("新しい Session の種類")
      .selectOption({ label: TOURNAMENT_CHOICE });
    handId = await startFirstHand(page);
    await expect(page.getByRole("region", { name: "卓" })).toHaveAttribute(
      "data-seat-count",
      "6",
    );
    // 見出しと Tournament の欄に、この Hand の Level・Blind・Ante（D127: 10 / 20・BBA は BB と同じ額）と残人数を出す。
    await expect(header).toHaveText("Level 1 · 10 / 20 · BB Ante 20");
    await expect(panel).toHaveAttribute(
      "data-tournament-status",
      "in_progress",
    );
    await expect(panel).toContainText("Level 1 / 12");
    await expect(panel).toContainText("10 / 20 · BB Ante 20");
    await expect(panel).toContainText("15 / 30 · BB Ante 30");
    await expect(panel).toContainText("11 Hand 目から（今 1 Hand 目）");
    await expect(panel).toContainText("6 / 6 人");
    // BB Ante は BB の席が 1 人分だけ払う（D128）。進行ログに Ante の行がちょうど 1 つ出る。
    await expect(
      page.getByRole("region", { name: "Hand の進行" }).getByText(/: Ante 20$/),
    ).toHaveCount(1);
    const first = await tournamentOf(page, handId);
    expect(first).toMatchObject({
      level: 1,
      handNumber: 1,
      smallBlind: 10,
      bigBlind: 20,
      ante: 20,
    });
    expect(first.result).toMatchObject({
      entrants: 6,
      remaining: 6,
      prizePool: PRIZE_POOL,
      payoutsByPlace: PAYOUTS_BY_PLACE,
    });
    // Session の最初の Hand は全員が Starting Stack（D127: 1,500）から始まる。
    const start = (await replaySteps(page, handId)).find(
      (s) => s.seats.length > 0,
    );
    expect(start?.seats.map((s) => s.stack)).toEqual(Array(6).fill(1_500));
  });

  await test.step("10 Hand で Level 2 に上がり、Blind と BB Ante が上がる（12 Hand 目まで進める）", async () => {
    status = await finishHand(page, handId, "fold");
    while (status.handNumber < 12) {
      expect(status.result.status, "Hero は 12 Hand 目までに Bust しない").toBe(
        "in_progress",
      );
      handId = await startNextHand(page);
      status = await finishHand(page, handId, "fold");
    }
    expect(status).toMatchObject({
      level: 2,
      handNumber: 12,
      smallBlind: 15,
      bigBlind: 30,
      ante: 30,
    });
    await expect(header).toHaveText("Level 2 · 15 / 30 · BB Ante 30");
    await expect(panel).toContainText("Level 2 / 12");
    await expect(panel).toContainText("21 Hand 目から（今 12 Hand 目）");
    expect(status.result.status).toBe("in_progress");
  });

  await test.step("server を再起動し、同じ Tournament を同じ Level・残人数・Stack で続ける（Resume）", async () => {
    const before = status as TournamentStatus;
    const endStacks = ((await replaySteps(page, handId)).at(-1)?.seats ?? [])
      .filter((s) => s.stack > 0)
      .map((s) => ({ playerId: s.playerId, stack: s.stack }));
    expect(endStacks.length).toBe(before.result.remaining);

    await stopServer(server as RunningServer);
    server = await startServer(dbPath);
    await page.reload();
    await page
      .getByLabel("新しい Session の種類")
      .selectOption({ label: TOURNAMENT_CHOICE });
    const resumedHandId = await startFirstHand(page);
    expect(resumedHandId).not.toBe(handId);
    handId = resumedHandId;

    const resumed = await tournamentOf(page, handId);
    // 続きの Hand は新しい Tournament（1 Hand 目・Level 1）ではなく、同じ Session の次の Hand（Level は Hand 数から再構築）。
    expect(resumed.handNumber).toBe(before.handNumber + 1);
    expect(resumed.level).toBe(2);
    expect(resumed.result.remaining).toBe(before.result.remaining);
    expect(resumed.result.placements).toEqual(before.result.placements);
    await expect(header).toHaveText("Level 2 · 15 / 30 · BB Ante 30");
    await expect(panel).toContainText(`今 ${before.handNumber + 1} Hand 目`);
    // 開始時の Stack は、再起動前の最後の Hand の終わりの Stack を持ち越す（Chip の総量 1,500 × 6 も変わらない）。
    const start = (await replaySteps(page, handId)).find(
      (s) => s.seats.length > 0,
    );
    for (const seat of endStacks) {
      expect(
        start?.seats.find((s) => s.playerId === seat.playerId)?.stack,
        seat.playerId,
      ).toBe(seat.stack);
    }
    expect(endStacks.reduce((sum, s) => sum + s.stack, 0)).toBe(9_000);
    status = await finishHand(page, handId, "fold");
  });

  let eliminatedSeen = false;
  await test.step("CPU の Elimination を経て、Heads-Up（残り 2 人）まで進む", async () => {
    let current = status as TournamentStatus;
    for (let hand = 0; current.result.remaining > 2; hand++) {
      expect(hand, "Heads-Up までの Hand の数").toBeLessThan(MAX_HANDS);
      expect(current.result.status, "Hero は Heads-Up の前に Bust しない").toBe(
        "in_progress",
      );
      if (!eliminatedSeen && current.result.remaining < 6) {
        // 最初の Elimination: 脱落した Player に順位（6 位から）が付き、欄の見出しに脱落の人数が出る。
        eliminatedSeen = true;
        const out = current.result.placements.filter((p) => p.place !== null);
        expect(out.length).toBe(6 - current.result.remaining);
        expect(out.every((p) => p.playerId !== "hero")).toBe(true);
        expect(Math.max(...out.map((p) => p.place ?? 0))).toBe(6);
        await expect(panel).toContainText(
          `Payout と脱落（Elimination）・${out.length} 人`,
        );
        await panel.getByText(/^Payout と脱落（Elimination）/).click();
        await expect(panel.locator('[data-place="6"]')).toHaveCount(1);
        await expect(panel.locator('[data-place="6"]')).toContainText("0pt");
      }
      handId = await startNextHand(page);
      current = await finishHand(page, handId, "fold");
    }
    expect(eliminatedSeen, "Heads-Up の前に Elimination を見た").toBe(true);
    // Hero と CPU 1 人が残って Tournament が続いている（Heads-Up へ移る）。
    expect(current.result.status).toBe("in_progress");
    expect(current.result.remaining).toBe(2);
    status = current;
  });

  await test.step("Heads-Up の Hand は 2 人の席で始まり、All-in で決着させて Tournament を終える", async () => {
    let current = status as TournamentStatus;
    for (let hand = 0; current.result.status === "in_progress"; hand++) {
      expect(hand, "Heads-Up の Hand の数").toBeLessThan(MAX_HANDS);
      handId = await startNextHand(page);
      await expect(page.getByRole("region", { name: "卓" })).toHaveAttribute(
        "data-seat-count",
        "2",
      );
      await expect(panel).toContainText("2 / 6 人");
      current = await finishHand(page, handId, "shove");
    }
    status = current;
    expect(current.result.status).toBe("finished");
  });

  await test.step("Result: 順位ごとの Payout が 50 / 30 / 20%（300 / 180 / 120pt）の通りで、Hero の Bust で残った CPU だけが未決", async () => {
    const result = (status as TournamentStatus).result;
    const hero = result.placements.find((p) => p.playerId === "hero");
    // Heads-Up まで残ったので、Hero は 1 位（優勝）か 2 位（Heads-Up で Bust）。
    expect([1, 2]).toContain(hero?.place);
    // 順位の決まった Player の Payout は、その順位の賞金（入賞の外は 0pt）と完全に一致する。
    const decided = result.placements.filter((p) => p.place !== null);
    for (const p of decided) {
      expect(p.payout, `${p.playerId}（${p.place} 位）`).toBe(
        PAYOUTS_BY_PLACE[(p.place ?? 0) - 1] ?? 0,
      );
    }
    // 優勝なら全員の順位が決まり、Payout の合計は Prize Pool 600pt。Heads-Up で Bust したら、残った CPU 1 人の順位と Payout は
    // 未決（D129）で、決まった Payout の合計は 1 位の賞金を除いた 300pt。
    const undecided = result.placements.filter((p) => p.place === null);
    if (hero?.place === 1) {
      expect(undecided).toHaveLength(0);
      expect(decided.map((p) => p.place).sort()).toEqual([1, 2, 3, 4, 5, 6]);
    } else {
      expect(undecided).toHaveLength(1);
      expect(undecided[0]?.payout).toBeNull();
      expect(decided.map((p) => p.place).sort()).toEqual([2, 3, 4, 5, 6]);
    }
    const paid = decided.reduce((sum, p) => sum + (p.payout ?? 0), 0);
    expect(paid).toBe(
      hero?.place === 1 ? PRIZE_POOL : PRIZE_POOL - PAYOUTS_BY_PLACE[0],
    );

    await expect(dock.getByText("Session が終了しました。")).toBeVisible();
    await expect(dock.locator(".result__session")).toHaveText(
      hero?.place === 1
        ? "Hero が優勝しました（1 位・Payout 300pt）。Tournament は終了です。"
        : "Hero は 2 位で Tournament を終えました（Payout 180pt）。",
    );
    await expect(panel).toHaveAttribute("data-tournament-status", "finished");
    await expect(panel).toContainText("Tournament の結果（Result）");
    await expect(panel).toContainText("Prize Pool 600pt");
    await expect(panel.locator(".tournament__place--hero")).toContainText(
      `${hero?.place} 位`,
    );
    await expect(panel.locator('[data-place="3"]')).toContainText("120pt");
    if (hero?.place === 2) {
      await expect(panel.locator('[data-place="undecided"]')).toContainText(
        "未確定",
      );
      await expect(panel).toContainText(
        "Hero の Bust で終えたため、残った CPU の順位は決めていません（未決）。",
      );
    }
  });

  await test.step("最後の Hand の Review で、Chip EV と ICM を別の項目として出す", async () => {
    await dock.getByRole("button", { name: "この Hand の Review" }).click();
    await expect(
      page.getByRole("heading", { name: "Hand Review" }),
    ).toBeVisible();
    // Heads-Up の All-in の判断（Important Spot を先に並べる）。
    await page.locator(".spot-row").first().click();
    // Tournament の Important Spot の理由（Short Stack。#189・#190）が Cash と共通の理由（All-in）と並ぶ。
    await expect(page.getByText(/^Short Stack（\d+ BB 以下）$/)).toBeVisible();
    await page.getByRole("button", { name: "Review を作る" }).click();
    await expect(page.getByText(`${FAKE_MARK}Pot Odds`)).toBeVisible();

    // Math は Chip で計算した値だと見出しで分かり、Tournament の欄は別の項目として出る（D130）。
    const math = page.locator("details.evidence", {
      hasText: "計算（Math・Chip で計算）",
    });
    await expect(math).toHaveCount(1);
    const icm = page.locator("details.evidence", {
      hasText: "Tournament（ICM / Prize Equity と Chip EV）",
    });
    await expect(icm).toHaveCount(1);
    // 固定応答は ICM の必要 Equity を Evidence として引用する（#189）。
    await expect(icm.locator("summary .evidence__cited")).toBeVisible();
    await icm.locator("summary").click();
    await expect(icm).toContainText("Heads-Up");
    await expect(icm).toContainText("2 / 6 人");
    await expect(
      icm.getByRole("table", { name: /判断時点の ICM Equity/ }),
    ).toBeVisible();
    // Heads-Up で争う賞金は 1 位と 2 位の 480pt。2 人の ICM Equity の合計がそれに一致する（小数第 1 位に丸めた表示）。
    const equities = await icm
      .locator('table[data-evidence="icm"] tbody tr td:nth-of-type(2)')
      .allInnerTexts();
    expect(equities).toHaveLength(2);
    const total = equities
      .map((text) => Number(/^[\d,.]+/.exec(text)?.[0].replace(/,/g, "")))
      .reduce((sum, v) => sum + v, 0);
    expect(total).toBeCloseTo(480, 0);
    const allIn = icm.getByRole("table", { name: /の必要 Equity（Chip EV/ });
    await expect(allIn).toBeVisible();
    await expect(
      allIn.getByRole("columnheader", { name: "Chip EV の必要 Equity" }),
    ).toBeVisible();
    await expect(
      allIn.getByRole("columnheader", { name: "ICM の必要 Equity" }),
    ).toBeVisible();
  });

  await test.step("Replay で最後の Hand を開き、Important Spot へジャンプする", async () => {
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
    await expect(
      page.getByRole("button", { name: "この判断の Review を見る" }),
    ).toBeVisible();
  });

  await test.step("卓に戻り、新しい Tournament を始める（Level 1・6 人・Starting Stack から）", async () => {
    await page.getByRole("button", { name: "卓に戻る" }).click();
    await dock
      .getByLabel("新しい Session の種類")
      .selectOption({ label: TOURNAMENT_CHOICE });
    const lastHandId = handId;
    handId = await startNextHand(page, "新しい Session を始める");
    expect(handId).not.toBe(lastHandId);
    const fresh = await tournamentOf(page, handId);
    expect(fresh).toMatchObject({ level: 1, handNumber: 1 });
    expect(fresh.result).toMatchObject({ entrants: 6, remaining: 6 });
    await expect(page.getByRole("region", { name: "卓" })).toHaveAttribute(
      "data-seat-count",
      "6",
    );
    await expect(header).toHaveText("Level 1 · 10 / 20 · BB Ante 20");
    await expect(panel).toContainText("6 / 6 人");
    // 前の Tournament の Stack を持ち越さず、全員が Starting Stack 1,500 から始まる。
    const start = (await replaySteps(page, handId)).find(
      (s) => s.seats.length > 0,
    );
    expect(start?.seats.map((s) => s.stack)).toEqual(Array(6).fill(1_500));
  });
});
