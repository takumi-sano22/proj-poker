// App Shell（#218・D136・D144）の静的な描画。DOM 環境を足さず、react-dom/server の文字列で見る。
// - Home の Session の欄: 照会の結果ごとに出す開始の Button が決まる（「続きから遊ぶ」と「新しい Session を始める」を同時に出さない。
//   読めない・知らない state ではどちらも出さない）
// - Learn の一覧: 今ある機能の入口だけ。開けない入口は Button の代わりに理由を出す
// - ナビゲーション: 今の領域を aria-current で示す
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CurrentSessionLoad } from "../hooks/useCurrentSession.js";
import { HomeSessionPanel, LearnHub, ShellNav } from "./AppShell.js";

const noop = () => undefined;

function home(load: CurrentSessionLoad, pending = false): string {
  return renderToStaticMarkup(
    <HomeSessionPanel
      load={load}
      onReload={noop}
      pending={pending}
      choice={{ mode: "cash" }}
      onChoiceChange={noop}
      onContinue={noop}
      onStartNew={noop}
    />,
  );
}

describe("Home の Session の欄（#218・D144）", () => {
  it("読み込み中は開始の Button を出さない", () => {
    const html = home({ state: "loading" });
    expect(html).toContain("Session の状態を確かめています");
    expect(html).not.toContain("続きから遊ぶ");
    expect(html).not.toContain("新しい Session を始める");
  });

  it("Hand の途中・Hand の合間は「続きから遊ぶ」だけを出す（新しい Session の開始は出さない）", () => {
    const inHand = home({
      state: "ready",
      lookup: {
        kind: "known",
        session: { state: "in_hand", kind: { mode: "cash" } },
      },
    });
    expect(inHand).toContain("Cash Game");
    expect(inHand).toContain("Hand の途中です");
    expect(inHand).toContain("続きから遊ぶ");
    expect(inHand).not.toContain("新しい Session を始める");
    expect(inHand).not.toContain("新しい Session の種類");

    const between = home({
      state: "ready",
      lookup: {
        kind: "known",
        session: {
          state: "ready_for_next_hand",
          kind: { mode: "tournament", presetId: "stt6_hand_count" },
        },
      },
    });
    expect(between).toContain("Tournament");
    expect(between).toContain("Hand の合間");
    expect(between).toContain("続きから遊ぶ");
    expect(between).not.toContain("新しい Session を始める");
  });

  it("Session が無い・終わったときは、種類の選択と「新しい Session を始める」を出す（「続きから遊ぶ」は出さない）", () => {
    for (const load of [
      { state: "ready", lookup: { kind: "none" } },
      {
        state: "ready",
        lookup: {
          kind: "known",
          session: { state: "ended", kind: { mode: "cash" } },
        },
      },
    ] satisfies CurrentSessionLoad[]) {
      const html = home(load);
      expect(html).toContain("新しい Session を始める");
      expect(html).toContain("新しい Session の種類");
      expect(html).not.toContain("続きから遊ぶ");
    }
    expect(home({ state: "ready", lookup: { kind: "none" } })).toContain(
      "続けられる Session はありません",
    );
  });

  it("読めない・知らない state は、どちらの開始の Button も出さず読み直しだけを出す", () => {
    for (const load of [
      { state: "failed" },
      { state: "ready", lookup: { kind: "unknown" } },
    ] satisfies CurrentSessionLoad[]) {
      const html = home(load);
      expect(html).toContain("もう一度読み込む");
      expect(html).not.toContain("続きから遊ぶ");
      expect(html).not.toContain("新しい Session を始める");
    }
  });

  it("開始の要求を送っている間は開始の Button を押せない", () => {
    const html = home(
      {
        state: "ready",
        lookup: {
          kind: "known",
          session: { state: "in_hand", kind: { mode: "cash" } },
        },
      },
      true,
    );
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>続きから遊ぶ/);
  });
});

describe("Learn の一覧（#218）", () => {
  it("今ある機能の入口だけを出し、開けない入口は理由を出す（Drill は始めた後だけ）", () => {
    const html = renderToStaticMarkup(
      <LearnHub
        onOpenReplay={noop}
        onOpenLastHandReview={null}
        onOpenSessionReview={null}
        onOpenDrill={null}
      />,
    );
    expect(html).toContain("Replay を開く");
    expect(html).not.toContain("直前の Hand の Review を開く");
    expect(html).not.toContain("Session Review を開く");
    expect(html).toContain("直前に終わった Hand があると");
    expect(html).not.toContain("Drill の卓を開く");

    const all = renderToStaticMarkup(
      <LearnHub
        onOpenReplay={noop}
        onOpenLastHandReview={noop}
        onOpenSessionReview={noop}
        onOpenDrill={noop}
      />,
    );
    expect(all).toContain("直前の Hand の Review を開く");
    expect(all).toContain("Session Review を開く");
    expect(all).toContain("Drill の卓を開く");
  });
});

describe("ナビゲーション（#218）", () => {
  it("Home / Play / Learn を並べ、今の領域だけ aria-current を付ける", () => {
    const html = renderToStaticMarkup(<ShellNav area="play" onSelect={noop} />);
    expect(html).toContain('aria-label="画面の切り替え"');
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html).toMatch(/aria-current="page"[^>]*>Play</);
  });
});
