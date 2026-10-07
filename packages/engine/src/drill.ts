// Targeted Drill の Spot（docs/07 §7・D105・D110・D116）。過去の Hand の Hero の判断 1 つから、一要素だけ変えた類題の Hand を決定論で作る。
// - 入力は判断時点の Hero Information Set（heroInformationSets。判断時点までに Hero に見えた Event）だけ。他者の Hidden Cards・
//   判断より後の Board・Learning-only Reveal は入力の経路に無いので、Drill の Hero 向けの情報に混ざらない（Hero が見ていない札を見せない）
// - Hero の札と、判断時点までに公開された Board は元の Hand のまま。Deck の残り（相手の札・この後の Board）は seed で配り直す
// - 判断の直前までの Action は、元の Hand の公開の Action（ACTION_TAKEN）を Script として再現する（変形が額・Stack を変えたら変えた値で）
// - 作った Spot は Engine で判断の時点まで進めて検証する（合法な State・Action・Chip の保存・Hero の手番に戻ること）。通らない Spot は出さない
// LLM で Spot を作る経路は持たない（D110）。乱数は seed からだけ作る（同じ元の判断・同じ変形・同じ seed なら同じ Drill）。
import { cardToString, createDeck, type Card } from "./card.js";
import {
  applyAction,
  recordSessionEvent,
  startHand,
  type EngineResult,
  type HandMetadataInput,
  type HandProgress,
} from "./hand-engine.js";
import type { HandEvent, SeatInit, Street } from "./hand-events.js";
import { foldHandEvents } from "./hand-state.js";
import type { HeroInformationSet } from "./hand-summary.js";
import { heroDecisions } from "./hand-summary.js";
import { getLegalActions, type PlayerAction } from "./legal-actions.js";
import { createRng, shuffle } from "./rng.js";
import type { TableConfig } from "./table-config.js";

/**
 * Spot の変形（一要素だけ変える）。相手の傾向（Opponent Tendency）の変形は Spot を変えず、判断の後の相手の Action を決める
 * RuleBot の Persona で表す（サーバーの範囲）ので、Spot の上では unchanged になる。
 * - effective_stack: 開始時の全員の Stack を factor 倍にする（Blind は変えない。有効 Stack と SPR が変わる）
 * - bet_size: 判断の Street で Hero が直面した Bet（その Street の最初の Bet）の額を、Bet の直前の Pot の potFraction 倍にする
 * - unchanged: 元の Spot のまま
 */
export type DrillSpotChange =
  | { readonly kind: "effective_stack"; readonly factor: number }
  | { readonly kind: "bet_size"; readonly potFraction: number }
  | { readonly kind: "unchanged" };

/** Script の 1 手（元の Hand の公開の Action を Canonical Action にしたもの）。 */
export interface DrillScriptAction {
  readonly playerId: string;
  readonly action: PlayerAction;
}

/** 変形で実際に変わった値（Hero に見せてよい、公開の事実だけ）。 */
export type DrillSpotDelta =
  | {
      readonly kind: "effective_stack";
      readonly factor: number;
      /** 開始時の Hero の Stack（元 → Drill）。 */
      readonly heroStackFrom: number;
      readonly heroStackTo: number;
    }
  | {
      readonly kind: "bet_size";
      readonly potFraction: number;
      readonly bettorId: string;
      /** Bet の額（その Street の累計の to 額。元 → Drill）。 */
      readonly betFrom: number;
      readonly betTo: number;
    }
  | { readonly kind: "unchanged" };

/** Drill の Hand の開始と、判断の直前までの Script。 */
export interface DrillSpot {
  readonly heroId: string;
  /** 席順（時計回り）と開始時の Stack。 */
  readonly seats: readonly SeatInit[];
  readonly buttonPlayerId: string;
  readonly smallBlind: number;
  readonly bigBlind: number;
  readonly ruleProfile: string;
  /** 配布順の 52 枚。Hero の札と判断時点の Board は元の Hand のまま、それ以外は seed で配り直した並び。 */
  readonly deck: readonly Card[];
  readonly script: readonly DrillScriptAction[];
  /** Drill の Hand で練習する Hero の判断の番号（Script の Hero の Action の数＝元の判断の番号と同じ）。 */
  readonly decisionIndex: number;
  /** 練習する判断の Street（元の判断と同じ）。 */
  readonly street: Street;
  readonly delta: DrillSpotDelta;
}

function invalid(message: string): {
  ok: false;
  error: { kind: "invalid_input"; message: string };
} {
  return { ok: false, error: { kind: "invalid_input", message } };
}

