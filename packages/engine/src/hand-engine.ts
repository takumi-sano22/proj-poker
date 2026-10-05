// Hand の進行（Command 側）。入力を検証して Event を作り、Reducer で畳み込んだ State と一緒に返す。
// 純粋関数で、I/O・時刻・Math.random を使わない。乱数は seed か積んだ Deck で注入する（docs/02 §10）。
import { DECK_SIZE, cardToString, createDeck, type Card } from "./card.js";
import {
  visibilityOf,
  type HandEvent,
  type HandEventBody,
  type SeatInit,
} from "./hand-events.js";
import {
  compareHands,
  evaluateHand,
  type HandValue,
} from "./hand-evaluator.js";
import {
  applyEvent,
  countCanAct,
  initialState,
  playerAt,
  type HandState,
} from "./hand-state.js";
import {
  resolveAction,
  type ActionRejection,
  type PlayerAction,
} from "./legal-actions.js";
import { splitPot } from "./pot-split.js";
import { createShuffledDeck } from "./rng.js";
import {
  MAX_PLAYERS,
  MIN_PLAYERS,
  isChipAmount,
  type TableConfig,
} from "./table-config.js";

export interface StartHandInput {
  readonly handId: string;
  /** 席順（時計回り）。 */
  readonly seats: readonly SeatInit[];
  readonly buttonPlayerId: string;
  readonly config: TableConfig;
  /** seed で Deck をシャッフルするか、配布順の 52 枚を直接渡す（Scenario Test 用）。 */
  readonly deal: { readonly seed: number } | { readonly deck: readonly Card[] };
}

/** Command の結果。events はこの Command で新たに発行した分だけ（呼び出し側が Event Log へ追記する）。 */
export interface HandProgress {
  readonly state: HandState;
  readonly events: readonly HandEvent[];
}

/**
 * Engine が拒否した理由。unsupported_state は「ルール上は合法だが Phase 1 の Engine が扱えない状態」（D70）。
 * - side_pot: 貢献額の異なる All-in（Side Pot が要る）
 * Split Pot の端数は D75 で Phase 1 に前倒しして実装したため、ここには無い。
 */
export type EngineError =
  | ActionRejection
  | { readonly kind: "invalid_input"; readonly message: string }
  | {
      readonly kind: "unsupported_state";
      readonly reason: "side_pot";
      readonly message: string;
    };

export type EngineResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: EngineError };

/** Hand を開始する。Button・Blind・Hole Cards の配布まで進め、最初の Actor が決まった State を返す。 */
export function startHand(input: StartHandInput): EngineResult<HandProgress> {
  const invalid = validateStartInput(input);
  if (invalid !== null) {
    return { ok: false, error: { kind: "invalid_input", message: invalid } };
  }
  const deck =
    "deck" in input.deal
      ? [...input.deal.deck]
      : createShuffledDeck(input.deal.seed);
  const seed = "seed" in input.deal ? input.deal.seed : null;
  const { seats, config } = input;
  const n = seats.length;
  const button = seats.findIndex((s) => s.playerId === input.buttonPlayerId);
  // Heads-Up は Button = SB（docs/02 §7）。3 人以上は Button の左が SB、その左が BB。
  const sb = n === 2 ? button : (button + 1) % n;
  const bb = (sb + 1) % n;

  const startedBody: HandEventBody = {
    type: "HAND_STARTED",
    handId: input.handId,
    ruleProfile: config.ruleProfile,
    smallBlind: config.smallBlind,
    bigBlind: config.bigBlind,
    oddChipRule: config.oddChipRule,
    // 入力の配列を Event に共有させない（呼び出し側が後で書き換えても Event Log が変わらないように）。
    seats: seats.map((s) => ({ playerId: s.playerId, stack: s.stack })),
    buttonPlayerId: input.buttonPlayerId,
  };
  const started = {
    ...startedBody,
    seq: 0,
    visibility: visibilityOf(startedBody),
  };
  let acc: HandProgress = { state: initialState(started), events: [started] };

  acc = emit(acc, { type: "DECK_SHUFFLED", seed, deck });
  acc = postBlind(acc, sb, "small", config.smallBlind);
  acc = postBlind(acc, bb, "big", config.bigBlind);
  // 配布は Button の左から 1 枚ずつ 2 周する。k 番目に配られる Player の札は deck[k] と deck[n + k]。
  for (let k = 0; k < n; k++) {
    const seat = seats[(button + 1 + k) % n] as SeatInit;
    acc = emit(acc, {
      type: "HOLE_CARD_DEALT",
      playerId: seat.playerId,
      cards: [deck[k] as Card, deck[n + k] as Card],
    });
  }

  const sidePot = checkSidePot(acc.state);
  if (sidePot !== null) return { ok: false, error: sidePot };
  return progress(acc);
}

