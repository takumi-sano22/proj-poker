// Ruling Engine。Hero の物理的な操作（PhysicalAction）を、Rule Profile の規則（TableConfig.ruling）に従って
// Canonical Action に裁定する（docs/02 §3・§4。FR-LIVE-004）。合法性は getLegalActions だけが決める（D40）ので、
// 裁定の結果は必ず Legal Action のどれかに寄せる。純粋関数で、State も Event も作らない（Event 化は #64）。
// 物理的な誤操作をするのは Hero だけ（D91）。CPU は Canonical Action を直接出す。
import type { EngineResult } from "./hand-engine.js";
import type { Street } from "./hand-events.js";
import type { HandState } from "./hand-state.js";
import {
  getLegalActions,
  type CanonicalAction,
  type LegalActionSet,
} from "./legal-actions.js";
import {
  isChipAmount,
  type RulingRules,
  type TableConfig,
} from "./table-config.js";

/** 口頭の宣言。bet / raise の amount はこの Street の累計（to 額）で、省略すると Chip の量で決める。 */
export type Declaration =
  | { readonly kind: "fold" }
  | { readonly kind: "check" }
  | { readonly kind: "call" }
  | { readonly kind: "all_in" }
  | { readonly kind: "bet" | "raise"; readonly amount?: number };

/**
 * Hero の物理的な操作（docs/02 §4）。1 回の手番の操作を、した順に並べて渡す。
 * chips は 1 回の動作で出した Chip の額面の列（Table Config の chipDenominations にある額面だけ）。
 * Chip の最初の動作が chip_push、2 回目以降が chip_add（String Bet の判定に使う）。
 * Out-of-Turn は操作の種類ではなく、手番でないときの操作を Ruling Engine が判定する。
 * Card の Muck・Show（docs/02 §4 の CardMuckAttempt / ShowCards）は Phase 4 の Ruling（D91 の 3 種）の範囲外で、まだ持たない。
 */
export type PhysicalAction =
  | { readonly type: "declare"; readonly declaration: Declaration }
  | { readonly type: "chip_push"; readonly chips: readonly number[] }
  | { readonly type: "chip_add"; readonly chips: readonly number[] };

/** 裁定の理由（Dealer Feedback の RULING の材料。docs/02 §8）。表示の文言は呼び出し側が持つ。 */
export type RulingCode =
  /** Chip の後の宣言・2 つ目以降の宣言は採らなかった */
  | "declaration_ignored"
  /** 宣言の種類・額を、合法な最も近い Action に寄せた */
  | "declaration_adjusted"
  /** 相手の Bet があるときの Check の宣言は採らなかった（Action を決めない） */
  | "check_facing_bet"
  /** 相手の Bet に対し、宣言なしで Call 額を超える Chip を 1 枚出した → Call */
  | "oversized_chip"
  /** 宣言なしで 2 回目以降に出した Chip は数えず、Hero へ返した */
  | "string_bet"
  /** 宣言なしの複数枚で、全部の Chip が Call に要る → Call */
  | "every_chip_needed"
  /** 宣言なしの上乗せが Full Raise 幅の 50% 以上で足りない → 最小 Raise まで足させた */
  | "half_raise_completed"
  /** 宣言なしの上乗せが Full Raise 幅の 50% 未満 → Call（BB の Option では Check）。超過分は返した */
  | "under_half_raise"
  /** Call 額に満たない Chip → Call（足りない分を足させる） */
  | "under_call"
  /** 最小 Bet に満たない Chip → 最小 Bet まで足させた */
  | "under_min_bet"
  /** Raise できない局面（再開していない・相手が全員 All-in）の Raise → Call */
  | "raise_not_allowed"
  /** 手番でない操作。手番を戻して警告し、操作を保留した */
  | "out_of_turn"
  /** 保留した Out-of-Turn の操作を、状況が変わらなかったので拘束した */
  | "out_of_turn_binding"
  /** 状況が変わったので、保留した Out-of-Turn の操作を撤回した */
  | "out_of_turn_released";

/** Out-of-Turn で保留した操作と、その時点の状況（同じ Street の最高額）。Hero の手番で resolveOutOfTurn に渡す。 */
export interface PendingOutOfTurn {
  readonly playerId: string;
  readonly street: Street;
  readonly currentBet: number;
  readonly actions: readonly PhysicalAction[];
}

/**
 * 裁定の結果。
 * - action: Canonical Action が決まった（そのまま applyAction に渡せば合法）
 * - out_of_turn: 手番でない操作。保留して、Hero の手番で resolveOutOfTurn する
 * - no_action: Action を決めない（相手の Bet があるときの Check の宣言・撤回した Out-of-Turn）。Hero が選び直す
 */