/** ACTION_TAKEN を Canonical Action に戻す（bet / raise は to 額。それ以外は種類だけで、額は Engine が State から決める）。 */
function toPlayerAction(
  e: Extract<HandEvent, { type: "ACTION_TAKEN" }>,
): PlayerAction {
  return e.action === "bet" || e.action === "raise"
    ? { type: e.action, amount: e.toAmount }
    : { type: e.action };
}

/**
 * 判断時点の Hero Information Set から、変形を 1 つ当てた Drill の Spot を作る（検証は startDrillHand）。
 * 変形が当てはまらない（Bet に直面していない判断の bet_size・額が変わらない等）ときは invalid_input。
 */
export function buildDrillSpot(
  set: HeroInformationSet,
  change: DrillSpotChange,
  seed: number,
): EngineResult<DrillSpot> {
  const started = set.events[0];
  if (started?.type !== "HAND_STARTED") {
    return invalid("判断時点の Event の先頭が HAND_STARTED ではない");
  }
  const heroId = set.heroId;
  const hole = set.knowledge.holeCards;
  if (hole === null || hole.length !== 2) {
    return invalid("Hero の札が配られる前の判断は Drill にできない");
  }
  const n = started.seats.length;
  const heroIndex = started.seats.findIndex((s) => s.playerId === heroId);
  const buttonIndex = started.seats.findIndex(
    (s) => s.playerId === started.buttonPlayerId,
  );
  if (heroIndex < 0 || buttonIndex < 0) {
    return invalid("Hero か Button の席が見つからない");
  }

  // 判断の直前までの公開の Action（Hero 自身の Action を含む）。判断時点（decisionPointSeq）までの Event だけを見る。
  const actions = set.events.filter(
    (e): e is Extract<HandEvent, { type: "ACTION_TAKEN" }> =>
      e.type === "ACTION_TAKEN",
  );
  let script: DrillScriptAction[] = actions.map((e) => ({
    playerId: e.playerId,
    action: toPlayerAction(e),
  }));
  let seats: SeatInit[] = started.seats.map((s) => ({
    playerId: s.playerId,
    stack: s.stack,
  }));
  let delta: DrillSpotDelta = { kind: "unchanged" };

  switch (change.kind) {
    case "unchanged":
      break;
    case "effective_stack": {
      if (!(change.factor > 0) || change.factor === 1) {
        return invalid(`Stack の倍率は 1 以外の正の数: ${change.factor}`);
      }
      // Chip は整数（D74）。丸めて 1 未満にはしない（Stack は正の整数。Engine が検証する）。
      seats = seats.map((s) => ({
        playerId: s.playerId,
        stack: Math.max(1, Math.round(s.stack * change.factor)),
      }));
      delta = {
        kind: "effective_stack",
        factor: change.factor,
        heroStackFrom: started.seats[heroIndex]?.stack ?? 0,
        heroStackTo: seats[heroIndex]?.stack ?? 0,
      };
      break;
    }
    case "bet_size": {
      // 判断の Street の Aggressive な Action のうち最後のものが、相手の最初の Bet（Raise・額を上げる All-in の無い Street）のときだけ当てる。
      const onStreet = actions.filter((e) => e.street === set.decision.street);
      const aggressive = onStreet.filter(
        (e) =>
          e.action === "bet" || e.action === "raise" || e.action === "all_in",
      );
      const bet = aggressive.at(-1);
      if (
        bet === undefined ||
        aggressive.length !== 1 ||
        bet.action !== "bet" ||
        bet.playerId === heroId
      ) {
        return invalid("Hero が相手の最初の Bet に直面した判断ではない");
      }
      if (!(change.potFraction > 0)) {
        return invalid(`Pot に対する割合は正の数: ${change.potFraction}`);
      }
      // Bet の直前の Pot（公開の値。判断時点の Event の prefix から Engine の Reducer で作る）。
      const before = foldHandEvents(set.events.filter((e) => e.seq < bet.seq));
      const to = Math.max(
        started.bigBlind,
        Math.round(before.pot * change.potFraction),
      );
      if (to === bet.toAmount) {
        return invalid("変形した Bet の額が元の額と同じ");
      }
      const at = actions.indexOf(bet);
      script = script.map((s, i) =>
        i === at
          ? { playerId: s.playerId, action: { type: "bet", amount: to } }
          : s,
      );
      delta = {
        kind: "bet_size",
        potFraction: change.potFraction,
        bettorId: bet.playerId,
        betFrom: bet.toAmount,
        betTo: to,
      };
      break;
    }
  }

  // Deck: Hero の札（配布順の位置）と、判断時点までの Board は元のまま置き、残りの位置は残りの札を seed でシャッフルして埋める。
  // 配布は Button の左から 1 枚ずつ 2 周（k 番目の Player は deck[k] と deck[n + k]）、Board は 2n から（hand-engine.ts）。
  const fixed = new Map<number, Card>();
  const heroOrder = (heroIndex - buttonIndex - 1 + n) % n;
  fixed.set(heroOrder, hole[0] as Card);
  fixed.set(n + heroOrder, hole[1] as Card);
  set.knowledge.board.forEach((card, i) => fixed.set(2 * n + i, card));
  const used = new Set([...fixed.values()].map(cardToString));
  const rest = shuffle(
    createDeck().filter((c) => !used.has(cardToString(c))),
    createRng(seed),
  );
  const deck: Card[] = [];
  let next = 0;
  for (let i = 0; i < 52; i++) {
    const card = fixed.get(i) ?? rest[next++];
    if (card === undefined) return invalid("Deck を組めない");
    deck.push(card);
  }

  return {
    ok: true,
    value: {
      heroId,
      seats,
      buttonPlayerId: started.buttonPlayerId,
      smallBlind: started.smallBlind,
      bigBlind: started.bigBlind,
      ruleProfile: started.ruleProfile,
      deck,
      script,
      decisionIndex: set.decision.index,
      street: set.decision.street,
      delta,
    },
  };
}

