// Phase 7 の E2E（#169・D122）: Hero の Review の根拠の欄に、卓の傾向（Table Tendency）が出る。
// 6-max の Session で Hero は毎 Hand Fold し（Stack をほぼ減らさず、数 Hand で Bust しない）、CPU の Action だけで Hand を重ねる。
// (1) Hero が判断した最初の Hand（前の Hand が無い）の Review: 根拠の欄は「卓の傾向はありません」と出し、エラーにしない
// (2) 十分な Hand を重ねた後の Hand の Review: 根拠の欄に項目ごとの割合と分子 / 分母・機会があった Hand・十分か保留かが出る。
//     画面の値は API が返す保存済みの Evidence と同じ（AI の説明文から拾わない）。Hand は handId で特定する
// (3) 画面にも API の応答にも、CPU の Persona・Memory・Tilt・Learning-only Reveal（Pass B の全員の札）が出ない
// (4) 375×667・320×568・1280×720 で横スクロールが出ず、項目が重ならない
// 山札の seed を固定し、CPU は RuleBot、Review AI は固定応答（REVIEW_PROVIDER=fake）なので Claude を呼ばない（D98）。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { intersects, type Rect } from "../support/layout.js";
import { startNextHand } from "../support/next-hand.js";
import { startFirstHand } from "../support/play.js";
import {
  startServer,
  stopServer,
  type RunningServer,
} from "../support/server.js";

/** 卓の傾向が十分になる前の Hand の数（Policy の下限。Hand が 10 以上）。これだけ重ねた後の Hand の Review を見る。 */
const PRIOR_HANDS = 11;
/** 無限に回さないための Hand の上限（Hero が判断しない Hand は数えない）。 */
const MAX_HANDS = 40;

const VIEWPORTS = [
  { width: 1280, height: 720 },
  { width: 375, height: 667 },
  { width: 320, height: 568 },
] as const;

/** API が返す Evidence の卓の傾向（サーバーの TableTendencyEvidence のうち、この検査が読む項目）。 */
interface TendencyItem {
  readonly id: string;
  readonly item: string;
  readonly rate: number | null;
  readonly numerator: number;
  readonly denominator: number;
  readonly hands: number;
  readonly sufficient: boolean;
}

interface ReviewApi {
  readonly latest: {
    readonly evidence: {
      readonly opponentObservation:
        | { readonly status: "unavailable" }
        | {
            readonly status: "available";
            readonly tableTendency: {
              readonly hands: number;
              readonly items: readonly TendencyItem[];
            };
          };
    };
  } | null;
  readonly versions: number;
}

let dir = "";
let server: RunningServer | null = null;

test.beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "proj-poker-e2e-"));
});