export type RulingResult =
  | {
      readonly kind: "action";
      readonly action: CanonicalAction;
      readonly notes: readonly RulingCode[];
    }
  | {
      readonly kind: "out_of_turn";
      readonly pending: PendingOutOfTurn;
      readonly notes: readonly RulingCode[];
    }
  | { readonly kind: "no_action"; readonly notes: readonly RulingCode[] };

/**
 * Hero の 1 回の手番の物理的な操作を裁定する。
 * 手番なら Canonical Action（または no_action）を返し、手番でなければ Out-of-Turn として保留する（D91）。
 * Fold・All-in 済みの Player、出せない Chip（額面に無い・Stack を超える）は呼び出し側の誤りとして invalid_input にする。
 */
export function rulePhysicalActions(
  state: HandState,
  playerId: string,
  actions: readonly PhysicalAction[],
  config: Pick<TableConfig, "chipDenominations" | "ruling">,
): EngineResult<RulingResult> {
  const checked = checkInput(state, playerId, actions, config);
  if (!checked.ok) return checked;
  const legal = checked.value;
  if (legal.playerId !== playerId) {
    // 手番を正しい Player へ戻す（Engine の手番は変えない）。操作は保留し、状況の比較に使う最高額を残す。
    return ok({
      kind: "out_of_turn",
      pending: {
        playerId,
        street: state.street,
        currentBet: state.currentBet,
        actions: [...actions],
      },
      notes: ["out_of_turn"],
    });
  }
  return ok(ruleInTurn(state, legal, actions));
}

/**
 * 保留した Out-of-Turn の操作を、Hero の手番が来た時点で裁定する（D91・TDA）。
 * 同じ Street で最高額が変わっていなければ（間の Player が Check・Call・Fold だけ）操作を拘束して裁定し、
 * 変わっていれば（Bet・Raise・最高額を上げる All-in、または Street が進んだ）撤回して no_action を返す。
 */
export function resolveOutOfTurn(
  state: HandState,
  pending: PendingOutOfTurn,
  config: Pick<TableConfig, "chipDenominations" | "ruling">,
): EngineResult<RulingResult> {
  const checked = checkInput(state, pending.playerId, pending.actions, config);
  if (!checked.ok) return checked;
  const legal = checked.value;
  if (legal.playerId !== pending.playerId) {
    return {
      ok: false,
      error: {
        kind: "not_actor",
        message: `まだ手番ではない: ${pending.playerId}（手番は ${legal.playerId}）`,
      },
    };
  }
  if (
    state.street !== pending.street ||
    state.currentBet !== pending.currentBet
  ) {
    return ok({ kind: "no_action", notes: ["out_of_turn_released"] });
  }
  const ruled = ruleInTurn(state, legal, pending.actions);
  return ok({ ...ruled, notes: ["out_of_turn_binding", ...ruled.notes] });
}

/** 入力の検証。問題が無ければ現在の Legal Action（Actor は Hero とは限らない）を返す。 */
function checkInput(
  state: HandState,
  playerId: string,
  actions: readonly PhysicalAction[],
  config: Pick<TableConfig, "chipDenominations" | "ruling">,
): EngineResult<LegalActionSet> {
  const legal = getLegalActions(state);
  if (state.status !== "in_progress" || legal === null) {
    return fail("hand_complete", "この Hand は行動を受け付けていない");
  }
  const unsupported = unsupportedRule(config.ruling);
  if (unsupported !== null) return fail("invalid_input", unsupported);
  const player = state.players.find((p) => p.playerId === playerId);
  if (player === undefined)
    return fail("invalid_input", `卓にいない: ${playerId}`);
  if (player.folded || player.allIn) {
    return fail(
      "invalid_input",
      `Fold か All-in 済みで行動できない: ${playerId}`,
    );
  }
  if (actions.length === 0) return fail("invalid_input", "操作が空");

  const values = new Set(config.chipDenominations.map((d) => d.value));
  let motions = 0;
  let pushed = 0;
  for (const a of actions) {
    if (a.type === "declare") {
      const d = a.declaration;
      if ((d.kind === "bet" || d.kind === "raise") && d.amount !== undefined) {
        if (!isChipAmount(d.amount)) {
          return fail("invalid_input", `宣言の額は 0 以上の整数: ${d.amount}`);
        }
      }
      continue;
    }
    // Chip の最初の動作は chip_push、2 回目以降は chip_add（String Bet の判定がこの区別に依る）。
    if ((motions === 0) !== (a.type === "chip_push")) {
      return fail(
        "invalid_input",
        "Chip の最初の動作は chip_push、以降は chip_add",
      );
    }
    if (a.chips.length === 0 || a.chips.some((c) => !values.has(c))) {
      return fail(
        "invalid_input",
        `額面に無い Chip か、Chip が空: ${a.chips.join(",")}`,
      );
    }
    motions += 1;
    pushed += a.chips.reduce((sum, c) => sum + c, 0);
  }
  // 持っていない Chip は出せない（Chip は増えない。INV-TEST-004 の前提）。
  if (pushed > player.stack) {
    return fail(
      "invalid_input",
      `Stack（${player.stack}）を超える Chip: ${pushed}`,
    );
  }
  return ok(legal);
}

