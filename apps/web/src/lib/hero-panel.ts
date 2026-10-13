// 狭い画面の Hero の操作パネルの開閉（UX-05 #220・D137・docs/06 §16.3）。開閉は表示だけの状態で、下書き（TurnDraft）・送信・Ack には
// 関わらない（下書きは useHandSession が画面の切り替えより上で持つ。D146）。ここは「いつ自動で開くか」の規則だけを持つ。
import type { HeroView } from "@proj-poker/engine";
import { heroSeatOf, operationKey } from "./view-model.js";

/** パネルの開閉の状態。turnKey は最後に見た Hero の手番（手番でなければ null）。 */
export interface HeroPanelState {
  readonly expanded: boolean;
  readonly turnKey: string | null;
}

/**
 * Hero の手番の識別子（手番でなければ null）。同じ手番の間は変わらず、Hero の操作が受理される（Hero への裁定が 1 つ増える。D146）・
 * Street / Hand が変わると変わるので、operationKey を使う。手番かは Hero が見ている displayed の legalActions で読む。
 */
export function heroTurnKey(view: HeroView): string | null {
  return view.status !== "complete" && view.legalActions !== null
    ? operationKey(view)
    : null;
}

/**
 * Hero の欄に Chip と宣言の操作の欄（ChipControls）を出す状態か。App.tsx の DockBody が操作の欄を出す条件と同じ（Hand の途中・Session が
 * 続いている・CPU の障害のダイアログが無い・Hero が席にいて Fold / All-in していない）。狭い画面の折りたたみはこの間だけ出し、障害の
 * ダイアログ・Hand の結果・Session の終わりの案内は折りたたまない（障害を先に出す順番を変えない）。
 */
export function panelOperable(
  view: HeroView,
  sessionEnded: boolean,
  outagePending: boolean,
): boolean {
  const hero = heroSeatOf(view);
  return (
    view.status !== "complete" &&
    !sessionEnded &&
    !outagePending &&
    hero !== undefined &&
    !hero.folded &&
    !hero.allIn
  );
}

/** 最初の状態: 手番なら開き、手番でなければ閉じる（卓を広く見せる）。 */
export function initialHeroPanel(turnKey: string | null): HeroPanelState {
  return { expanded: turnKey !== null, turnKey };
}

/**
 * 表示中の手番が変わったときの次の状態。新しい手番が来たときだけ自動で開く（D137 Q7）。同じ手番の再描画では変えないので、
 * Hero が手動で閉じたパネルが勝手に開き直さない。手番が終わっても自動では閉じない（送った操作の結果を待つ間に畳まない）。
 */
export function nextHeroPanel(
  state: HeroPanelState,
  turnKey: string | null,
): HeroPanelState {
  if (turnKey === state.turnKey) return state;
  return { expanded: turnKey !== null ? true : state.expanded, turnKey };
}
