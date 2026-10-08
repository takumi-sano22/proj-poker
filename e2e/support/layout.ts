// 卓の配置の E2E の共通手順（#163）: 画面の大きさごとに、席・Board・Pot・画面下の Hero 欄・操作 Button の矩形を測り、
// 操作できなくなる重なりが無いことを確かめる。測るだけで、プロダクトの挙動は変えない。
import { expect, type Page } from "@playwright/test";

export interface Rect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

export function intersects(a: Rect, b: Rect): boolean {
  return (
    a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
  );
}

/** 画面の大きさ。1 つの Hand・Session を、これらの大きさで順に測る。 */
export const LAYOUT_VIEWPORTS = [
  { width: 720, height: 600 },
  { width: 1024, height: 768 },
  { width: 1280, height: 720 },
  { width: 375, height: 667 },
  { width: 320, height: 568 },
] as const;

/** 卓の上の要素（Hero の席・他の席・Board・Pot・Hand の結果）と、Hero 欄・その中の Button の矩形。 */
interface LayoutMeasure {
  readonly viewportHeight: number;
  readonly overflowX: number;
  readonly heroSeat: Rect | null;
  readonly seats: Rect[];
  readonly board: Rect | null;
  readonly pot: Rect | null;
  /** 卓の中央の結果の欄（広い画面だけ。狭い画面は Hero 欄に出す）。 */
  readonly centerResult: Rect | null;
  readonly dock: Rect;
  /** Hero 欄の中の Button。reachable は、中心を覆っている要素が Button 自身（の中）か。 */
  readonly buttons: { name: string; rect: Rect; reachable: boolean }[];
}

async function measureLayout(page: Page): Promise<LayoutMeasure> {
  return page.evaluate(() => {
    const rectOf = (el: Element | null): Rect | null => {
      if (el === null) return null;
      const r = el.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    };
    const dockEl = document.querySelector(".dock");
    if (dockEl === null) throw new Error("Hero 欄が無い");
    const buttons = [...dockEl.querySelectorAll("button")].map((button) => {
      // elementFromPoint は画面の中の点しか返さないので、Button を画面の中へ入れてから中心を覆う要素を取る（測る前のスクロール位置に依らない）。
      button.scrollIntoView({ block: "nearest" });
      const rect = rectOf(button) as Rect;
      const hit = document.elementFromPoint(
        (rect.left + rect.right) / 2,
        (rect.top + rect.bottom) / 2,
      );
      return {
        name: (button.textContent ?? "").trim().slice(0, 24),
        rect,
        reachable: hit !== null && button.contains(hit),
      };
    });
    return {
      viewportHeight: window.innerHeight,
      overflowX: document.documentElement.scrollWidth - window.innerWidth,
      heroSeat: rectOf(document.querySelector(".table .seat--hero")),
      seats: [...document.querySelectorAll(".table .seat")].map(
        (e) => rectOf(e) as Rect,
      ),
      board: rectOf(document.querySelector(".table .board")),
      pot: rectOf(document.querySelector(".table .pot")),
      centerResult: rectOf(document.querySelector(".table .result")),
      dock: rectOf(dockEl) as Rect,
      buttons,
    };
  });
}

/**
 * いまの画面の大きさ・Hand の状態で、操作できなくなる重なりが無いことを確かめる。
 *
 * - 卓の席・Board・Pot・結果の欄が互いに重ならない（矩形）。
 * - Hero 欄の Button の中心を、Button 自身が受ける（他の要素に覆われていない）。通常の click（force なし）で押せる
 *   （trial: 押下はせず、Playwright の「覆われていないか・安定しているか」の確認だけを行う）。
 * - 横スクロールが出ない。
 * - 720px 以上（広い画面）: Hero 欄を除いた画面の高さに、Hero の席から Board までが同時に収まる。Hero 欄は画面下に固定されるので、
 *   欄が高すぎると、どこまでスクロールしても Hero の席と Board を同時には見られない（#163: 720×600 で欄が 434px になった）。
 *   狭い画面は縦長の卓で欄も高く、320px では収まらない（`references/proj-poker.md`「既知のずれ」）ので、この項目は測らない。
 */
export async function expectNoBlockingOverlap(
  page: Page,
  label: string,
): Promise<void> {
  const m = await measureLayout(page);
  const width = page.viewportSize()?.width ?? 0;

  const tableRects: { name: string; rect: Rect }[] = [
    ...m.seats.map((rect, i) => ({ name: `席 ${i}`, rect })),
    ...(m.board === null ? [] : [{ name: "Board", rect: m.board }]),
    ...(m.pot === null ? [] : [{ name: "Pot", rect: m.pot }]),
    ...(m.centerResult === null
      ? []
      : [{ name: "卓の中央の結果の欄", rect: m.centerResult }]),
  ];
  for (let i = 0; i < tableRects.length; i++) {
    for (let j = i + 1; j < tableRects.length; j++) {
      const a = tableRects[i];
      const b = tableRects[j];
      if (a === undefined || b === undefined) continue;
      expect(
        intersects(a.rect, b.rect),
        `${label}: ${a.name} と ${b.name} が重なっている: ${JSON.stringify(a.rect)} / ${JSON.stringify(b.rect)}`,
      ).toBe(false);
    }
  }

  expect(m.buttons.length, `${label}: Hero 欄に Button がある`).toBeGreaterThan(
    0,
  );
  for (const b of m.buttons) {
    expect(
      b.reachable,
      `${label}: 「${b.name}」の中心が別の要素に覆われている`,
    ).toBe(true);
  }
  expect(m.overflowX, `${label}: 横スクロール`).toBe(0);

  if (width >= 720) {
    expect(m.heroSeat, `${label}: Hero の席`).not.toBeNull();
    expect(m.board, `${label}: Board`).not.toBeNull();
    const top = Math.min(
      m.board?.top ?? 0,
      m.pot?.top ?? Infinity,
      m.heroSeat?.top ?? Infinity,
    );
    const bottom = Math.max(m.heroSeat?.bottom ?? 0, m.pot?.bottom ?? 0);
    const dockHeight = m.dock.bottom - m.dock.top;
    const room = m.viewportHeight - dockHeight;
    expect(
      bottom - top,
      `${label}: Hero 欄（高さ ${Math.round(dockHeight)}px）を除いた ${Math.round(room)}px に、Hero の席・Board・Pot（${Math.round(bottom - top)}px）が同時に収まる`,
    ).toBeLessThanOrEqual(room);
  }
}

/** Hero 欄の Button を、押さずに通常の click の確認（覆われていない・安定している）だけ行う。 */
export async function expectClickable(
  page: Page,
  names: readonly string[],
): Promise<void> {
  const dock = page.getByRole("region", { name: "Hero" });
  for (const name of names) {
    await dock.getByRole("button", { name }).click({ trial: true });
  }
}
