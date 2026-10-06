// Equity の既知の値との照合・決定論・性能の上限のテスト。期待値は手計算で、計算過程をコメントに残す。
import { describe, expect, it } from "vitest";
import { parseCards, type Card } from "./card.js";
import {
  DEFAULT_EQUITY_OPTIONS,
  EquityUnavailableError,
  equityVsRanges,
  type EquityOptions,
} from "./equity.js";
import { STANDARD_RANGE_PROFILE } from "./range-config.js";
import { parseRange, type Combo } from "./range.js";

const cards = (text: string): Card[] => parseCards(text);
const combo = (text: string): Combo => cards(text) as unknown as Combo;

describe("equityVsRanges: 既知の値", () => {
  it("River（残りの Card なし）は勝ち・負け・引き分けをそのまま数える", () => {
    // Board 2c 7d 9s Jh Kd。Hero AhAs（A のワンペア）。Range: KK の 3 通り（Kd は Board）→ K のセットで Hero の負け、
    // QQ の 6 通り → Hero の勝ち。勝ち 6 / 9。
    const result = equityVsRanges(cards("Ah As"), cards("2c 7d 9s Jh Kd"), [
      parseRange("KK, QQ"),
    ]);
    expect(result.method).toBe("exact");
    expect(result.trials).toBe(9);
    expect(result.win).toBe(6 / 9);
    expect(result.equity).toBe(6 / 9);
  });

  it("River の引き分けは等分する（Board の Straight を双方が使う）", () => {
    // Board 5c 6d 7h 8s 9c（9 high の Straight）。Hero 2h 3h も相手 2d 3d も Board の Straight → 引き分け。
    const result = equityVsRanges(cards("2h 3h"), cards("5c 6d 7h 8s 9c"), [
      [combo("2d 3d")],
    ]);
    expect(result.tie).toBe(1);
    expect(result.equity).toBe(0.5);
  });

  it("Turn の Flush Draw vs Set: 7 / 44", () => {
    // Hero AhKh、Board 2h 7h 9c Jd、相手 JsJc（J のセット）。見えていない Card は 52 − 2 − 4 − 2 = 44 枚。
    // Heart は 13 − 4 = 9 枚残る（3h 4h 5h 6h 8h 9h Th Jh Qh）。9h は Board の 9 が Pair になり相手が Full House、
    // Jh は相手が Quads なので負け。Hero の勝ちは残り 7 枚。それ以外の River は相手の勝ち（Hero は A high のまま）。
    const result = equityVsRanges(cards("Ah Kh"), cards("2h 7h 9c Jd"), [
      [combo("Js Jc")],
    ]);
    expect(result.method).toBe("exact");
    expect(result.trials).toBe(44);
    expect(result.equity).toBe(7 / 44);
  });

  it("Flop の Set vs Set: 947 / 990", () => {
    // Hero AhAd、Board As Kc 2d、相手 KhKd。残り 45 枚から 2 枚 = 990 通り。
    // 相手が勝つのは残り 1 枚の K（Ks）が出て、残り 1 枚の A（Ac）が出ない出方（相手の Quads）: Ks と、Ac 以外の 43 枚 = 43 通り。
    // Ks と Ac が両方出ると Hero も Quads（A の方が上）。Flush は Diamond が Hero・相手とも 2 枚までで、2 枚足しても 4 枚。
    // Straight（A-K-Q-J-T / A-2-3-4-5）は 3 枚要るので出ない。引き分けは無い。Hero の勝ちは 990 − 43 = 947。
    const result = equityVsRanges(cards("Ah Ad"), cards("As Kc 2d"), [
      [combo("Kh Kd")],
    ]);
    expect(result.method).toBe("exact");
    expect(result.trials).toBe(990);
    expect(result.equity).toBe(947 / 990);
  });

  it("Preflop の AA vs KK は約 82%（seed 固定の Monte Carlo）", () => {
    // AA vs KK の Preflop の Equity は約 81.9%（docs/research/02 §4 の Hand vs Hand。よく知られた値）。
    // 2 万回の標準誤差は約 0.27%（√(0.82 × 0.18 / 20000)）なので、±1.5% は標準誤差の 5 倍以上。
    const result = equityVsRanges(cards("Ah As"), [], [[combo("Kd Kc")]]);
    expect(result.method).toBe("monte_carlo");
    expect(result.seed).toBe(DEFAULT_EQUITY_OPTIONS.seed);
    expect(result.trials).toBe(DEFAULT_EQUITY_OPTIONS.samples);
    expect(result.equity).toBeGreaterThan(0.805);
    expect(result.equity).toBeLessThan(0.835);
  });

  it("Preflop の AKs vs QQ は約 46%（Coin Flip）", () => {
    // AhKh vs QsQc は約 46%（Over Card 2 枚 vs Pair の典型値）。
    const result = equityVsRanges(cards("Ah Kh"), [], [[combo("Qs Qc")]]);
    expect(result.equity).toBeGreaterThan(0.445);
    expect(result.equity).toBeLessThan(0.475);
  });

  it("Range の Combo のうち、Hero の札・Board と重なるものは数えない（Card Removal）", () => {
    // Hero AhAs に対する AA の Range は、残りの Ad Ac の 1 通りだけ。River の Board なので引き分け 1 回。
    const result = equityVsRanges(cards("Ah As"), cards("2c 7d 9s Jh Kd"), [
      parseRange("AA"),
    ]);
    expect(result.trials).toBe(1);
    expect(result.tie).toBe(1);
  });

  it("Monte Carlo の結果は全列挙と近い（Flop の Hand vs Hand）", () => {
    const exact = equityVsRanges(cards("Ah Ad"), cards("As Kc 2d"), [
      [combo("Kh Kd")],
    ]);
    const mc = equityVsRanges(
      cards("Ah Ad"),
      cards("As Kc 2d"),
      [[combo("Kh Kd")]],
      { ...DEFAULT_EQUITY_OPTIONS, maxExactEvaluations: 0 },
    );
    expect(mc.method).toBe("monte_carlo");
    expect(Math.abs(mc.equity - exact.equity)).toBeLessThan(0.01);
  });

  it("Multiway は相手ごとの Range から重ならないように選ぶ（AA vs KK vs QQ は Hero が最も高い）", () => {
    const result = equityVsRanges(
      cards("Ah As"),
      [],
      [[combo("Kd Kc")], [combo("Qd Qc")]],
    );
    expect(result.method).toBe("monte_carlo");
    // 3-way の AA vs KK vs QQ は約 66〜67%。
    expect(result.equity).toBeGreaterThan(0.64);
    expect(result.equity).toBeLessThan(0.7);
  });
});