/** Actor の Action を適用し、必要なら Street の進行・Showdown・Pot の配分まで進める。 */
export function applyAction(
  state: HandState,
  playerId: string,
  action: PlayerAction,
): EngineResult<HandProgress> {
  const resolved = resolveAction(state, playerId, action);
  if (!resolved.ok) return resolved;
  const acc = emit(
    { state, events: [] },
    { type: "ACTION_TAKEN", ...resolved.value },
  );
  const sidePot = checkSidePot(acc.state);
  if (sidePot !== null) return { ok: false, error: sidePot };
  return progress(acc);
}

/** Event を 1 つ発行し、State に畳み込む。seq と Visibility はここでだけ付ける。 */
function emit(acc: HandProgress, body: HandEventBody): HandProgress {
  const event: HandEvent = {
    ...body,
    seq: acc.state.nextSeq,
    visibility: visibilityOf(body),
  };
  return {
    state: applyEvent(acc.state, event),
    events: [...acc.events, event],
  };
}

function postBlind(
  acc: HandProgress,
  index: number,
  blind: "small" | "big",
  amount: number,
): HandProgress {
  const p = playerAt(acc.state, index);
  // Stack が Blind に満たなければ Stack 全額（All-in）。その状態は直後の checkSidePot で拒否される。
  return emit(acc, {
    type: "BLIND_POSTED",
    playerId: p.playerId,
    blind,
    amount: Math.min(amount, p.stack),
  });
}

/**
 * Side Pot が要る状態か（D70: Phase 1 は単一 Pot だけを扱う）。
 * All-in した Player より多く Commit した Player がいれば、超過分は All-in の Player が争えない Pot になる。
 */
function checkSidePot(state: HandState): EngineError | null {
  for (const a of state.players) {
    if (!a.allIn || a.folded) continue;
    const over = state.players.find((q) => q.totalCommitted > a.totalCommitted);
    if (over !== undefined) {
      return {
        kind: "unsupported_state",
        reason: "side_pot",
        message: `${a.playerId} の All-in（${a.totalCommitted}）を ${over.playerId}（${over.totalCommitted}）が超えるため Side Pot が要る。Phase 1 は未対応（D70）`,
      };
    }
  }
  return null;
}

/**
 * 誰も行動できない間、Hand を自動で進める。
 * 残り 1 人 → Uncalled Bet を返して Pot を渡す。それ以外は Board を配り、River の後で Showdown する。
 */
function progress(start: HandProgress): EngineResult<HandProgress> {
  let acc = start;
  while (acc.state.status === "in_progress" && acc.state.actorIndex === null) {
    const state = acc.state;
    const alive = state.players.filter((p) => !p.folded);
    const [onlyAlive] = alive;

    if (alive.length === 1 && onlyAlive !== undefined) {
      acc = finishByFold(acc, onlyAlive.playerId);
      continue;
    }
    // これ以上 Betting が無い（All-in で決着待ち）か River が終わったら、残った全員が札を公開する。
    if (state.street === "river" || countCanAct(state) < 2) {
      acc = tableCards(acc);
    }
    if (state.street !== "river") {
      acc = dealNextStreet(acc);
      continue;
    }
    acc = awardShowdown(acc);
  }
  return { ok: true, value: acc };
}

function finishByFold(acc: HandProgress, winnerId: string): HandProgress {
  const winner = acc.state.players.find((p) => p.playerId === winnerId);
  const others = acc.state.players.filter((p) => p.playerId !== winnerId);
  const called = Math.max(0, ...others.map((p) => p.streetCommitted));
  const uncalled = (winner?.streetCommitted ?? 0) - called;
  let next = acc;
  if (uncalled > 0) {
    // 誰も Call していない分は Pot に入らない。勝者へ返してから Pot を渡す。
    next = emit(next, {
      type: "UNCALLED_BET_RETURNED",
      playerId: winnerId,
      amount: uncalled,
    });
  }
  next = emit(next, {
    type: "POT_AWARDED",
    potTotal: next.state.pot,
    awards: [{ playerId: winnerId, amount: next.state.pot }],
    showdown: false,
  });
  return finish(next);
}

/** Fold していない全員の札を、Button の左から順に公開する（公開済みの Player は飛ばす）。 */
function tableCards(acc: HandProgress): HandProgress {
  let next = acc;
  for (const p of seatsFromButton(acc.state)) {
    if (p.folded || p.shown || p.holeCards === null) continue;
    next = emit(next, {
      type: "CARDS_TABLED",
      playerId: p.playerId,
      cards: p.holeCards,
    });
  }
  return next;
}