/** この Engine が裁定できる規則の値。Rule Profile に新しい値を足すときは、ここと ruleInTurn 以下の分岐を一緒に足す。 */
const SUPPORTED_RULES: RulingRules = {
  oversizedChip: "call_unless_raise_declared",
  stringBet: "first_motion_only",
  multipleChip: "tda_every_chip_and_half_raise",
  declaration: "declaration_first_nearest_legal",
  outOfTurn: "bind_unless_action_changes",
};

function unsupportedRule(rules: RulingRules): string | null {
  for (const key of Object.keys(SUPPORTED_RULES) as (keyof RulingRules)[]) {
    if (rules[key] !== SUPPORTED_RULES[key]) {
      return `未対応の Ruling の規則: ${key}=${String(rules[key])}`;
    }
  }
  return null;
}

/** 手番の Hero の操作を裁定する。宣言と Chip は先にした方が Action を決める（TDA）。 */
function ruleInTurn(
  state: HandState,
  legal: LegalActionSet,
  actions: readonly PhysicalAction[],
): RulingResult {
  const firstChip = actions.findIndex((a) => a.type !== "declare");
  const declarations = actions.flatMap((a, i) =>
    a.type === "declare" && (firstChip < 0 || i < firstChip)
      ? [a.declaration]
      : [],
  );
  const motions = actions.flatMap((a) =>
    a.type === "declare" ? [] : [a.chips],
  );
  const ignored =
    actions.filter((a) => a.type === "declare").length >
    Math.min(declarations.length, 1);
  const notes: RulingCode[] = ignored ? ["declaration_ignored"] : [];
  const [declared] = declarations;
  const result =
    declared !== undefined
      ? ruleDeclared(state, legal, declared, motions)
      : ruleChips(state, legal, motions);
  return { ...result, notes: [...notes, ...result.notes] };
}

/** 宣言で裁定する。宣言は拘束し、額は合法な最も近い Action に寄せる（declaration_first_nearest_legal）。 */
function ruleDeclared(
  state: HandState,
  legal: LegalActionSet,
  d: Declaration,
  motions: readonly (readonly number[])[],
): RulingResult {
  switch (d.kind) {
    case "fold":
      return action({ type: "fold" });
    case "check":
      return legal.toCall === 0
        ? action({ type: "check" })
        : { kind: "no_action", notes: ["check_facing_bet"] };
    case "call":
      return legal.toCall === 0
        ? action({ type: "check" }, ["declaration_adjusted"])
        : action({ type: "call" });
    case "all_in":
      return legal.actions.some((a) => a.type === "all_in")
        ? action({ type: "all_in" })
        : action(callOrCheck(legal), ["raise_not_allowed"]);
    case "bet":
    case "raise": {
      const committed = committedOf(state, legal.playerId);
      let to: number;
      const notes: RulingCode[] = [];
      if (d.amount !== undefined) {
        to = d.amount;
      } else {
        // 額なしの宣言: 最初の 1 回の Chip、それがちょうど Call 額なら続く 1 回まで（TDA の Raise の方法）。
        const [first = [], second = []] = motions;
        const firstAmount = sum(first);
        const counted =
          legal.toCall > 0 && firstAmount === legal.toCall
            ? firstAmount + sum(second)
            : firstAmount;
        const countedMotions = counted === firstAmount ? 1 : 2;
        if (motions.length > countedMotions) notes.push("string_bet");
        to = committed + counted;
      }
      const fitted = fitTo(state, legal, to);
      const kindChanged =
        fitted.action.type !== d.kind && fitted.action.type !== "all_in";
      if ((!fitted.exact || kindChanged) && fitted.notes.length === 0) {
        notes.push("declaration_adjusted");
      }
      return action(fitted.action, [...notes, ...fitted.notes]);
    }
  }
}