describe("equityVsRanges: Multiway の組の重み", () => {
  // River の Board 2c 7d 9s Jh 3h、Hero QsQh（Q のワンペア）。
  // 相手 1 の Range: A = KcKd（Hero の負け）・B = 4c4d（Hero の勝ち）。
  // 相手 2 の Range: C1 = Kc5s（A と Kc が重なる）・C2 = 5c6c・C3 = 8c8d（どれも Hero の勝ち。5-6-7 は 4 か 8 が無く Straight にならない）。
  // 重ならない組は (A,C2)・(A,C3)・(B,C1)・(B,C2)・(B,C3) の 5 通りで、各 Range 独立の条件付き分布ではどれも等しい重み。
  // Hero が勝つのは相手 1 が B の 3 通り → Equity = 3 / 5。相手 1 を先に一様に選ぶ偏った抽選だと 1 / 2 になる。
  const hero = cards("Qs Qh");
  const board = cards("2c 7d 9s Jh 3h");
  const first = [combo("Kc Kd"), combo("4c 4d")];
  const second = [combo("Kc 5s"), combo("5c 6c"), combo("8c 8d")];

  it("重ならない組の上で一様に選ぶ（3 / 5 に近い）", () => {
    const result = equityVsRanges(hero, board, [first, second]);
    expect(result.method).toBe("monte_carlo");
    // 2 万回の標準誤差は約 0.35%。±1.5% で 1/2 とははっきり分かれる。
    expect(Math.abs(result.equity - 3 / 5)).toBeLessThan(0.015);
  });

  it("Range の並び順を入れ替えても同じ分布になる", () => {
    const result = equityVsRanges(hero, board, [second, first]);
    expect(Math.abs(result.equity - 3 / 5)).toBeLessThan(0.015);
  });
});

