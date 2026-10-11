// App Shell（Home / Play / Learn。D136・#218）の画面の状態と移り方。純粋関数だけで、Hand・Session の開始や API の呼び出しはしない
// （画面の移動だけで Hand・Session を作らない・CPU を進めない。開始は Home・Play の Button を Hero が押したときだけ）。
// - Play は通常の卓だけ。Drill の卓（#117）は Learn の中の画面で、通常の Session と混ぜない
// - Learn の画面（Replay・Hand Review・Session Review・Drill）は、Learn に入る前の領域（戻り先）を持つ
// - Learn を離れるときは見ていた画面（閲覧中の Hand・判断・step）を覚え、Learn に戻ったらそこから見せる（Q23）
import type { ReplayStart } from "../hooks/useReplay.js";

export type Area = "home" | "play" | "learn";

/** Learn の画面の「戻る」の行き先（Learn に入る前の領域。Learn の一覧から開いたら一覧）。 */
export type LearnReturn = Area;

/** 見ている画面。Replay は開く Hand と step を、Review は Hand と最初に開く判断を、Session Review は Session の Hand（どれか 1 つ）を持つ。 */
export type Screen =
  | { readonly kind: "home" }
  | { readonly kind: "play" }
  | { readonly kind: "learn" }
  | {
      readonly kind: "replay";
      readonly start: ReplayStart | null;
      readonly back: LearnReturn;
    }
  | {
      readonly kind: "review";
      readonly handId: string;
      readonly decisionIndex: number | null;
      readonly back: LearnReturn;
    }
  | {
      readonly kind: "session_review";
      readonly handId: string;
      readonly back: LearnReturn;
    }
  | { readonly kind: "drill"; readonly back: LearnReturn };

/** Learn の中の個別の画面（一覧以外）。 */
export type LearnScreen = Extract<
  Screen,
  { readonly kind: "replay" | "review" | "session_review" | "drill" }
>;

/** 戻り先を除いた Learn の画面の指定（開く側は戻り先を知らない。openLearn が決める）。 */
export type LearnTarget = LearnScreen extends infer S
  ? S extends LearnScreen
    ? Omit<S, "back">
    : never
  : never;

/** 閲覧位置（Review で開いている判断・Replay で見ている Hand と step）。画面が知らせ、Learn を離れるときに覚える。 */
export type LearnPosition =
  | { readonly kind: "review"; readonly decisionIndex: number | null }
  | { readonly kind: "replay"; readonly start: ReplayStart | null };

export interface ShellState {
  /** 開いた画面（開いたときの指定。閲覧位置で書き換えないので、画面を作り直さない）。 */
  readonly screen: Screen;
  /** 見ている Learn の画面の今の閲覧位置（screen に閲覧位置を重ねたもの。まだ知らせが無ければ null）。 */
  readonly viewing: LearnScreen | null;
  /** Learn を離れたときに見ていた Learn の画面（無ければ null で、Learn に戻ると一覧）。 */
  readonly lastLearn: LearnScreen | null;
}

/** 起動時は必ず Home（D136）。 */
export const INITIAL_SHELL: ShellState = {
  screen: { kind: "home" },
  viewing: null,
  lastLearn: null,
};

export type ShellAction =
  /** 上部のナビゲーションで領域を選ぶ。 */
  | { readonly type: "area"; readonly area: Area }
  /** Learn の画面を開く（卓の Review の Button・Learn の一覧・Learn の画面どうしの移動）。 */
  | { readonly type: "open"; readonly target: LearnTarget }
  /** Learn の画面の「戻る」。 */
  | { readonly type: "back" }
  /** 見ている Learn の画面が閲覧位置を知らせる。 */
  | { readonly type: "position"; readonly position: LearnPosition };

export function areaOf(screen: Screen): Area {
  switch (screen.kind) {
    case "home":
      return "home";
    case "play":
      return "play";
    default:
      return "learn";
  }
}

function isLearnScreen(screen: Screen): screen is LearnScreen {
  return areaOf(screen) === "learn" && screen.kind !== "learn";
}

function moveTo(screen: Screen, lastLearn: LearnScreen | null): ShellState {
  return { screen, viewing: null, lastLearn };
}

/**
 * 画面の移り方。どの移り方も API を呼ばない（Hand・Session の開始は呼び出し側が Hero の Button でだけ行う）。
 * - area（Home / Play）: その領域へ。Learn を離れるなら見ていた画面（閲覧位置ごと）を覚える
 * - area（Learn。ほかの領域から）: 覚えていた画面（無ければ一覧）/（Learn の中で押し直す）: 一覧
 * - open: 戻り先は、Learn の外から開けばその領域、一覧から開けば一覧、Learn の画面どうしなら元の画面の戻り先
 * - back: 戻り先の領域へ（Learn の外へ出るなら見ていた画面を覚える）
 */
export function shellReducer(
  state: ShellState,
  action: ShellAction,
): ShellState {
  const current = state.screen;
  // 見ていた Learn の画面（閲覧位置を重ねたもの）。
  const seen: LearnScreen | null = isLearnScreen(current)
    ? (state.viewing ?? current)
    : null;
  switch (action.type) {
    case "area": {
      if (action.area === "learn") {
        return areaOf(current) === "learn"
          ? moveTo({ kind: "learn" }, null)
          : moveTo(state.lastLearn ?? { kind: "learn" }, null);
      }
      // Learn の一覧から離れるなら、前に覚えていた画面は捨てる（次に Learn へ戻ると一覧）。
      const lastLearn =
        seen ?? (current.kind === "learn" ? null : state.lastLearn);
      return moveTo({ kind: action.area }, lastLearn);
    }
    case "open": {
      const back: LearnReturn = seen?.back ?? areaOf(current);
      return moveTo({ ...action.target, back }, null);
    }
    case "back": {
      if (seen === null) return state;
      return seen.back === "learn"
        ? moveTo({ kind: "learn" }, null)
        : moveTo({ kind: seen.back }, seen);
    }
    case "position": {
      if (seen === null) return state;
      const next = withPosition(seen, action.position);
      return next === seen ? state : { ...state, viewing: next };
    }
  }
}

/** 閲覧位置を Learn の画面に重ねる（種類が違えばそのまま）。 */
function withPosition(
  screen: LearnScreen,
  position: LearnPosition,
): LearnScreen {
  if (screen.kind === "review" && position.kind === "review") {
    return screen.decisionIndex === position.decisionIndex
      ? screen
      : { ...screen, decisionIndex: position.decisionIndex };
  }
  if (screen.kind === "replay" && position.kind === "replay") {
    const a = screen.start;
    const b = position.start;
    const same =
      a === b ||
      (a !== null && b !== null && a.handId === b.handId && a.step === b.step);
    return same ? screen : { ...screen, start: position.start };
  }
  return screen;
}

/** 「戻る」の Button の文言。 */
export function backLabel(back: LearnReturn): string {
  switch (back) {
    case "play":
      return "卓に戻る";
    case "home":
      return "Home に戻る";
    case "learn":
      return "Learn の一覧へ";
  }
}
