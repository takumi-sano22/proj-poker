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
  resolveOutOfTurn,
  rulePhysicalActions,
  type PhysicalAction,
  type RulingResult,
} from "./ruling.js";
import { buildPots } from "./side-pots.js";
import {
  MAX_PLAYERS,
  MIN_PLAYERS,
  isChipAmount,
  type TableConfig,
} from "./table-config.js";

/**
 * Hand ごとの Best-effort Metadata（HAND_METADATA_RECORDED。#97）のうち、呼び出し側（Server）が渡す値。
 * ruleProfileVersion は config.ruleProfile から Engine が写すので渡さない。
 */
export type HandMetadataInput = Omit<
  Extract<HandEventBody, { type: "HAND_METADATA_RECORDED" }>,
  "type" | "ruleProfileVersion"
>;

export interface StartHandInput {
  readonly handId: string;
  /** 席順（時計回り）。 */
  readonly seats: readonly SeatInit[];
  readonly buttonPlayerId: string;
  readonly config: TableConfig;
  /** seed で Deck をシャッフルするか、配布順の 52 枚を直接渡す（Scenario Test 用）。 */
  readonly deal: { readonly seed: number } | { readonly deck: readonly Card[] };
  /**
   * 渡したときだけ、HAND_STARTED の直後に HAND_METADATA_RECORDED（system Visibility）を置く（#97）。
   * 省略すると置かない（Scenario Test・Opponent Eval の Spot は Metadata なしで同じ Event 列のまま）。
   */
  readonly metadata?: HandMetadataInput;
}

/** Command の結果。events はこの Command で新たに発行した分だけ（呼び出し側が Event Log へ追記する）。 */
export interface HandProgress {
  readonly state: HandState;
  readonly events: readonly HandEvent[];
}

/**
 * Engine が拒否した理由。
 * Phase 1 にあった unsupported_state（side_pot）は、Side Pot を実装したので無い（D78・#31）。
 */
export type EngineError =
  | ActionRejection
  | { readonly kind: "invalid_input"; readonly message: string };

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
    reopenRule: config.reopenRule,
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

  // Metadata は Hand の開始の記録なので、Hand が開始直後に終わる（Blind で All-in が決まる）場合も Hand の終わりより前に置けるよう、
  // HAND_STARTED の直後に置く。入力の配列を Event に共有させない。
  if (input.metadata !== undefined) {
    acc = emit(acc, {
      type: "HAND_METADATA_RECORDED",
      appVersion: input.metadata.appVersion,
      ruleProfileVersion: config.ruleProfile,
      cpuProfileVersion: input.metadata.cpuProfileVersion,
      cpuSeats: input.metadata.cpuSeats.map((c) => ({
        playerId: c.playerId,
        provider: c.provider,
        modelRole: c.modelRole,
        model: c.model,
      })),
    });
  }
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
  // 保留中の Out-of-Turn は、手番が来たら先に裁定する（resolvePendingOutOfTurn）。Canonical Action で飛ばさせない。
  if (state.pendingOutOfTurn?.playerId === playerId) {
    return pendingRejection(playerId);
  }
  const acc = emit(
    { state, events: [] },
    { type: "ACTION_TAKEN", ...resolved.value },
  );
  return progress(acc);
}

/** Hero の物理的な操作の結果。Event と State に加え、裁定の結果（呼び出し側が応答・記録に使う）を返す。 */
export interface PhysicalProgress extends HandProgress {
  readonly ruling: RulingResult;
}

/**
 * Hero の 1 回の物理的な操作（した順の列）を裁定し、Event にする（D90・D91）。
 * 操作ごとに PLAYER_DECLARED / PHYSICAL_CHIP_ACTION、続けて DEALER_RULING を置き、Canonical Action に決まったら
 * その ACTION_TAKEN（と、そこから自動で進む Street・Showdown）まで同じ結果に入れる。呼び出し側は 1 回で追記する。
 * 手番でなければ Out-of-Turn として保留し（State の pendingOutOfTurn）、その Player の手番で resolvePendingOutOfTurn する。
 * 保留中にもう一度操作したら not_actor（保留は 1 つだけ。手番が来たら裁定する）。
 */
