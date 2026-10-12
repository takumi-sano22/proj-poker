// Hero の操作の下書き（TurnDraft。#219・D146）の E2E の共通手順: HU 卓の固定局面、手元の Chip・Betting Area・通知・再確認欄の Locator、
// 物理的な操作の要求の読み取り。テストの手順だけの待ち・読み取りで、プロダクトの挙動は変えない（server に障害注入のコードを足さない）。
import {
  expect,
  type Locator,
  type Page,
  type Request,
} from "@playwright/test";
import { startFirstHand } from "./play.js";

/**
 * HU（2 人卓）の固定 seed（TABLE_SIZE=2）。最初の Hand は Hero が SB で先に動く。
 * - RAISE_SEED: Hero が Call すると、CPU（BB）が preflop で 4 へ Raise する（同じ Street で currentBet が 2 → 4 に変わる）
 * - STREET_SEED: Hero が Call すると、CPU は Check して Flop になる（Street が進む）。Flop で CPU が先に Bet する
 * CPU の思考待ち（BOT_THINK_DELAY_MS）の間が、Hero の手番外で下書きを組める時間になる。
 */
export const RAISE_SEED = "8";
export const STREET_SEED = "1";

export function huEnv(
  seed: string,
  thinkDelayMs: number,
): Record<string, string> {
  return {
    TABLE_SIZE: "2",
    POKER_SEED: seed,
    BOT_THINK_DELAY_MS: String(thinkDelayMs),
  };
}

export function dockOf(page: Page): Locator {
  return page.getByRole("region", { name: "Hero" });
}

export function declarationButton(page: Page, name: string | RegExp): Locator {
  return dockOf(page)
    .getByRole("group", { name: "宣言（Declaration）" })
    .getByRole("button", { name });
}

/** 上部のナビゲーションで領域を選び、その領域が今の領域（aria-current）になるのを待つ。 */
export async function goTo(page: Page, area: "Home" | "Play" | "Learn") {
  const tab = page
    .getByRole("navigation", { name: "画面の切り替え" })
    .getByRole("button", { name: area });
  await tab.click();
  await expect(tab).toHaveAttribute("aria-current", "page");
}

/** 手元（手に取った Chip）の額の表示。 */
export function handAmount(page: Page): Locator {
  return dockOf(page).locator(".chip-hand__amount");
}

/** Betting Area に出した Chip の額の表示（何も出していなければ要素が無い）。 */
export function pushedAmount(page: Page): Locator {
  return dockOf(page).locator(".betting-area__amount");
}

/** Betting Area の宣言の表示（宣言が無ければ要素が無い）。 */
export function declaredLabel(page: Page): Locator {
  return dockOf(page).locator(".betting-area__declared");
}

/** Stack の Chip を 1 枚手に取る（額面ごとの Button）。 */
export async function pick(page: Page, value: number): Promise<void> {
  await dockOf(page)
    .getByRole("button", { name: `${value} の Chip を手に取る`, exact: true })
    .click();
}

/** 手に取った Chip を Betting Area に出す。 */
export async function pushHand(page: Page): Promise<void> {
  await dockOf(page)
    .getByRole("button", {
      name: /^手に取った Chip .* を Betting Area に出す$/,
    })
    .click();
}

/** 手元に value 額を取り、Betting Area へ 1 回出す（1 の Chip だけで組む）。 */
export async function pickAndPush(page: Page, value: number): Promise<void> {
  for (let i = 0; i < value; i++) await pick(page, 1);
  await pushHand(page);
}

/** 中身のあった下書きを捨てたときの通知（role=status。RULING の欄 name「Dealer の裁定」とは文言で分ける）。 */
export function discardNotice(page: Page): Locator {
  return dockOf(page).getByRole("status").filter({
    hasText: "組んでいた操作（手元の Chip・出した Chip・宣言）を戻しました",
  });
}

/** 状況の変化の再確認欄。 */
export function changeNotice(page: Page): Locator {
  return dockOf(page).getByRole("group", {
    name: "組んだ後に卓の状況が変わりました",
  });
}

export function submitButton(page: Page): Locator {
  return dockOf(page).getByRole("button", {
    name: "確定して Dealer に渡す",
    exact: true,
  });
}

export function confirmButton(page: Page): Locator {
  return changeNotice(page).getByRole("button", {
    name: "この内容で確定して Dealer に渡す",
  });
}

export function resendButton(page: Page): Locator {
  return dockOf(page).getByRole("button", { name: "同じ操作をもう一度送る" });
}

/** 物理的な操作（POST /api/hands/:id/physical-actions）の要求か。 */
export function isPhysicalAction(request: Request): boolean {
  return (
    request.method() === "POST" &&
    /^\/api\/hands\/[^/]+\/physical-actions$/.test(
      new URL(request.url()).pathname,
    )
  );
}

/** 物理的な操作の要求を数え、送った body（lastSeq・actions）を順に溜める。page.goto の前に呼ぶ。 */
export function recordPhysicalActions(page: Page): {
  count: () => number;
  bodies: () => { lastSeq: number; actions: Record<string, unknown>[] }[];
} {
  const bodies: { lastSeq: number; actions: Record<string, unknown>[] }[] = [];
  page.on("request", (request) => {
    if (!isPhysicalAction(request)) return;
    bodies.push(
      JSON.parse(request.postData() ?? "{}") as (typeof bodies)[number],
    );
  });
  return { count: () => bodies.length, bodies: () => bodies };
}

/** 物理的な操作の応答を待つ。click の直前に呼んで Promise を保持し、click の後に await する。 */
export function waitForPhysicalResponse(page: Page) {
  return page.waitForResponse((r) => isPhysicalAction(r.request()));
}

/**
 * 最初の Hand の Hero の手番（SB）で Call を宣言して CPU の思考待ちに入り、Hero の手番でない状態にする（下書きを組める）。
 * 「Hero の手番です。」が消えるまで待つので、古い表示を手番と取り違えない。
 */
export async function callAndWaitForCpu(page: Page): Promise<void> {
  const turn = dockOf(page).getByText("Hero の手番です。");
  await expect(turn).toBeVisible();
  const sent = waitForPhysicalResponse(page);
  await declarationButton(page, /^コール（Call）/).click();
  expect((await sent).ok(), "Call の宣言").toBe(true);
  await expect(turn).toBeHidden();
}

export async function startHuAndCall(page: Page): Promise<string> {
  await page.goto("/");
  const handId = await startFirstHand(page);
  await callAndWaitForCpu(page);
  return handId;
}