/** 宣言なしの Chip で裁定する（Oversized Chip・String Bet・Multiple Chip の規則）。 */
function ruleChips(
  state: HandState,
  legal: LegalActionSet,
  motions: readonly (readonly number[])[],
): RulingResult {
  const [first = []] = motions;
  // String Bet: 2 回目以降の Chip は数えない（first_motion_only。D91）。
  const notes: RulingCode[] = motions.length > 1 ? ["string_bet"] : [];
  const with_ = (r: RulingResult): RulingResult => ({
    ...r,
    notes: [...notes, ...r.notes],
  });
  const amount = sum(first);
  const committed = committedOf(state, legal.playerId);
  const stack = stackOf(state, legal.playerId);
  const facing = legal.toCall > 0;

  // Oversized Chip: 相手の Bet に対し、Call 額を超える Chip 1 枚は Call（call_unless_raise_declared。D91）。
  if (facing && first.length === 1 && amount > legal.toCall) {
    return with_(action({ type: "call" }, ["oversized_chip"]));
  }
  // Stack の全部を出したら All-in（Raise できない局面なら Call）。
  if (amount >= stack) {
    return with_(
      legal.actions.some((a) => a.type === "all_in")
        ? action({ type: "all_in" })
        : action(callOrCheck(legal), ["raise_not_allowed"]),
    );
  }
  if (amount <= legal.toCall) {
    return with_(
      action({ type: "call" }, amount < legal.toCall ? ["under_call"] : []),
    );
  }
  // Multiple Chip: どの 1 枚を除いても Call 額に足りなくなるなら、全部の Chip が Call に要る → Call。
  if (facing && amount - Math.min(...first) < legal.toCall) {
    return with_(action({ type: "call" }, ["every_chip_needed"]));
  }
  const to = committed + amount;
  // 誰も Bet していない: 出した額の Bet（相手の Bet が無い Oversized Chip もここ）。最小額に満たなければ最小 Bet。
  if (state.currentBet === 0) {
    const fitted = fitTo(state, legal, to);
    return with_(
      action(fitted.action, fitted.exact ? fitted.notes : ["under_min_bet"]),
    );
  }
  // 50% 規則: 上乗せが直近の Full Raise 幅以上なら出した額の Raise、50% 以上なら最小 Raise、50% 未満なら Call。
  const increment = to - state.currentBet;
  if (increment >= state.lastRaiseSize) {
    const fitted = fitTo(state, legal, to);
    return with_(action(fitted.action, fitted.notes));
  }
  if (increment * 2 >= state.lastRaiseSize) {
    const fitted = fitTo(state, legal, state.currentBet + state.lastRaiseSize);
    return with_(
      action(fitted.action, ["half_raise_completed", ...fitted.notes]),
    );
  }
  return with_(action(callOrCheck(legal), ["under_half_raise"]));
}

/**
 * to 額の Bet / Raise を Legal Action に寄せる。exact は寄せずにそのまま採れたか。
 * 最小額未満 → 最小額、Stack 以上 → All-in。Bet / Raise の選択肢が無いときは、Stack が最小額に届かないだけなら All-in、
 * Raise できない局面（再開していない・相手が全員 All-in）なら Call（Call 額 0 なら Check）。
 */
function fitTo(
  state: HandState,
  legal: LegalActionSet,
  to: number,
): { action: CanonicalAction; exact: boolean; notes: RulingCode[] } {
  const option = legal.actions.find(
    (a) => a.type === "bet" || a.type === "raise",
  );
  const allIn = legal.actions.find((a) => a.type === "all_in");
  if (
    option !== undefined &&
    (option.type === "bet" || option.type === "raise")
  ) {
    if (to >= option.max) {
      return {
        action: { type: "all_in" },
        exact: to === option.max,
        notes: [],
      };
    }
    const amount = Math.max(to, option.min);
    return {
      action: { type: option.type, amount },
      exact: amount === to,
      notes: [],
    };
  }
  if (
    allIn !== undefined &&
    allIn.type === "all_in" &&
    allIn.amount > state.currentBet
  ) {
    return {
      action: { type: "all_in" },
      exact: to === allIn.amount,
      notes: [],
    };
  }
  return {
    action: callOrCheck(legal),
    exact: false,
    notes: ["raise_not_allowed"],
  };
}

function callOrCheck(legal: LegalActionSet): CanonicalAction {
  return legal.toCall > 0 ? { type: "call" } : { type: "check" };
}

function action(
  a: CanonicalAction,
  notes: readonly RulingCode[] = [],
): RulingResult {
  return { kind: "action", action: a, notes };
}

function committedOf(state: HandState, playerId: string): number {
  return (
    state.players.find((p) => p.playerId === playerId)?.streetCommitted ?? 0
  );
}

function stackOf(state: HandState, playerId: string): number {
  return state.players.find((p) => p.playerId === playerId)?.stack ?? 0;
}

function sum(chips: readonly number[]): number {
  return chips.reduce((total, c) => total + c, 0);
}

function ok<T>(value: T): EngineResult<T> {
  return { ok: true, value };
}

function fail(
  kind: "hand_complete" | "invalid_input",
  message: string,
): { ok: false; error: { kind: typeof kind; message: string } } {
  return { ok: false, error: { kind, message } };
}