export interface StartDrillHandInput {
  readonly handId: string;
  /** Drill の専用の Session（SESSION_STARTED に残す）。 */
  readonly sessionId: string;
  readonly spot: DrillSpot;
  /** 卓の設定。Blind は Spot（元の Hand）の値で上書きする。Rule Profile が違えば開始しない。 */
  readonly config: TableConfig;
  readonly metadata?: HandMetadataInput;
}

/**
 * Drill の Hand を開始し、Script を判断の直前まで Engine で進める（Spot の検証を兼ねる）。
 * 通るのは、開始・Script のすべての Action を Engine が受け付け、Chip の総量が変わらず、Hand が終わらずに
 * 練習する判断の Street で Hero の手番になり、Hero の判断の数が decisionIndex と一致するときだけ。それ以外は invalid_input。
 * Event の形は通常の Hand と同じ（HAND_STARTED → … → SESSION_STARTED → Script の ACTION_TAKEN）。
 */
export function startDrillHand(
  input: StartDrillHandInput,
): EngineResult<HandProgress> {
  const { spot } = input;
  if (spot.ruleProfile !== input.config.ruleProfile) {
    return invalid(
      `元の Hand の Rule Profile（${spot.ruleProfile}）が今の卓（${input.config.ruleProfile}）と違う`,
    );
  }
  const started = startHand({
    handId: input.handId,
    seats: spot.seats,
    buttonPlayerId: spot.buttonPlayerId,
    config: {
      ...input.config,
      smallBlind: spot.smallBlind,
      bigBlind: spot.bigBlind,
    },
    deal: { deck: spot.deck },
    ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
  });
  if (!started.ok) return started;
  if (started.value.state.status !== "in_progress") {
    return invalid("Drill の Hand が開始直後に終わった");
  }
  const session = recordSessionEvent(started.value.state, {
    type: "SESSION_STARTED",
    sessionId: input.sessionId,
  });
  let state = session.state;
  const events: HandEvent[] = [...started.value.events, ...session.events];
  for (const step of spot.script) {
    const applied = applyAction(state, step.playerId, step.action);
    if (!applied.ok) {
      return invalid(
        `Script の Action を Engine が受け付けない: ${applied.error.message}`,
      );
    }
    state = applied.value.state;
    events.push(...applied.value.events);
  }

  // Chip の保存（INV-TEST-002）: Stack と Pot の合計が開始時の Stack の合計と同じ。
  const total = spot.seats.reduce((sum, s) => sum + s.stack, 0);
  const now = state.players.reduce((sum, p) => sum + p.stack, 0) + state.pot;
  if (now !== total) {
    return invalid(`Chip の総量が変わった: ${total} → ${now}`);
  }
  const legal = getLegalActions(state);
  if (
    state.status !== "in_progress" ||
    legal?.playerId !== spot.heroId ||
    state.street !== spot.street ||
    heroDecisions(events, spot.heroId).length !== spot.decisionIndex
  ) {
    return invalid("Script の後に、練習する判断（Hero の手番）にならない");
  }
  return { ok: true, value: { state, events } };
}
