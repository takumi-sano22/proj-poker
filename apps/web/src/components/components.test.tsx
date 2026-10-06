// 部品の静的な描画を確かめる（DOM 環境を足さず、react-dom/server の文字列で見る）。
import { DEFAULT_CHIP_DENOMINATIONS } from "@proj-poker/engine";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { preflopHeroToAct, seat } from "../testing/fixtures.js";
import { Amount } from "./Amount.js";
import { ChipControls } from "./ChipControls.js";
import { ChipPile, ChipStack } from "./ChipStack.js";
import { OutageDialog } from "./OutageDialog.js";
import { Table } from "./Table.js";

const noop = () => {};
const nameOf = (id: string) => id.toUpperCase();

/** 描画した宣言ボタンのラベル（declaration__label）を順に取り出す。 */
function declarationLabels(html: string): string[] {
  return [...html.matchAll(/declaration__label">(.*?)<\/span><\/span>/g)].map(
    (m) => (m[1] ?? "").replace(/<[^>]+>/g, ""),
  );
}

describe("Amount", () => {
  it("実額を正本として出し、BB 換算を補助として添える", () => {
    const html = renderToStaticMarkup(<Amount value={37} bigBlind={2} />);
    expect(html).toContain('amount__real">37<');
    expect(html).toContain('amount__bb">18.5 BB<');
  });
});

describe("ChipStack（額から組んだ Chip の構成を色付きの積みで描く。D92）", () => {
  /** 描いた積みを [額面, 枚数, 描いた Chip の数] の列にする。 */
  function columns(html: string): [number, number, number][] {
    return [
      ...html.matchAll(
        /data-denomination="(\d+)" data-count="(\d+)"[^>]*>(?:<span class="chip-column__count">[^<]*<\/span>)?<span class="chip-column__pile">(.*?)<\/span><\/span><\/span>/g,
      ),
    ].map((m) => [
      Number(m[1]),
      Number(m[2]),
      (m[3]?.match(/class="chip /g) ?? []).length,
    ]);
  }

  it("大きい額面から、額面に対応する色で描く（額面と色は Config の Preset）", () => {
    const html = renderToStaticMarkup(<ChipStack amount={1234} />);
    expect(columns(html)).toEqual([
      [500, 2, 2],
      [100, 2, 2],
      [25, 1, 1],
      [5, 1, 1],
      [1, 4, 4],
    ]);
    expect(html).toContain("chip chip--purple");
    expect(html).toContain("chip chip--black");
    expect(html).toContain("chip chip--green");
    expect(html).toContain("chip chip--red");
    expect(html).toContain("chip chip--white");
  });

  it("額が 0 なら何も描かない。多い枚数は重ねる数に上限を置き、枚数（×N）で示す", () => {
    expect(renderToStaticMarkup(<ChipStack amount={0} />)).toBe("");
    const html = renderToStaticMarkup(<ChipStack amount={500 * 20} />);
    expect(columns(html)).toEqual([[500, 20, 5]]);
    expect(html).toContain("×20");
    // 上限以下は枚数を数えられるので ×N は付けない
    expect(renderToStaticMarkup(<ChipStack amount={500 * 5} />)).not.toContain(
      "chip-column__count",
    );
  });

  it("渡した額面で組む（既定の Preset ではなく Config の値に従う）", () => {
    const html = renderToStaticMarkup(
      <ChipStack
        amount={30}
        denominations={[
          { value: 1, color: "white" },
          { value: 10, color: "purple" },
        ]}
      />,
    );
    expect(columns(html)).toEqual([[10, 3, 3]]);
    expect(html).not.toContain("chip--red");
  });

  it("Preset の色にはすべて CSS の面と縁の定義がある（色の名前が表示側とずれない）", () => {
    const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
    for (const { color } of DEFAULT_CHIP_DENOMINATIONS) {
      expect(css).toContain(`.chip--${color} {`);
      expect(css).toContain(`--color-chip-${color}:`);
      expect(css).toContain(`--color-chip-${color}-edge:`);
    }
  });
});

describe("ChipPile（出した Chip を枚数のまま描く）", () => {
  it("額から組み直さず、額面ごとの枚数で描く（500 の 1 枚は 100 ×5 にしない）", () => {
    const html = renderToStaticMarkup(<ChipPile chips={[500, 5, 5, 1]} />);
    expect(html).toContain('data-denomination="500" data-count="1"');
    expect(html).toContain('data-denomination="5" data-count="2"');
    expect(html).toContain('data-denomination="1" data-count="1"');
    expect(renderToStaticMarkup(<ChipPile chips={[]} />)).toBe("");
  });
});

describe("ChipControls（Chip の Click / Drag と宣言 Button。docs/06 §4・§5）", () => {
  const hero = (view: ReturnType<typeof preflopHeroToAct>) => view.seats[0]!;

  it("宣言 Button は局面によらず Fold / Check / Call / Bet / Raise / All-in を全部出す（合法性は裁定が決める）", () => {
    const view = preflopHeroToAct();
    const html = renderToStaticMarkup(
      <ChipControls
        view={view}
        hero={hero(view)}
        disabled={false}
        onSubmit={noop}
      />,
    );
    expect(declarationLabels(html)).toEqual([
      "フォールド（Fold）",
      "チェック（Check）",
      "コール（Call）",
      "ベット（Bet）",
      "レイズ（Raise）",
      "オールイン（All-in）",
    ]);
    // Call / All-in の額は、手番にサーバーが返した Legal Action の額を補助で出す
    expect(html).toContain('declaration__amount">2<');
    expect(html).toContain('declaration__amount">200 まで<');
  });

  it("数値の Bet Box（Slider・Preset・数値の入力欄）を作らない", () => {
    const view = preflopHeroToAct();
    const html = renderToStaticMarkup(
      <ChipControls
        view={view}
        hero={hero(view)}
        disabled={false}
        onSubmit={noop}
      />,
    );
    expect(html).not.toContain("<input");
    expect(html).not.toContain("Pot</");
    expect(html).not.toContain("最小（Min）");
  });

  it("Config の額面ごとに Chip を出し、持っている額を超える Chip だけ押せない", () => {
    const view = preflopHeroToAct();
    const html = renderToStaticMarkup(
      <ChipControls
        view={view}
        hero={seat("hero", { stack: 30 })}
        disabled={false}
        onSubmit={noop}
      />,
    );
    const chips = [
      ...html.matchAll(
        /<button type="button" class="chip-button" data-denomination="(\d+)"( disabled="")?/g,
      ),
    ].map((m) => [Number(m[1]), m[2] !== undefined]);
    expect(chips).toEqual([
      [1, false],
      [5, false],
      [25, false],
      [100, true],
      [500, true],
    ]);
  });

  it("手番でなくても操作できる（Out-of-Turn も裁定の対象）。まだ何も出していなければ確定は押せない", () => {
    const view = preflopHeroToAct({ actorId: "cpu1", legalActions: null });
    const html = renderToStaticMarkup(
      <ChipControls
        view={view}
        hero={hero(view)}
        disabled={false}
        onSubmit={noop}
      />,
    );
    // 手番でなければ Legal Action の額は無いので、額を出さない
    expect(html).not.toContain("declaration__amount");
    const declarations =
      html.match(/<button[^>]*class="btn [^"]*declaration"[^>]*>/g) ?? [];
    expect(declarations).toHaveLength(6);
    expect(declarations.some((b) => b.includes("disabled"))).toBe(false);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>確定して Dealer に渡す/);
  });

  it("送信中・保留中はどのボタンも押せない", () => {
    const view = preflopHeroToAct();
    const html = renderToStaticMarkup(
      <ChipControls view={view} hero={hero(view)} disabled onSubmit={noop} />,
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
    // Stack 200 は 100 の Chip 2 枚、Bet 2（BB）は 1 の Chip 2 枚。実額は積みの隣に常時出ている
    expect(html).toContain('data-denomination="100" data-count="2"');
    expect(html).toContain('data-denomination="1" data-count="2"');
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
