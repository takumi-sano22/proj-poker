// Phase 6 の Critical E2E（#119・docs/09 §8）: Session Learning の通し。
// Play（Session の終わりまで）→ Review（Pass A・Pass B）→ Session Review → Player Profile → Targeted Drill → 練習した判断の Review
// → Learning Reset（Event / Review は残る）→ server を再起動しても Learning data と Drill の provenance が同じ。
// 山札の seed を固定し、CPU は RuleBot、Review AI は固定応答（REVIEW_PROVIDER=fake）なので Claude を呼ばない（D98）。
// 既存の session.spec.ts（6-max の Play・Review・Replay・Resume・User Read / Note / Tag）と重ならないよう、ここでは
// Session の終わりからの学習の流れだけを通す。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { startNextHand } from "../support/next-hand.js";
import {
  startServer,
  stopServer,
  type RunningServer,
} from "../support/server.js";

/** E2E の固定応答の印（apps/server/src/review/fake-review-query.ts の FAKE_REVIEW_MARK）。 */
const FAKE_MARK = "（E2E 用の固定応答）";
/** Pass B（Learning-only Reveal）の固定応答の文の一部。Learning の応答・画面に混ざらないことを確かめる。 */
const PASS_B_TEXT = "判断時点に仮定した Range と、Hand 後に見せた実際の札";

/**
 * この E2E の server の設定の差分。
 * - 2 人卓: Hero が毎 Hand All-in すれば数 Hand で Session が終わる（Session Review の入口は Session の終わりに出る）
 * - Pass A の段階評価を「改善の余地あり」にする: Leak があると Recommended Drill の候補が出る
 */
const LEARNING_ENV = {
  TABLE_SIZE: "2",
  FAKE_REVIEW_ASSESSMENT: "improvement_suggested",
} as const;

let dir = "";
let server: RunningServer | null = null;

test.beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "proj-poker-e2e-learning-"));
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

/** 宣言 Button の補助の額（Call / All-in は Legal Action の額。合法でなければ出ない）。 */
async function declaredAmount(button: Locator): Promise<number | null> {
  const amount = button.locator(".declaration__amount");
  if ((await amount.count()) === 0) return null;
  const text = (await amount.innerText()).replace(/[,，]/g, "");
  const match = /^\d+/.exec(text);
  return match === null ? null : Number(match[0]);
}

/**
 * Hand の終わりまで Hero の手番を進める。shove なら All-in できる手番は All-in（Session を早く終わらせる）、
 * それ以外は Call できれば Call、できなければ Check。
 */