describe("equityVsRanges: 決定論", () => {
  it("同じ入力・同じ seed なら同じ結果になる", () => {
    const range = parseRange(STANDARD_RANGE_PROFILE.open.CO);
    const a = equityVsRanges(cards("Ah Kd"), [], [range]);
    const b = equityVsRanges(cards("Ah Kd"), [], [range]);
    expect(b).toEqual(a);
  });

  it("seed を変えると Monte Carlo の試行が変わる（seed が効いている）", () => {
    const range = parseRange(STANDARD_RANGE_PROFILE.open.CO);
    const options: EquityOptions = { ...DEFAULT_EQUITY_OPTIONS, seed: 2 };
    const a = equityVsRanges(cards("Ah Kd"), [], [range]);
    const b = equityVsRanges(cards("Ah Kd"), [], [range], options);
    expect(b.seed).toBe(2);
    expect(b.equity).not.toBe(a.equity);
    expect(Math.abs(b.equity - a.equity)).toBeLessThan(0.02);
  });

  it("不正な入力は例外にする", () => {
    expect(() => equityVsRanges(cards("Ah"), [], [parseRange("KK")])).toThrow(
      RangeError,
    );
    expect(() =>
      equityVsRanges(cards("Ah Kd"), cards("2c 3c"), [parseRange("KK")]),
    ).toThrow(RangeError);
    expect(() => equityVsRanges(cards("Ah Kd"), [], [])).toThrow(RangeError);
    // 同じ Card を 2 枚使う Combo（外で組んだ不正な Range）は評価しない。
    expect(() =>
      equityVsRanges(cards("Ah Kd"), [], [[combo("Qs Qs")]]),
    ).toThrow(RangeError);
    expect(() =>
      equityVsRanges(cards("Ah Kd"), cards("Ah 3c 4d"), [parseRange("QQ")]),
    ).toThrow(RangeError);
    // Hero が AA を 2 枚持つと、相手の AA は残り 1 通り。Ad Ac が Board にあれば空。
    expect(() =>
      equityVsRanges(cards("Ah As"), cards("Ad Ac 4d"), [parseRange("AA")]),
    ).toThrow(EquityUnavailableError);
  });

  it("相手同士の Range が重なって試行が作れないときは EquityUnavailableError（不正な入力の RangeError と区別する）", () => {
    // 2 人の相手がどちらも Kd Kc しか持ちえない → 同時には配れない。
    expect(() =>
      equityVsRanges(cards("Ah As"), [], [[combo("Kd Kc")], [combo("Kd Kc")]]),
    ).toThrow(EquityUnavailableError);
    // 札の枚数が不正なのは入力の誤りで、EquityUnavailableError ではない。
    expect(() =>
      equityVsRanges(cards("Ah"), [], [parseRange("KK")]),
    ).not.toThrow(EquityUnavailableError);
  });
});

describe("equityVsRanges: 性能の上限", () => {
  // 上限: Flop の手札 vs Range は 500ms 以内（Review の Spot ごとに数回呼ぶ想定）。CI の遅い環境の揺れを見込んだ値。
  const LIMIT_MS = 500;

  it("Flop の手札 vs 全 Combo（random）を全列挙で 500ms 以内", () => {
    const start = Date.now();
    const result = equityVsRanges(cards("Ah Kd"), cards("Qs Jh 2c"), [
      parseRange("random"),
    ]);
    const elapsed = Date.now() - start;
    expect(result.method).toBe("exact");
    // 残り 47 枚から相手の 2 枚（1081 通り）× 残り 45 枚から 2 枚（990 通り）。
    expect(result.trials).toBe(1081 * 990);
    expect(elapsed).toBeLessThan(LIMIT_MS);
  });

  it("Preflop の手札 vs Range（Monte Carlo 2 万回）を 500ms 以内", () => {
    const start = Date.now();
    equityVsRanges(
      cards("Ah Kd"),
      [],
      [parseRange(STANDARD_RANGE_PROFILE.open.BTN)],
    );
    expect(Date.now() - start).toBeLessThan(LIMIT_MS);
  });

  it("Flop の 3-way（Monte Carlo 2 万回）を 500ms 以内", () => {
    const start = Date.now();
    equityVsRanges(cards("Ah Kd"), cards("Qs Jh 2c"), [
      parseRange(STANDARD_RANGE_PROFILE.open.CO),
      parseRange(STANDARD_RANGE_PROFILE.callOpen),
    ]);
    expect(Date.now() - start).toBeLessThan(LIMIT_MS);
  });
});