export function applyPhysicalActions(
  state: HandState,
  playerId: string,
  actions: readonly PhysicalAction[],
  config: Pick<TableConfig, "chipDenominations" | "ruling">,
): EngineResult<PhysicalProgress> {
  const ruled = rulePhysicalActions(state, playerId, actions, config);
  if (!ruled.ok) return ruled;
  if (state.pendingOutOfTurn?.playerId === playerId) {
    return pendingRejection(playerId);
  }
  let acc: HandProgress = { state, events: [] };
  for (const a of actions) {
    // 入力の値を Event に共有させない（呼び出し側が後で書き換えても Event Log が変わらないように）。
    acc = emit(
      acc,
      a.type === "declare"
        ? {
            type: "PLAYER_DECLARED",
            playerId,
            street: state.street,
            declaration: { ...a.declaration },
          }
        : {
            type: "PHYSICAL_CHIP_ACTION",
            playerId,
            street: state.street,
            motion: a.type,
            chips: [...a.chips],
          },
    );
  }
  return settleRuling(acc, playerId, "operations", ruled.value);
}

/**
 * 保留中の Out-of-Turn の操作を、その Player の手番が来た時点で裁定する（D91）。
 * 状況が変わっていなければ拘束して Canonical Action を適用し、変わっていれば撤回する（no_action。Player が選び直す）。
 * DEALER_RULING（basis: pending_out_of_turn）を置き、保留は消える。保留が無い・まだ手番でないなら失敗する。
 */
export function resolvePendingOutOfTurn(
  state: HandState,
  config: Pick<TableConfig, "chipDenominations" | "ruling">,
): EngineResult<PhysicalProgress> {
  const pending = state.pendingOutOfTurn;
  if (pending === null) {
    return {
      ok: false,
      error: { kind: "invalid_input", message: "保留中の Out-of-Turn が無い" },
    };
  }
  const ruled = resolveOutOfTurn(state, pending, config);
  if (!ruled.ok) return ruled;
  return settleRuling(
    { state, events: [] },
    pending.playerId,
    "pending_out_of_turn",
    ruled.value,
  );
}

/** DEALER_RULING を置き、Canonical Action に決まったらそれを適用する。 */
function settleRuling(
  acc: HandProgress,
  playerId: string,
  basis: "operations" | "pending_out_of_turn",
  ruling: RulingResult,
): EngineResult<PhysicalProgress> {
  const ruled = emit(acc, {
    type: "DEALER_RULING",
    playerId,
    street: acc.state.street,
    basis,
    outcome: ruling.kind,
    action: ruling.kind === "action" ? { ...ruling.action } : null,
    notes: [...ruling.notes],
  });
  if (ruling.kind !== "action")
    return { ok: true, value: { ...ruled, ruling } };
  // 裁定は必ず Legal Action に寄せてある（D40）ので、ここで拒否されたら Ruling Engine の誤り。理由はそのまま返す。
  const applied = applyAction(ruled.state, playerId, ruling.action);
  if (!applied.ok) return applied;
  return {
    ok: true,
    value: {
      state: applied.value.state,
      events: [...ruled.events, ...applied.value.events],
      ruling,
    },
  };
}

function pendingRejection(playerId: string): {
  ok: false;
  error: EngineError;
} {
  return {
    ok: false,
    error: {
      kind: "not_actor",
      message: `Out-of-Turn の操作を保留中（手番が来たら裁定する）: ${playerId}`,
    },
  };
}

/** CPU の判断の経緯として Orchestrator が残す Event の中身（D83）。 */
export type AiEventBody = Extract<
  HandEventBody,
  { type: "AI_ACTION_INVALID" | "AI_FALLBACK_USED" }
>;

/**
 * 手番の CPU の判断の経緯（不正な出力・Fallback の利用）を、Log の次の seq の Event にする（D83）。卓の State は変えない。
 * 記録はその手番の Action より前に置く（Action で Hand が終わると、HAND_FINISHED の後ろへは追記できない）。
 * 手番でない Player・終わった Hand の記録は呼び出し側の誤りなので投げる。
 */
export function recordAiEvent(
  state: HandState,
  body: AiEventBody,
): HandProgress {
  const actor =
    state.actorIndex === null ? null : playerAt(state, state.actorIndex);
  if (state.status !== "in_progress" || actor?.playerId !== body.playerId) {
    throw new RangeError(
      `${body.type} は手番の Player の記録にする: ${body.playerId}`,
    );
  }
  return emit({ state, events: [] }, body);
}