async function playToHandEnd(page: Page, shove: boolean): Promise<void> {
  const dock = page.getByRole("region", { name: "Hero" });
  const log = page.getByRole("region", { name: "Hand の進行" }).locator("li");
  for (let turn = 0; turn < 30; turn++) {
    // 「Drill の Hand が終了しました。」も含む。
    const done = dock.getByText(
      /Hand が終了しました。|Session が終了しました。/,
    );
    await expect(dock.getByText("Hero の手番です。").or(done)).toBeVisible({
      timeout: 30_000,
    });
    if (await done.isVisible()) return;

    const before = await log.count();
    const allIn = dock.getByRole("button", { name: /^オールイン（All-in）/ });
    const call = dock.getByRole("button", { name: /^コール（Call）/ });
    if (shove && (await declaredAmount(allIn)) !== null) {
      await allIn.click();
    } else if ((await declaredAmount(call)) !== null) {
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

async function getJson<T>(page: Page, path: string): Promise<T> {
  const res = await page.request.get(path);
  expect(res.ok(), path).toBe(true);
  return (await res.json()) as T;
}

interface DrillResults {
  readonly drills: readonly {
    readonly drillId: string;
    readonly source: {
      readonly handId: string;
      readonly decisionIndex: number;
    };
    readonly drillHandId: string;
    readonly decisionIndex: number;
    readonly finished: boolean;
    readonly assessment: string | null;
  }[];
  readonly score: {
    readonly since: string | null;
    readonly decisions: { readonly total: number; readonly reviewed: number };
  };
}

type Drill = DrillResults["drills"][number];

/** 元の判断と、練習した判断の Pass A の Review の API（Reset・再起動の前後で同じであることを確かめる）。 */
function reviewPathsOf(drill: Drill | undefined): string[] {
  if (drill === undefined) throw new Error("Drill が始まっていない");
  return [
    `/api/reviews/hands/${drill.source.handId}/decisions/${drill.source.decisionIndex}`,
    `/api/reviews/hands/${drill.drillHandId}/decisions/${drill.decisionIndex}`,
  ];
}

/**
 * 再起動の前後で比べる Learning data（どれも Event Log・reviews・drills・learning_resets から読むたびに作り直す Projection）。
 * Hypothesis の computedAt は読むたびに Snapshot を作り直した時刻なので比べない。
 */
async function learningSnapshot(
  page: Page,
  handId: string,
  drill: Drill | undefined,
): Promise<unknown> {
  const profile = await getJson<Record<string, unknown>>(
    page,
    "/api/learning/profile",
  );
  return JSON.parse(
    JSON.stringify({
      sessionReview: await getJson(
        page,
        `/api/learning/session-review/${handId}`,
      ),
      profile,
      drills: await getJson(page, "/api/drills"),
      replay: await getJson(page, "/api/replay/hands"),
      reviews: await Promise.all(
        reviewPathsOf(drill).map((p) => getJson(page, p)),
      ),
    }),
    (key, value: unknown) => (key === "computedAt" ? undefined : value),
  );
}

test("Session を終わりまで Play → Review → Session Review → Profile → Drill → 練習した判断の Review → Learning Reset → 再起動しても同じ", async ({
  page,
}) => {
  // Session の終わりまで数 Hand を遊び、再起動もするので、既定（120 秒）より長く待つ。
  test.setTimeout(300_000);
  const dbPath = join(dir, "poker.sqlite");
  server = await startServer(dbPath, LEARNING_ENV);
  const dock = page.getByRole("region", { name: "Hero" });

  // Session Review の API に渡す、この Session の Hand（Session のどの Hand でもよい。一覧の並びには頼らない。#129・D117）。
  let sessionHandId = "";
  await test.step("2 人卓で、Session が終わる（どちらかの Stack がなくなる）まで Play する", async () => {
    await page.goto("/");
    await page.getByRole("button", { name: "Hand を始める" }).click();
    await expect(page.getByRole("region", { name: "卓" })).toHaveAttribute(
      "data-seat-count",
      "2",
    );
    for (let hand = 0; hand < 40; hand++) {
      await playToHandEnd(page, true);
      if (await dock.getByText("Session が終了しました。").isVisible()) break;
      // 前の Hand の終了表示を新しい Hand の終わりと読み違えないよう、画面が新しい Hand に切り替わるまで待つ（#133）。
      await startNextHand(page);
    }
    await expect(dock.getByText("Session が終了しました。")).toBeVisible();
    const hands = await getJson<{ hands: { handId: string }[] }>(
      page,
      "/api/replay/hands",
    );
    // この時点の Hand はどれもこの Session の Hand（Drill はまだ無い）。並びに依らないよう、handId の辞書順で 1 つ選ぶ。
    const ids = hands.hands.map((h) => h.handId).sort();
    sessionHandId = ids[0] ?? "";
    expect(sessionHandId).not.toBe("");
    // 選んだ Hand の Session Review が、一覧のすべての Hand を数えている（同じ Session の Hand を選んだ）。
    const review = await getJson<{ hands: number }>(
      page,
      `/api/learning/session-review/${sessionHandId}`,
    );
    expect(review.hands).toBe(ids.length);
  });

  await test.step("最後の Hand の Review を開き、判断時点の Review（Pass A）と Hand 後の答え合わせ（Pass B）を作る", async () => {
    await dock.getByRole("button", { name: "この Hand の Review" }).click();
    await expect(
      page.getByRole("heading", { name: "Hand Review" }),
    ).toBeVisible();
    await page.locator(".spot-row").first().click();
    await page.getByRole("button", { name: "Review を作る" }).click();
    await expect(page.getByText(`${FAKE_MARK}Pot Odds`)).toBeVisible();
    await expect(
      page.locator(".review-body .assessment").first(),
    ).toContainText("改善の余地あり");

    await page.getByRole("button", { name: "Hand 後の答え合わせ" }).click();
    await page.getByRole("button", { name: "答え合わせを作る" }).click();
    await expect(page.getByText(PASS_B_TEXT)).toBeVisible();
  });

  const learning = page.locator("main.learning");
  await test.step("Session Review: 判断の質（M 件中 N 件）・Leak・Hero の Stats・おすすめの Drill を出す", async () => {
    await page.getByRole("button", { name: "卓に戻る" }).click();
    await page.getByRole("button", { name: "この Session を振り返る" }).click();
    await expect(
      page.getByRole("heading", {
        name: "Session の振り返り（Session Review）",
      }),
    ).toBeVisible();
    await expect(
      learning.getByText(/この Session の判断 \d+ 件中 1 件を Review 済み/),
    ).toBeVisible();
    const leaks = learning.getByRole("region", {
      name: "改善の余地がある判断（Leak）",
    });
    await expect(leaks.locator(".spot-row")).toHaveCount(1);
    await expect(leaks.locator(".spot-row")).toContainText("改善の余地あり");
    await expect(
      learning.getByText(/Hand から数えた Hero 自身の統計です/).first(),
    ).toBeVisible();
    await expect(learning.getByText(/^候補: Hand \d+ の/)).toBeVisible();
    await expect(
      learning.getByRole("button", { name: "Drill を始める" }),
    ).toBeEnabled();
    // Learning-only Reveal（Pass B）の文は Session Review / Profile に出ない。
    await expect(learning.getByText(PASS_B_TEXT)).toHaveCount(0);
  });

  await test.step("Player Profile: Review 済みの判断から Score と弱点の仮説を作り、直近 / 全期間を切り替えられる", async () => {
    const profile = learning.getByRole("region", {
      name: "Player Profile（直近 / 全期間）",
    });
    await expect(
      profile.getByText(/^全期間の判断 \d+ 件中 1 件を Review 済み$/),
    ).toBeVisible();
    await expect(
      profile.getByText("弱点の仮説はまだありません", { exact: false }),
    ).toHaveCount(0);
    await profile.getByRole("button", { name: "全期間（Long-term）" }).click();
    await expect(
      profile.getByRole("button", { name: "全期間（Long-term）" }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(
      profile.getByText("Review 済みの判断 1 件", { exact: true }),
    ).toBeVisible();

    // 応答にも Pass B・CPU の Persona が入らない（Leakage 0。単体テストは apps/server の learning / session-review）。
    const json = JSON.stringify([
      await getJson(page, "/api/learning/profile"),
      await getJson(page, `/api/learning/session-review/${sessionHandId}`),
    ]);
    expect(json).not.toContain(PASS_B_TEXT);
    expect(json).not.toContain("readComparison");
    expect(json.toLowerCase()).not.toContain("persona");
  });

  let drill: Drill | undefined;
  await test.step("おすすめの Drill を始め、Drill の Hand を最後まで遊ぶ", async () => {
    await learning.getByRole("button", { name: "Drill を始める" }).click();
    await expect(
      page.getByRole("heading", { name: "Targeted Drill（練習）" }),
    ).toBeVisible();
    await playToHandEnd(page, false);
    await expect(
      dock.getByText("Drill の Hand が終了しました。"),
    ).toBeVisible();
    const results = await getJson<DrillResults>(page, "/api/drills");
    expect(results.drills).toHaveLength(1);
    drill = results.drills[0];
    // provenance: 元の Hand は Session の Hand で、Drill の Hand は別の Hand。
    expect(drill?.finished).toBe(true);
    expect(drill?.drillHandId).not.toBe(drill?.source.handId);
  });

  await test.step("練習した判断の Review を作る", async () => {
    await dock.getByRole("button", { name: "練習した判断の Review" }).click();
    await page.getByRole("button", { name: "Review を作る" }).click();
    await expect(page.getByText(`${FAKE_MARK}Pot Odds`)).toBeVisible();
    await expect(
      page.locator(".review-body .assessment").first(),
    ).toContainText("改善の余地あり");
  });

  await test.step("Session Review に戻る: Drill の結果は別の欄に数え、通常の Score・Profile には混ぜない", async () => {
    await page.getByRole("button", { name: "卓に戻る" }).click();
    await page.getByRole("button", { name: "この Session を振り返る" }).click();
    const drills = learning.getByRole("region", {
      name: "Drill の結果（通常の Score と別に数えます）",
    });
    await expect(
      drills.getByText(/^練習した判断 \d+ 件中 1 件を Review 済み$/),
    ).toBeVisible();
    await expect(drills.locator(".spot-row")).toContainText("改善の余地あり");
    await expect(
      learning.getByText(/この Session の判断 \d+ 件中 1 件を Review 済み/),
    ).toBeVisible();
    await expect(
      learning.getByText(/^全期間の判断 \d+ 件中 1 件を Review 済み$/),
    ).toBeVisible();
  });

  await test.step("Learning Reset: Score・仮説・まとめは数え直し、Hand の記録・Review・Drill の provenance は残る", async () => {
    const replayBefore = await getJson(page, "/api/replay/hands");
    const drillsBefore = await getJson<DrillResults>(page, "/api/drills");
    expect(drillsBefore.score.decisions.reviewed).toBe(1);
    expect(drillsBefore.drills[0]?.assessment).toBe("improvement_suggested");
    const reviewsBefore = await Promise.all(
      reviewPathsOf(drill).map((p) => getJson(page, p)),
    );

    await learning.getByRole("button", { name: "数え直す…" }).click();
    // 取り消せない操作なので確認を挟み、初期フォーカスは「やめる」。
    await expect(
      learning.getByRole("button", { name: "やめる" }),
    ).toBeFocused();
    await learning
      .getByRole("button", { name: "数え直す", exact: true })
      .click();
    await expect(learning.getByText(/から数え直しました。$/)).toBeVisible();

    // Reset 後に終わった Hand はまだ無いので、Profile は 0 件から数え直す。Session Review（Reset の対象外）は変わらない。
    await expect(
      learning.getByText(/^Reset 後の判断 0 件中 0 件を Review 済み$/),
    ).toBeVisible();
    await expect(
      learning.getByText(/この Session の判断 \d+ 件中 1 件を Review 済み/),
    ).toBeVisible();

    // 正本（Event Log・reviews）と Drill の記録（provenance）は消えない。Drill の系列の Score にも区切りが付く。
    expect(await getJson(page, "/api/replay/hands")).toEqual(replayBefore);
    expect(
      await Promise.all(reviewPathsOf(drill).map((p) => getJson(page, p))),
    ).toEqual(reviewsBefore);
    const results = await getJson<DrillResults>(page, "/api/drills");
    expect(results.drills).toEqual(drillsBefore.drills);
    expect(results.score.since).not.toBeNull();
    // Reset より前に終わった Drill の Hand は、Drill の系列の Score に数えない。前後は保存の論理順序で決めるので、
    // 手元（WSL）の壁時計の巻き戻り（#119 で実測）があっても 0 件になる（#130・D117）。
    expect(results.score.decisions).toMatchObject({ total: 0, reviewed: 0 });
  });

  await test.step("server を再起動しても、Learning data・Drill の provenance・Reset の区切りが同じ", async () => {
    const before = await learningSnapshot(page, sessionHandId, drill);
    await stopServer(server as RunningServer);
    server = await startServer(dbPath, LEARNING_ENV);
    expect(await learningSnapshot(page, sessionHandId, drill)).toEqual(before);

    // 画面からも、保存済みの Hand（Drill の Hand は除く）を Replay の一覧から開ける。
    const replay = await getJson<{ hands: unknown[] }>(
      page,
      "/api/replay/hands",
    );
    await page.reload();
    await page.getByRole("button", { name: "Replay を見る" }).click();
    await expect(page.locator(".replay-item")).toHaveCount(replay.hands.length);
    await page.locator(".replay-item").first().click();
    await expect(page.getByText("Replay（Hero の視点）")).toBeVisible();
  });
});