// Playwright は第 1 引数（fixture）を分割代入で受けることを求めるので、使わない fixture も {} で受ける。
// eslint-disable-next-line no-empty-pattern
test.afterEach(async ({}, testInfo) => {
  if (server !== null) {
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

/**
 * Hand の終わりまで、Hero の手番では Fold する。Hero が判断したか（Review できる判断があるか）を返す。
 * Hero が BB で全員が Fold した Hand などは、Hero の手番が無いまま終わる。
 */
async function playFoldHand(page: Page): Promise<boolean> {
  const dock = page.getByRole("region", { name: "Hero" });
  const done = dock.getByText(/Hand が終了しました。|Session が終了しました。/);
  let acted = false;
  for (let turn = 0; turn < 30; turn++) {
    await expect(dock.getByText("Hero の手番です。").or(done)).toBeVisible({
      timeout: 30_000,
    });
    if (await done.isVisible()) return acted;
    const log = page.getByRole("region", { name: "Hand の進行" }).locator("li");
    const before = await log.count();
    await dock.getByRole("button", { name: /^フォールド（Fold）/ }).click();
    acted = true;
    await expect
      .poll(() => log.count(), { timeout: 30_000 })
      .toBeGreaterThan(before);
  }
  throw new Error("Hand が 30 手番で終わらなかった");
}

/** 終わった Hand の Review を開き、最初の判断（Hero は Fold の 1 回だけ）の Pass A を作る。 */
async function openAndCreateReview(page: Page): Promise<void> {
  await page.getByRole("button", { name: "この Hand の Review" }).click();
  await expect(
    page.getByRole("heading", { name: "Hand Review" }),
  ).toBeVisible();
  await page.locator(".spot-row").first().click();
  await page.getByRole("button", { name: "Review を作る" }).click();
  await expect(page.locator(".review-body .assessment").first()).toBeVisible();
}

async function reviewApi(page: Page, handId: string): Promise<ReviewApi> {
  const res = await page.request.get(
    `/api/reviews/hands/${handId}/decisions/0`,
  );
  expect(res.ok(), `Review の API（${handId}）`).toBe(true);
  return (await res.json()) as ReviewApi;
}

/** 根拠の欄「卓の傾向」を開く（畳んである）。 */
async function openTendencySection(page: Page) {
  const section = page
    .locator("details.evidence")
    .filter({ hasText: "卓の傾向（Table Tendency）" });
  await expect(section).toHaveCount(1);
  if ((await section.getAttribute("open")) === null) {
    await section.locator("summary").click();
  }
  await expect(section).toHaveAttribute("open", "");
  return section;
}

/** 横スクロールが出ていないこと。 */
async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow, "横スクロール").toBe(0);
}

/** 卓の傾向の項目が、画面の中に収まり、互いに・項目の中の要素同士が重ならないこと。 */
async function expectTendencyLayout(page: Page): Promise<void> {
  const measured = await page.evaluate(() => {
    const rectOf = (el: Element) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    };
    return [...document.querySelectorAll(".tendency__item")].map((item) => ({
      item: item.getAttribute("data-tendency-item") ?? "",
      rect: rectOf(item),
      overflowX: item.scrollWidth - item.clientWidth,
      parts: [...item.children].map((child) => rectOf(child)),
    }));
  });
  expect(measured.length).toBeGreaterThan(0);
  const viewportWidth = page.viewportSize()?.width ?? 0;
  for (const m of measured) {
    expect(m.rect.left, `${m.item} の左端`).toBeGreaterThanOrEqual(0);
    expect(m.rect.right, `${m.item} の右端`).toBeLessThanOrEqual(viewportWidth);
    expect(m.overflowX, `${m.item} の中の横あふれ`).toBeLessThanOrEqual(0);
    for (let i = 0; i < m.parts.length; i++) {
      for (let j = i + 1; j < m.parts.length; j++) {
        expect(
          intersects(m.parts[i] as Rect, m.parts[j] as Rect),
          `${m.item} の中の要素 ${i} と ${j} が重なる`,
        ).toBe(false);
      }
    }
  }
  for (let i = 0; i < measured.length; i++) {
    for (let j = i + 1; j < measured.length; j++) {
      expect(
        intersects(
          (measured[i] as { rect: Rect }).rect,
          (measured[j] as { rect: Rect }).rect,
        ),
        `項目 ${i} と ${j} が重なる`,
      ).toBe(false);
    }
  }
}

