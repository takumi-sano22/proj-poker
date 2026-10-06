// 部品の静的な描画を確かめる（DOM 環境を足さず、react-dom/server の文字列で見る）。
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { preflopHeroToAct, seat } from "../testing/fixtures.js";
import { ActionBar } from "./ActionBar.js";
import { Amount } from "./Amount.js";
import { OutageDialog } from "./OutageDialog.js";
import { Table } from "./Table.js";

const noop = () => {};
const nameOf = (id: string) => id.toUpperCase();

/** 描画した宣言ボタンのラベル（declaration__label）を順に取り出す。 */
function declarationLabels(html: string): string[] {
  return [...html.matchAll(/declaration__label">([^<]+)</g)].map(
    (m) => m[1] ?? "",
  );
}

describe("Amount", () => {
  it("実額を正本として出し、BB 換算を補助として添える", () => {
    const html = renderToStaticMarkup(<Amount value={37} bigBlind={2} />);
    expect(html).toContain('amount__real">37<');
    expect(html).toContain('amount__bb">18.5 BB<');
  });
});

describe("ActionBar（Declaration Button は Legal Action だけを出す）", () => {
  it("Call と Raise の局面: Fold / Call / All-in と Raise の額指定を出し、Check・Bet は出さない", () => {
    const view = preflopHeroToAct();
    const html = renderToStaticMarkup(
      <ActionBar
        view={view}
        legal={view.legalActions!}
        disabled={false}
        onAction={noop}
      />,
    );
    expect(declarationLabels(html)).toEqual([
      "レイズ（Raise）",
      "フォールド（Fold）",
      "コール（Call）",
      "オールイン（All-in）",
    ]);
    // Slider の範囲はサーバーの min / max のまま。数値の入力欄は作らない
    expect(html).toContain('type="range"');
    expect(html).toContain('min="4"');
    expect(html).toContain('max="200"');
    expect(html).not.toContain('type="number"');
    expect(html).not.toContain('type="text"');
  });

  it("Check できる局面: Check と Bet を出し、Call・Raise は出さない", () => {
    const view = preflopHeroToAct({
      street: "flop",
      currentBet: 0,
      legalActions: {
        playerId: "hero",
        toCall: 0,
        actions: [
          { type: "fold" },
          { type: "check" },
          { type: "bet", min: 2, max: 198 },
          { type: "all_in", amount: 198 },
        ],
      },
    });
    const html = renderToStaticMarkup(
      <ActionBar
        view={view}
        legal={view.legalActions!}
        disabled={false}
        onAction={noop}
      />,
    );
    expect(declarationLabels(html)).toEqual([
      "ベット（Bet）",
      "フォールド（Fold）",
      "チェック（Check）",
      "オールイン（All-in）",
    ]);
  });

  it("送信中はボタンを押せない", () => {
    const view = preflopHeroToAct();
    const html = renderToStaticMarkup(
      <ActionBar
        view={view}
        legal={view.legalActions!}
        disabled
        onAction={noop}
      />,
    );
    const buttons = html.match(/<button[^>]*>/g) ?? [];
    expect(buttons.length).toBeGreaterThan(0);
    expect(buttons.every((b) => b.includes("disabled"))).toBe(true);
  });
});

describe("Table（他者の札はサーバーが公開したものだけを表に向ける）", () => {
  it("公開されていない席は裏向き、Fold した席は札なし、Showdown で公開された札は表", () => {
    const base = preflopHeroToAct();
    const view = preflopHeroToAct({
      seats: [
        base.seats[0]!,
        seat("cpu1", { folded: true }),
        seat("cpu2", {
          holeCards: [
            { rank: 12, suit: "c" },
            { rank: 12, suit: "d" },
          ],
        }),
        seat("cpu3", { isButton: true }),
        seat("cpu4", { folded: true }),
        seat("cpu5", { folded: true }),
      ],
    });
    const html = renderToStaticMarkup(<Table view={view} nameOf={nameOf} />);
    // 裏向きは cpu3 の 2 枚だけ
    expect(html.match(/aria-label="伏せた札"/g)).toHaveLength(2);
    expect(html).toContain('aria-label="クラブの Q"');
    expect(html).toContain('aria-label="ダイヤの Q"');
    // Hero の札は画面下の欄に出すため、卓の上には描かない
    expect(html).not.toContain('aria-label="スペードの A"');
  });

  it.each([2, 8])(
    "%i 席でも全席を 1 回ずつ描き、Hero の席を持ち、人数を data 属性で示す",
    (n) => {
      const ids = [
        "hero",
        ...Array.from({ length: n - 1 }, (_, i) => `cpu${i + 1}`),
      ];
      const base = preflopHeroToAct();
      const view = preflopHeroToAct({
        seats: ids.map((id, i) => seat(id, { isButton: i === 0 })),
        actorId: "hero",
        log: base.log.filter((e) => e.type !== "BLIND_POSTED"),
      });
      const html = renderToStaticMarkup(<Table view={view} nameOf={nameOf} />);
      expect(html.match(/data-player-id=/g)).toHaveLength(n);
      for (const id of ids) expect(html).toContain(`data-player-id="${id}"`);
      expect(html).toContain(`data-seat-count="${n}"`);
      // Hero の席は 1 つだけで、Hero の札は卓の上に描かない（他者の裏向き札だけ）
      expect(html.match(/seat--hero/g)).toHaveLength(1);
      expect(html.match(/aria-label="伏せた札"/g)).toHaveLength((n - 1) * 2);
    },
  );

  it("Stack・Pot・Bet を実額で出し、Dealer Button と SB / BB と手番を示す", () => {
    const html = renderToStaticMarkup(
      <Table view={preflopHeroToAct()} nameOf={nameOf} />,
    );
    expect(html).toContain("ポット（Pot）");
    expect(html).toContain('amount__real">3<');
    expect(html).toContain('amount__real">199<');
    expect(html).toContain('title="ボタン（BTN）"');
    expect(html).toContain('title="スモールブラインド（SB）"');
    expect(html).toContain('title="ビッグブラインド（BB）"');
    expect(html).toMatch(/seat seat--hero seat--actor/);
    expect(html).toContain("手番");
    // Board はまだ配られていないので 5 枠とも空
    expect(html.match(/card-slot/g)).toHaveLength(5);
  });
});

describe("OutageDialog（CPU の障害の続け方。D86）", () => {
  it("止まった CPU の名前と 3 つの選択肢を出し、内部実装の名前は出さない", () => {
    const html = renderToStaticMarkup(
      <OutageDialog
        actorName="CPU 3"
        kind="unauthenticated"
        disabled={false}
        onChoose={noop}
      />,
    );
    expect(html).toContain('role="alertdialog"');
    expect(html).toContain("CPU 3 の判断を受け取れませんでした");
    expect(html).toContain("もう一度試す（Retry）");
    expect(html).toContain("Emergency Bot で続行");
    expect(html).toContain("Session を終了");
    expect(html).toContain("一時停止");
    expect(html).not.toMatch(/Claude|SDK|haiku/i);
    expect(html).not.toContain("disabled");
  });

  it("送信中は選べない", () => {
    const html = renderToStaticMarkup(
      <OutageDialog actorName="CPU 3" kind="error" disabled onChoose={noop} />,
    );
    expect(html.match(/disabled=""/g)).toHaveLength(3);
  });
});
