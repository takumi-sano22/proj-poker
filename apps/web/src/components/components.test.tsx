// 部品の静的な描画を確かめる（DOM 環境を足さず、react-dom/server の文字列で見る）。
import { DEFAULT_CHIP_DENOMINATIONS } from "@proj-poker/engine";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  NARROW_SCREEN_QUERY,
  useNarrowScreen,
} from "../hooks/useNarrowScreen.js";
import { preflopHeroToAct, seat } from "../testing/fixtures.js";
import { Amount } from "./Amount.js";
import { BbDisplayProvider, BbDisplayToggle } from "./BbDisplay.js";
import { ChipControls } from "./ChipControls.js";
import { ChipPile, ChipStack } from "./ChipStack.js";
import { DealerFeedback } from "./DealerFeedback.js";
import { FastForward } from "./FastForward.js";
import { HandLog } from "./HandLog.js";
import { OutageDialog } from "./OutageDialog.js";
import { Seat, Table } from "./Table.js";
import { Term, VocabBody } from "./Vocabulary.js";

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

describe("BB 補助表示の切り替え（実額は常に出す。D49）", () => {
  it("OFF では BB 換算を出さず、実額はそのまま出す。Context が無ければ（既定）出す", () => {
    const off = renderToStaticMarkup(
      <BbDisplayProvider value={false}>
        <Amount value={37} bigBlind={2} />
      </BbDisplayProvider>,
    );
    expect(off).toContain('amount__real">37<');
    expect(off).not.toContain("amount__bb");
    expect(off).not.toContain("BB");
    const on = renderToStaticMarkup(
      <BbDisplayProvider value={true}>
        <Amount value={37} bigBlind={2} inline />
      </BbDisplayProvider>,
    );
    expect(on).toContain('amount__bb">18.5 BB<');
  });

  it("OFF では Table の Stack・Pot・Bet のどこにも BB 換算が出ず、実額は全部出る", () => {
    const view = preflopHeroToAct();
    const off = renderToStaticMarkup(
      <BbDisplayProvider value={false}>
        <Table view={view} nameOf={nameOf} />
      </BbDisplayProvider>,
    );
    expect(off).not.toContain("amount__bb");
    expect(off).toContain('amount__real">3<');
    expect(off).toContain('amount__real">199<');
    expect(off).toContain('amount__real">198<');
    const on = renderToStaticMarkup(<Table view={view} nameOf={nameOf} />);
    expect(on).toContain("amount__bb");
  });

  it("OFF では宣言 Button の BB 換算も出さず、実額（200 まで）は出す", () => {
    const view = preflopHeroToAct();
    const render = (showBB: boolean) =>
      renderToStaticMarkup(
        <BbDisplayProvider value={showBB}>
          <ChipControls
            view={view}
            hero={view.seats[0]!}
            disabled={false}
            onSubmit={noop}
          />
        </BbDisplayProvider>,
      );
    expect(render(true)).toContain("declaration__bb");
    const off = render(false);
    expect(off).not.toContain("declaration__bb");
    expect(off).toContain('declaration__amount">200 まで<');
  });

  it("Poker Vocabulary の例も、OFF では実額だけで書く（Pot の例）", () => {
    const render = (showBB: boolean) =>
      renderToStaticMarkup(
        <BbDisplayProvider value={showBB}>
          <VocabBody
            id="pot"
            view={preflopHeroToAct()}
            nameOf={nameOf}
            onSelect={noop}
          />
        </BbDisplayProvider>,
      );
    expect(render(true)).toContain("今の Pot は 3（1.5 BB）。");
    expect(render(false)).toContain("今の Pot は 3。");
  });

  it("切り替えボタンは押された状態（aria-pressed）と ON / OFF で状態を伝える", () => {
    const on = renderToStaticMarkup(
      <BbDisplayToggle showBB={true} onChange={noop} />,
    );
    expect(on).toContain('aria-pressed="true"');
    expect(on).toContain("BB 補助表示");
    expect(on).toContain(">ON<");
    const off = renderToStaticMarkup(
      <BbDisplayToggle showBB={false} onChange={noop} />,
    );
    expect(off).toContain('aria-pressed="false"');
    expect(off).toContain(">OFF<");
  });
});