test("Review の根拠の欄に、保存された Evidence の卓の傾向が出る（無いときは無いと出し、CPU の内部状態・Reveal は出ない）", async ({
  page,
}) => {
  server = await startServer(join(dir, "poker.sqlite"));
  await page.goto("/");

  const dock = page.getByRole("region", { name: "Hero" });
  let handId = await startFirstHand(page);
  let handNumber = 1;
  let acted = await playFoldHand(page);
  let earlyHandId = "";
  let tendencyHandId = "";

  // Hero が判断した最初の Hand の Review（前の Hand が無い → 卓の傾向は無い）。その後は Review せず Hand を重ねる。
  await test.step("前の Hand が無い Hand の Review: 根拠の欄は「卓の傾向はありません」と出す", async () => {
    while (!acted) {
      expect(handNumber, "Hero が判断する Hand").toBeLessThan(MAX_HANDS);
      handId = await startNextHand(page);
      handNumber++;
      acted = await playFoldHand(page);
    }
    earlyHandId = handId;
    await openAndCreateReview(page);
    const api = await reviewApi(page, earlyHandId);
    expect(api.latest?.evidence.opponentObservation.status).toBe("unavailable");
    const section = await openTendencySection(page);
    await expect(section).toContainText("卓の傾向はありません");
    await expect(section.locator(".tendency__item")).toHaveCount(0);
    await expectNoHorizontalScroll(page);
    await page.getByRole("button", { name: "卓に戻る" }).click();
  });

  await test.step(`${PRIOR_HANDS} Hand 以上を重ねる（Hero は Fold を続ける）`, async () => {
    // 判断した Hand を数えて、前の Hand が十分になった後の、Hero が判断した Hand まで進める。
    while (handNumber <= PRIOR_HANDS || !acted) {
      expect(handNumber, "Hand の数の上限").toBeLessThan(MAX_HANDS);
      handId = await startNextHand(page);
      handNumber++;
      acted = await playFoldHand(page);
    }
    tendencyHandId = handId;
    expect(tendencyHandId).not.toBe(earlyHandId);
  });

  await test.step("十分な Hand を重ねた後の Hand の Review: 項目ごとの割合と分子 / 分母・機会があった Hand・十分か保留かを出す", async () => {
    await expect(dock.getByText("Hand が終了しました。")).toBeVisible();
    await openAndCreateReview(page);
    const api = await reviewApi(page, tendencyHandId);
    expect(api.versions).toBe(1);
    const observation = api.latest?.evidence.opponentObservation;
    if (observation?.status !== "available") {
      throw new Error("卓の傾向が Evidence に入っていない");
    }
    const { hands, items } = observation.tableTendency;
    // 判断の Hand より前の Hand だけを数える（この Hand 自身は入らない）。
    expect(hands).toBeGreaterThanOrEqual(PRIOR_HANDS - 1);
    expect(hands).toBeLessThan(handNumber);
    expect(items.map((i) => i.item)).toEqual([
      "vpip",
      "pfr",
      "aggression_frequency",
      "showdown",
    ]);
    expect(items.some((i) => i.sufficient)).toBe(true);

    const section = await openTendencySection(page);
    await expect(section).toContainText(`この判断より前の ${hands} Hand`);
    await expect(section.locator(".tendency__item")).toHaveCount(items.length);
    // 画面の値は API の Evidence と同じ（割合 + 分子 / 分母・機会があった Hand・十分か）。説明文からは拾わない。
    for (const item of items) {
      const row = section.locator(`[data-tendency-item="${item.item}"]`);
      const expectedRate =
        item.rate === null ? "—" : `${Math.round(item.rate * 100)}%`;
      await expect(row.locator(".tendency__value")).toHaveText(
        `${expectedRate}（${item.numerator} / ${item.denominator}）`,
      );
      await expect(row.locator(".tendency__meta")).toHaveText(
        `機会があった Hand: ${item.hands}`,
      );
      await expect(row).toContainText(
        item.sufficient ? "サンプルが十分" : "サンプルが足りない（保留）",
      );
    }
    // 固定応答は卓の傾向の id を根拠に挙げないので、「説明の根拠」の印はこの区分に出ない（Evidence を作り直していない）。
    await expect(section.locator(".evidence__cited")).toHaveCount(0);

    await test.step("画面にも API の応答にも、Persona・Memory・Tilt・Learning-only Reveal が出ない", async () => {
      const screen = (
        await page.locator("main.review").innerText()
      ).toLowerCase();
      const body = JSON.stringify(api).toLowerCase();
      for (const word of ["persona", "memory", "tilt", "hypothesis"]) {
        expect(screen, `画面の ${word}`).not.toContain(word);
        expect(body, `API の ${word}`).not.toContain(word);
      }
      // Hand 後の答え合わせ（Pass B。全員の札）には切り替えていない。
      await expect(page.getByRole("heading", { name: "全員の札" })).toHaveCount(
        0,
      );
    });

    await test.step("375×667・320×568・1280×720 で横スクロールが出ず、項目が重ならない", async () => {
      for (const viewport of VIEWPORTS) {
        await page.setViewportSize(viewport);
        await section.scrollIntoViewIfNeeded();
        await expect(section.locator(".tendency__item").first()).toBeVisible();
        await expectNoHorizontalScroll(page);
        await expectTendencyLayout(page);
      }
    });
  });
});