/** 次の Street の Board を配る。Burn は省き、Hole Cards の直後から順に使う（Deck の位置は 2n + Board 枚数）。 */
function dealNextStreet(acc: HandProgress): HandProgress {
  const state = acc.state;
  const start = state.players.length * 2 + state.board.length;
  const street =
    state.street === "preflop"
      ? "flop"
      : state.street === "flop"
        ? "turn"
        : "river";
  const count = street === "flop" ? 3 : 1;
  return emit(acc, {
    type: "BOARD_DEALT",
    street,
    cards: state.deck.slice(start, start + count),
  });
}

/** Showdown で最強の Hand を持つ Player に Pot を配る。同着の端数は Rule Profile の規則で配る（D75）。 */
function awardShowdown(acc: HandProgress): HandProgress {
  const state = acc.state;
  const contenders = seatsFromButton(state)
    .filter((p) => !p.folded)
    .map((p) => ({
      playerId: p.playerId,
      value: evaluateHand([...(p.holeCards ?? []), ...state.board]),
    }));
  const best = contenders.reduce<HandValue | null>(
    (top, c) =>
      top === null || compareHands(c.value, top) > 0 ? c.value : top,
    null,
  );
  const winners = contenders.filter(
    (c) => best !== null && compareHands(c.value, best) === 0,
  );
  // contenders は Button の左から時計回りの順なので、winners もその順になる（端数を配る順）。
  const awards = splitPot(
    state.pot,
    winners.map((w) => w.playerId),
    state.oddChipRule,
  );
  const awarded = emit(acc, {
    type: "POT_AWARDED",
    potTotal: state.pot,
    awards,
    showdown: true,
  });
  return finish(awarded);
}

function finish(acc: HandProgress): HandProgress {
  return emit(acc, {
    type: "HAND_FINISHED",
    stacks: acc.state.players.map((p) => ({
      playerId: p.playerId,
      amount: p.stack,
    })),
  });
}

/** Button の左から時計回りに並べた Player（Button が最後）。 */
function seatsFromButton(state: HandState) {
  const n = state.players.length;
  return Array.from({ length: n }, (_, k) =>
    playerAt(state, (state.buttonIndex + 1 + k) % n),
  );
}

/** 開始入力の検証。問題があれば理由を返す。 */
function validateStartInput(input: StartHandInput): string | null {
  const { seats, config } = input;
  if (input.handId === "") return "handId が空";
  if (seats.length < MIN_PLAYERS || seats.length > MAX_PLAYERS) {
    return `人数は ${MIN_PLAYERS}〜${MAX_PLAYERS}: ${seats.length}`;
  }
  const ids = new Set(seats.map((s) => s.playerId));
  if (ids.size !== seats.length || ids.has("")) {
    return "playerId が空または重複している";
  }
  if (!ids.has(input.buttonPlayerId)) {
    return `Button が卓にいない: ${input.buttonPlayerId}`;
  }
  if (config.oddChipRule !== "first_left_of_button") {
    return `未対応の oddChipRule: ${String(config.oddChipRule)}`;
  }
  // Chip はすべて最小単位の整数（D74）。
  if (
    !isChipAmount(config.smallBlind) ||
    !isChipAmount(config.bigBlind) ||
    config.smallBlind <= 0 ||
    config.bigBlind < config.smallBlind
  ) {
    return `Blind は 0 < SB <= BB の整数: ${config.smallBlind}/${config.bigBlind}`;
  }
  if (seats.some((s) => !isChipAmount(s.stack) || s.stack <= 0)) {
    return "Stack は正の整数";
  }
  if (!Number.isSafeInteger(seats.reduce((sum, s) => sum + s.stack, 0))) {
    return "Stack の合計が安全な整数の範囲を超える";
  }
  if ("seed" in input.deal) {
    if (!Number.isSafeInteger(input.deal.seed)) return "seed は整数";
  } else {
    // 52 枚すべてが正規の Card で、重複が無いこと（INV-TEST-001 の前提）。
    const deck = input.deal.deck.map(cardToString);
    const valid = new Set(createDeck().map(cardToString));
    if (
      deck.length !== DECK_SIZE ||
      new Set(deck).size !== DECK_SIZE ||
      deck.some((c) => !valid.has(c))
    ) {
      return `Deck は重複のない ${DECK_SIZE} 枚`;
    }
  }
  return null;
}