describe("Fast Forward（D12・D93）", () => {
  it("押された状態を示し、AI の応答時間は縮まないことをいつも添える（ON でも OFF でも）", () => {
    for (const active of [true, false]) {
      const html = renderToStaticMarkup(
        <FastForward active={active} disabled={false} onChange={noop} />,
      );
      expect(html).toContain(`aria-pressed="${active}"`);
      expect(html).toContain("Fast Forward");
      expect(html).toContain("AI の応答を待つ時間そのものは短くなりません");
    }
  });

  it("送信中は押せない", () => {
    const html = renderToStaticMarkup(
      <FastForward active={false} disabled={true} onChange={noop} />,
    );
    expect(html).toContain("disabled");
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

describe("Table の Bet の札と中央の並べ方（狭い画面の配置。#5）", () => {
  const dir = { x: 0, y: -1 };
  const renderSeat = (betInside: boolean) =>
    renderToStaticMarkup(
      <Seat
        seat={seat("cpu1", { streetCommitted: 30 })}
        direction={dir}
        name="CPU 1"
        blind={undefined}
        isHero={false}
        isActor={false}
        bigBlind={2}
        showBet
        betInside={betInside}
      />,
    );

  it("Bet の札は、卓の上（既定）か席の面の中（狭い画面）のどちらか 1 か所にだけ描き、実額は同じように出す", () => {
    const onTable = renderSeat(false);
    expect(onTable.match(/class="bet"/g)).toHaveLength(1);
    expect(onTable).toContain("--dir-x");
    expect(onTable).not.toContain("bet--inside");
    expect(onTable).toContain('aria-label="CPU 1 のベット 30"');
    const inside = renderSeat(true);
    expect(inside.match(/bet bet--inside/g)).toHaveLength(1);
    expect(inside).toContain('aria-label="CPU 1 のベット 30"');
    // 席の面（.seat__plate）の中にあり、卓の上の Bet は無い
    expect(inside.indexOf("bet--inside")).toBeGreaterThan(
      inside.indexOf("seat__plate"),
    );
    expect(inside).not.toContain('class="bet"');
    expect(inside).toContain('amount__real">30<');
  });

  it("中央の高さに席の面が来る席数（4・5・7・8 人）だけ、中央を縦に積む印（data-center-stacked）を付ける", () => {
    const view = preflopHeroToAct();
    const withSeats = (n: number) =>
      renderToStaticMarkup(
        <Table
          view={{
            ...view,
            seats: [
              view.seats[0]!,
              ...Array.from({ length: n - 1 }, (_, i) => seat(`cpu${i + 1}`)),
            ],
          }}
          nameOf={nameOf}
        />,
      );
    for (const n of [4, 5, 7, 8]) {
      expect(withSeats(n), `${n} 人`).toContain("data-center-stacked");
    }
    for (const n of [2, 3, 6]) {
      expect(withSeats(n), `${n} 人`).not.toContain("data-center-stacked");
    }
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

  it("Hero が Fold した後の観戦中も、Hand が終わるまで他者の札は全部裏向きのまま（表の札は描かない）", () => {
    const base = preflopHeroToAct();
    const spectating = preflopHeroToAct({
      actorId: "cpu1",
      legalActions: null,
      seats: [
        // Fold した Hero の札は本人のものなので Hero の欄に出る（卓の上には描かない）
        { ...base.seats[0]!, folded: true },
        ...base.seats.slice(1).map((s) => ({ ...s, holeCards: null })),
      ],
    });
    const html = renderToStaticMarkup(
      <Table view={spectating} nameOf={nameOf} />,
    );
    // 残っている CPU 5 席は 2 枚ずつ裏向き。表向きの札（aria-label が「…の A」等）は 1 枚も無い
    expect(html.match(/aria-label="伏せた札"/g)).toHaveLength(10);
    expect(html).not.toMatch(/aria-label="(クラブ|ダイヤ|ハート|スペード)の/);
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

  it("狭い画面で Hero の欄に出すときは、卓に重ねる位置指定を外す class を付ける", () => {
    const render = (docked: boolean) =>
      renderToStaticMarkup(
        <OutageDialog
          actorName="CPU 3"
          kind="error"
          disabled={false}
          docked={docked}
          onChoose={noop}
        />,
      );
    expect(render(false)).toContain('class="outage"');
    expect(render(true)).toContain('class="outage outage--docked"');
  });
});

describe("狭い画面の判定（卓の席と重なる欄を Hero の欄へ置く境界。#5）", () => {
  function Probe() {
    return <p>{useNarrowScreen() ? "narrow" : "wide"}</p>;
  }

  it("matchMedia が無い環境（サーバー描画・テスト）では広い画面として扱う", () => {
    expect(renderToStaticMarkup(<Probe />)).toContain("wide");
  });

  it("判定の境界は styles.css の狭い画面の @media と同じ値（片方だけ変えない）", () => {
    const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
    const max = /\(max-width: (\d+)px\)/.exec(NARROW_SCREEN_QUERY)?.[1];
    expect(max).toBeDefined();
    // 席・卓の中央・Hero の欄の狭い画面向けの規則は、すべてこの境界の @media に置く
    expect(css).toContain(`@media (max-width: ${max}px) {`);
    expect(css).toContain(`@media (min-width: ${Number(max) + 1}px) {`);
  });
});

describe("Poker Vocabulary の用語と詳細（docs/06 §7）", () => {
  it("卓の用語は詳細を開く button で、開いているかを aria-expanded で示す。記号の表記でも用語の名前で読ませる", () => {
    const plain = renderToStaticMarkup(<Term id="pot" />);
    expect(plain).toContain('type="button"');
    expect(plain).toContain('aria-haspopup="dialog"');
    expect(plain).toContain('aria-expanded="false"');
    expect(plain).toContain(">ポット（Pot）<");
    const symbol = renderToStaticMarkup(<Term id="button">D</Term>);
    expect(symbol).toContain('aria-label="ボタン（BTN）"');
    expect(symbol).toContain(">D<");
  });

  it("詳細は Definition・Current Hand Example・Related Concept・Advanced Detail の 4 項目を出し、関連の用語は選べる", () => {
    const html = renderToStaticMarkup(
      <VocabBody
        id="pot"
        view={preflopHeroToAct()}
        nameOf={nameOf}
        onSelect={noop}
      />,
    );
    expect(html).toContain("意味（Definition）");
    expect(html).toContain("この Hand では（Current Hand Example）");
    expect(html).toContain("今の Pot は 3（1.5 BB）。");
    expect(html).toContain("関連（Related Concept）");
    expect(html).toContain(">ポットオッズ（Pot Odds）</button>");
    expect(html).toContain("詳しく（Advanced Detail）");
  });

  it("卓の上の Street・Pot・Dealer Button・SB / BB は用語として開ける", () => {
    const html = renderToStaticMarkup(
      <Table view={preflopHeroToAct()} nameOf={nameOf} />,
    );
    for (const id of ["preflop", "pot", "button", "smallBlind", "bigBlind"]) {
      expect(html).toContain(`data-term="${id}"`);
    }
  });
});

describe("Dealer Feedback（RULING / ETIQUETTE / COACHING を混ぜない。docs/06 §6）", () => {
  const items = [
    { category: "ruling", text: "裁定の文", terms: ["oversizedChip"] },
    { category: "etiquette", text: "作法の文", terms: [] },
    { category: "coaching", text: "学習の文", terms: ["potOdds"] },
  ] as const;

  it("RULING は常に出し、ETIQUETTE と COACHING は分類の名前の button で開く（混ぜない・色だけに頼らない）", () => {
    const html = renderToStaticMarkup(<DealerFeedback items={items} />);
    // 項目として描くのは RULING だけ（作法・学習の文は 1 つの項目に混ぜない）
    expect(html.match(/<li /g)).toHaveLength(1);
    expect(html).toContain('data-category="ruling"');
    expect(html).toContain("裁定（Ruling）");
    expect(html).toContain("裁定の文");
    expect(html).not.toContain("作法の文");
    expect(html).not.toContain("学習の文");
    // 作法・学習は分類の名前の button（閉じた状態）
    expect(html).toMatch(
      /feedback-tag--etiquette feedback__toggle" aria-expanded="false"[^>]*>作法（Etiquette）</,
    );
    expect(html).toMatch(
      /feedback-tag--coaching feedback__toggle" aria-expanded="false"[^>]*>学習（Coaching）</,
    );
    // その場面で起きた概念は用語として開ける
    expect(html).toContain('data-term="oversizedChip"');
    expect(renderToStaticMarkup(<DealerFeedback items={[]} />)).toBe("");
  });

  it("前の Street の裁定には見出しを添える", () => {
    const html = renderToStaticMarkup(
      <DealerFeedback items={items} heading="プリフロップ（Preflop）の裁定" />,
    );
    expect(html).toContain("プリフロップ（Preflop）の裁定");
  });

  it("進行ログでも、裁定を分類ごとの別の行にする", () => {
    const base = preflopHeroToAct();
    const pub = { type: "public" } as const;
    const view = preflopHeroToAct({
      log: [
        ...base.log,
        {
          seq: 5,
          visibility: pub,
          type: "PHYSICAL_CHIP_ACTION",
          playerId: "hero",
          street: "preflop",
          motion: "chip_push",
          chips: [25],
        },
        {
          seq: 6,
          visibility: pub,
          type: "DEALER_RULING",
          playerId: "hero",
          street: "preflop",
          basis: "operations",
          outcome: "action",
          action: { type: "call" },
          notes: ["oversized_chip"],
        },
        {
          seq: 7,
          visibility: pub,
          type: "ACTION_TAKEN",
          playerId: "hero",
          street: "preflop",
          action: "call",
          amount: 2,
          toAmount: 2,
          allIn: false,
        },
      ],
    });
    const html = renderToStaticMarkup(<HandLog view={view} nameOf={nameOf} />);
    expect(html).toContain(
      'hand-log__feedback--ruling" data-category="ruling"',
    );
    expect(html).toContain(
      'hand-log__feedback--etiquette" data-category="etiquette"',
    );
    expect(html).toContain(
      'hand-log__feedback--coaching" data-category="coaching"',
    );
    expect(html).toContain("Chip（25）を 1 枚出しました");
    // 裁定の結果の Chip の動きは、続く ACTION_TAKEN の行に出る
    expect(html).toContain("HERO: コール（Call） 2");
  });
});
