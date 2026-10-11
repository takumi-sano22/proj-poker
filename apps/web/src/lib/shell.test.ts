import { describe, expect, it } from "vitest";
import {
  INITIAL_SHELL,
  areaOf,
  backLabel,
  shellReducer,
  type ShellAction,
  type ShellState,
} from "./shell.js";

/** 移り方を順に当てる。 */
function run(...actions: readonly ShellAction[]): ShellState {
  return actions.reduce(shellReducer, INITIAL_SHELL);
}

describe("App Shell の画面の移り方（#218・D136）", () => {
  it("起動時は Home", () => {
    expect(INITIAL_SHELL.screen).toEqual({ kind: "home" });
    expect(areaOf(INITIAL_SHELL.screen)).toBe("home");
  });

  it("卓から開いた Review は「卓に戻る」で Play へ戻り、Learn へ戻ると同じ Hand の Review を見せる", () => {
    const opened = run(
      { type: "area", area: "play" },
      {
        type: "open",
        target: { kind: "review", handId: "h1", decisionIndex: null },
      },
    );
    expect(opened.screen).toEqual({
      kind: "review",
      handId: "h1",
      decisionIndex: null,
      back: "play",
    });
    expect(backLabel("play")).toBe("卓に戻る");

    const back = shellReducer(opened, { type: "back" });
    expect(back.screen).toEqual({ kind: "play" });
    const again = shellReducer(back, { type: "area", area: "learn" });
    expect(again.screen).toEqual(opened.screen);
  });

  it("閲覧位置（開いた判断・Replay の step）は画面の指定を書き換えず、Learn を離れたときに覚える", () => {
    const opened = run(
      { type: "area", area: "play" },
      {
        type: "open",
        target: { kind: "review", handId: "h1", decisionIndex: null },
      },
    );
    const moved = shellReducer(opened, {
      type: "position",
      position: { kind: "review", decisionIndex: 2 },
    });
    // 開いている画面の指定は変えない（作り直さない）。
    expect(moved.screen).toBe(opened.screen);
    const home = shellReducer(moved, { type: "area", area: "home" });
    expect(home.screen).toEqual({ kind: "home" });
    const learn = shellReducer(home, { type: "area", area: "learn" });
    expect(learn.screen).toEqual({
      kind: "review",
      handId: "h1",
      decisionIndex: 2,
      back: "play",
    });

    const replay = run(
      { type: "area", area: "learn" },
      { type: "open", target: { kind: "replay", start: null } },
      {
        type: "position",
        position: { kind: "replay", start: { handId: "h2", step: 5 } },
      },
      { type: "area", area: "play" },
      { type: "area", area: "learn" },
    );
    expect(replay.screen).toEqual({
      kind: "replay",
      start: { handId: "h2", step: 5 },
      back: "learn",
    });
  });

  it("Learn の画面どうしの移動は最初の戻り先を引き継ぐ（Review → Replay → Review でも「卓に戻る」）", () => {
    const state = run(
      { type: "area", area: "play" },
      {
        type: "open",
        target: { kind: "review", handId: "h1", decisionIndex: 0 },
      },
      {
        type: "open",
        target: { kind: "replay", start: { handId: "h1", step: 3 } },
      },
      {
        type: "open",
        target: { kind: "review", handId: "h1", decisionIndex: 1 },
      },
    );
    expect(state.screen).toMatchObject({ kind: "review", back: "play" });
  });

  it("Learn の一覧から開いた画面の「戻る」は一覧へ。Learn の中でナビの Learn を押し直すと一覧", () => {
    const opened = run(
      { type: "area", area: "learn" },
      { type: "open", target: { kind: "replay", start: null } },
    );
    expect(opened.screen).toMatchObject({ kind: "replay", back: "learn" });
    expect(shellReducer(opened, { type: "back" }).screen).toEqual({
      kind: "learn",
    });
    expect(
      shellReducer(opened, { type: "area", area: "learn" }).screen,
    ).toEqual({ kind: "learn" });
  });

  it("Home から入った Learn の一覧を離れると、次に Learn へ戻ったときも一覧", () => {
    const state = run(
      { type: "area", area: "learn" },
      { type: "area", area: "home" },
      { type: "area", area: "learn" },
    );
    expect(state.screen).toEqual({ kind: "learn" });
  });

  it("Drill の卓は Learn の画面で、Play（通常の卓）と分ける", () => {
    const state = run(
      { type: "area", area: "play" },
      {
        type: "open",
        target: { kind: "session_review", handId: "h9" },
      },
      { type: "open", target: { kind: "drill" } },
    );
    expect(state.screen).toEqual({ kind: "drill", back: "play" });
    expect(areaOf(state.screen)).toBe("learn");
    // Play を押しても Drill を捨てず、Learn に戻ると Drill の卓へ。
    const play = shellReducer(state, { type: "area", area: "play" });
    expect(play.screen).toEqual({ kind: "play" });
    expect(shellReducer(play, { type: "area", area: "learn" }).screen).toEqual({
      kind: "drill",
      back: "play",
    });
  });

  it("Learn の外での「戻る」・閲覧位置の知らせは何もしない", () => {
    const home = run({ type: "area", area: "home" });
    expect(shellReducer(home, { type: "back" })).toBe(home);
    expect(
      shellReducer(home, {
        type: "position",
        position: { kind: "review", decisionIndex: 1 },
      }),
    ).toBe(home);
  });
});