/** Session・Hand の運用の記録として Orchestrator が残す Event の中身（D95）。 */
export type SessionEventBody = Extract<
  HandEventBody,
  {
    type:
      | "SESSION_STARTED"
      | "SESSION_ENDED"
      | "HAND_ABORTED"
      | "EMERGENCY_BOT_ENGAGED";
  }
>;

/**
 * Session の開始・終了、Hand の打ち切り、Emergency Bot への切り替えを、Log の次の seq の Event にする（D95）。
 * 置ける時点が決まっていて、外れていれば呼び出し側の誤りなので投げる。
 * - SESSION_STARTED / HAND_ABORTED: Hand の途中（HAND_ABORTED で Hand は終わる）
 * - EMERGENCY_BOT_ENGAGED: Hand の途中で、その CPU の手番（障害で止まった手番）
 * - SESSION_ENDED: Hand が終わった後（HAND_FINISHED か HAND_ABORTED の直後）
 */
export function recordSessionEvent(
  state: HandState,
  body: SessionEventBody,
): HandProgress {
  const inProgress = state.status === "in_progress";
  const actor =
    state.actorIndex === null ? null : playerAt(state, state.actorIndex);
  const allowed =
    body.type === "SESSION_ENDED"
      ? !inProgress
      : body.type === "EMERGENCY_BOT_ENGAGED"
        ? inProgress && actor?.playerId === body.playerId
        : inProgress;
  if (!allowed) {
    throw new RangeError(`${body.type} はこの時点では置けない`);
  }
  return emit({ state, events: [] }, body);
}

/** User Read の本文の上限（字）。1 つの判断の前に書く短い読みとして十分な長さの暫定値。 */
export const USER_READ_TEXT_MAX = 200;

/** Hero が記録する User Read の入力（D112）。Street は Engine が State から写す。 */
export interface UserReadInput {
  /** 記録する Player（Hero）。 */
  readonly playerId: string;
  /** 読みの対象の席（この Hand の playerId）。相手を特定しない読み・意図は null。 */
  readonly targetPlayerId: string | null;
  readonly text: string;
}

/**
 * Hero の User Read を、Log の次の seq の USER_READ_RECORDED（記録した本人だけの private）にする（D33・D105・D112）。卓の State は変えない。
 * 記録できるのは Hand の途中の、記録する Player の手番の間だけ。判断の前に記録した読みだけが、その判断の判断時点の情報になる
 * （hand-summary.ts）。手番でない間（CPU が判断している間）に Log を進めると、その CPU の手番が古い手番として捨てられるので受け付けない。
 * 終わった Hand には追記できない（Event Store が拒否する。docs/04 §10）。
 */
export function recordUserRead(
  state: HandState,
  input: UserReadInput,
): EngineResult<HandProgress> {
  if (state.status !== "in_progress") {
    return reject(
      "hand_complete",
      "終わった Hand には User Read を記録できない",
    );
  }
  const actor =
    state.actorIndex === null ? null : playerAt(state, state.actorIndex);
  if (actor?.playerId !== input.playerId) {
    return reject(
      "not_actor",
      `User Read は自分の手番の間だけ記録できる: ${input.playerId}`,
    );
  }
  const target = input.targetPlayerId;
  if (
    target !== null &&
    (target === input.playerId ||
      !state.players.some((p) => p.playerId === target))
  ) {
    return reject(
      "invalid_input",
      `読みの対象はこの Hand の自分以外の席: ${target}`,
    );
  }
  const text = input.text.trim();
  if (text.length === 0 || text.length > USER_READ_TEXT_MAX) {
    return reject(
      "invalid_input",
      `User Read の本文は空白を除いて 1〜${USER_READ_TEXT_MAX} 字`,
    );
  }
  return {
    ok: true,
    value: emit(
      { state, events: [] },
      {
        type: "USER_READ_RECORDED",
        playerId: input.playerId,
        street: state.street,
        targetPlayerId: target,
        text,
      },
    ),
  };
}

function reject(
  kind: "hand_complete" | "not_actor" | "invalid_input",
  message: string,
): { readonly ok: false; readonly error: EngineError } {
  return { ok: false, error: { kind, message } };
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
  // Stack が Blind に満たなければ Stack 全額（All-in）。超過分は Betting 終了時に返し、残りは Side Pot で扱う。
  return emit(acc, {
    type: "BLIND_POSTED",
    playerId: p.playerId,
    blind,
    amount: Math.min(amount, p.stack),
  });
}

/**
 * 誰も行動できない間、Hand を自動で進める。
 * Betting Round が終わるたびに、誰も Call しなかった超過分（Uncalled Bet）を返す。
 * 残り 1 人 → Pot を渡す。それ以外は Board を配り、River の後で Showdown する。
 */
function progress(start: HandProgress): EngineResult<HandProgress> {
  let acc = start;
  while (acc.state.status === "in_progress" && acc.state.actorIndex === null) {
    acc = returnUncalledBet(acc);
    const state = acc.state;
    if (state.players.filter((p) => !p.folded).length === 1) {
      acc = finish(awardPots(acc, false));
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
    acc = finish(awardPots(acc, true));
  }
  return { ok: true, value: acc };
}

/**
 * この Street で最も多く出した Player の、2 番目に多い額を超える分は誰も Call していない（Uncalled Bet）。
 * Pot に入れず本人へ返す（Fold で決着したときの Bet・Short All-in を超えた Bet・Stack 不足の Blind を超えた Blind）。
 * 超過が残るのは他の全員が Fold か All-in のときだけなので、Betting Round の終わりに 1 回見れば足りる。
 */
function returnUncalledBet(acc: HandProgress): HandProgress {
  const byCommit = [...acc.state.players].sort(
    (a, b) => b.streetCommitted - a.streetCommitted,
  );
  const [top, second] = byCommit;
  if (top === undefined || second === undefined) return acc;
  const uncalled = top.streetCommitted - second.streetCommitted;
  if (uncalled <= 0) return acc;
  return emit(acc, {
    type: "UNCALLED_BET_RETURNED",
    playerId: top.playerId,
    amount: uncalled,
  });
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

/**
 * Commit の累計から Main / Side Pot を組み立て、Main Pot から順に 1 Pot ずつ配る（POT_AWARDED は Pot ごとに 1 つ。D78）。
 * 各 Pot は争える Player の中で最強の Hand が取り、同着の端数は Rule Profile の規則で配る（D75）。
 * 争える Player が 1 人だけの Pot（Fold で決着・Side Pot の独占）は札を比べずにその Player へ渡す。
 */
function awardPots(acc: HandProgress, showdown: boolean): HandProgress {
  const state = acc.state;
  // Button の左から時計回りの順で渡すので、eligible と winners もその順になる（端数を配る順）。
  const pots = buildPots(seatsFromButton(state));
  const values = new Map<string, HandValue>();
  if (showdown) {
    for (const p of state.players) {
      if (!p.folded) {
        values.set(
          p.playerId,
          evaluateHand([...(p.holeCards ?? []), ...state.board]),
        );
      }
    }
  }
  let next = acc;
  pots.forEach((pot, potIndex) => {
    const contested = showdown && pot.eligible.length > 1;
    const winners = contested ? bestHands(pot.eligible, values) : pot.eligible;
    next = emit(next, {
      type: "POT_AWARDED",
      potIndex,
      potTotal: pot.amount,
      eligible: pot.eligible,
      awards: splitPot(pot.amount, winners, state.oddChipRule),
      showdown: contested,
    });
  });
  return next;
}

/** 候補のうち最強の Hand を持つ Player（同着なら全員）。候補の順を保つ。 */
function bestHands(
  candidates: readonly string[],
  values: ReadonlyMap<string, HandValue>,
): string[] {
  const valueOf = (id: string): HandValue => {
    const v = values.get(id);
    if (v === undefined) throw new RangeError(`Hand を評価していない: ${id}`);
    return v;
  };
  const best = candidates
    .map(valueOf)
    .reduce((top, v) => (compareHands(v, top) > 0 ? v : top));
  return candidates.filter((id) => compareHands(valueOf(id), best) === 0);
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
  if (input.metadata !== undefined) {
    // Metadata の CPU は、この Hand に座った Player の中で重複しないこと（記録の取り違えを Event にしない）。
    const cpuIds = input.metadata.cpuSeats.map((c) => c.playerId);
    if (
      new Set(cpuIds).size !== cpuIds.length ||
      cpuIds.some((id) => !ids.has(id))
    ) {
      return "Metadata の CPU が卓にいないか重複している";
    }
  }
  if (config.oddChipRule !== "first_left_of_button") {
    return `未対応の oddChipRule: ${String(config.oddChipRule)}`;
  }
  if (config.reopenRule !== "cumulative_full_raise") {
    return `未対応の reopenRule: ${String(config.reopenRule)}`;
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
