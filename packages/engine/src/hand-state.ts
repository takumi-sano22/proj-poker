// Hand の State と Reducer。State は Event の畳み込みでしか変わらない（D37）。
// Reducer は Card を「知っている分だけ」持つ作りにしてある。Projection は見える Event だけを畳み込むので、
// 他者の Hole Cards と Deck は最初から State に入らない（docs/04 §5 の whitelist）。
import type { Card } from "./card.js";
import type { HandEvent, PlayerChips, Street } from "./hand-events.js";
import type { OddChipRule } from "./table-config.js";

export interface PlayerState {
  readonly playerId: string;
  readonly stack: number;
  /** この Street で出した額。 */
  readonly streetCommitted: number;
  /** この Hand で出した額の累計（返却された Uncalled Bet は引く）。 */
  readonly totalCommitted: number;
  /** 知らない（見えない）なら null。 */
  readonly holeCards: readonly Card[] | null;
  readonly folded: boolean;
  readonly allIn: boolean;
  /** Showdown などで Hole Cards を公開済みか。 */
  readonly shown: boolean;
  /**
   * この Street で最後に行動した時点の fullRaiseCount。未行動なら null。
   * 「自分の行動の後に Full Raise があったか」で Raise の再開（Reopen）を判定する。
   */
  readonly actedAtRaiseCount: number | null;
}

export interface HandState {
  readonly handId: string;
  readonly ruleProfile: string;
  readonly smallBlind: number;
  readonly bigBlind: number;
  readonly oddChipRule: OddChipRule;
  /** 席順（時計回り）。 */
  readonly players: readonly PlayerState[];
  readonly buttonIndex: number;
  /** 配布順の Deck。Projection では空（engine Visibility の Event を読まないため）。 */
  readonly deck: readonly Card[];
  readonly board: readonly Card[];
  readonly street: Street;
  /** 卓の中央にある Chip（全 Street の Commit の合計 − 返却 − 配分）。 */
  readonly pot: number;
  /** この Street の最高 Commit 額。 */
  readonly currentBet: number;
  /** 直近の Full Bet / Raise の増分。Minimum Raise は currentBet + lastRaiseSize。 */
  readonly lastRaiseSize: number;
  /** この Street の Full Bet / Raise の回数（Short All-in は数えない）。 */
  readonly fullRaiseCount: number;
  /** 次に行動する Player の添字。誰も行動できない（Street 終了・Hand 終了）なら null。 */
  readonly actorIndex: number | null;
  readonly status: "in_progress" | "complete";
  /** この Hand で配分した額の Player ごとの合計（Main / Side Pot を合算。最初に受け取った順）。 */
  readonly awards: readonly PlayerChips[];
  /** 次に発行する Event の seq。 */
  readonly nextSeq: number;
}

/** Event 列を先頭から畳み込んで State を作る。先頭は HAND_STARTED でなければならない。 */
export function foldHandEvents(events: readonly HandEvent[]): HandState {
  const [first, ...rest] = events;
  if (first === undefined) {
    throw new RangeError("Event 列が空");
  }
  return rest.reduce(applyEvent, initialState(first));
}

/** HAND_STARTED から初期 State を作る。 */
export function initialState(event: HandEvent): HandState {
  if (event.type !== "HAND_STARTED") {
    throw new RangeError(
      `先頭の Event が HAND_STARTED ではない: ${event.type}`,
    );
  }
  const buttonIndex = event.seats.findIndex(
    (s) => s.playerId === event.buttonPlayerId,
  );
  return {
    handId: event.handId,
    ruleProfile: event.ruleProfile,
    smallBlind: event.smallBlind,
    bigBlind: event.bigBlind,
    oddChipRule: event.oddChipRule,
    players: event.seats.map((s) => ({
      playerId: s.playerId,
      stack: s.stack,
      streetCommitted: 0,
      totalCommitted: 0,
      holeCards: null,
      folded: false,
      allIn: false,
      shown: false,
      actedAtRaiseCount: null,
    })),
    buttonIndex,
    deck: [],
    board: [],
    street: "preflop",
    pot: 0,
    currentBet: 0,
    lastRaiseSize: event.bigBlind,
    fullRaiseCount: 0,
    actorIndex: null,
    status: "in_progress",
    awards: [],
    nextSeq: event.seq + 1,
  };
}

/** 1 つの Event を State に適用する（純粋関数。元の State は変えない）。 */
export function applyEvent(state: HandState, event: HandEvent): HandState {
  const next = applyBody(state, event);
  return { ...next, nextSeq: event.seq + 1 };
}

function applyBody(state: HandState, event: HandEvent): HandState {
  switch (event.type) {
    case "HAND_STARTED":
      throw new RangeError("HAND_STARTED が 2 回現れた");

    case "DECK_SHUFFLED":
      return { ...state, deck: event.deck };

    case "BLIND_POSTED": {
      const index = indexOf(state, event.playerId);
      const posted = updatePlayer(state, index, (p) => commit(p, event.amount));
      // BB が Stack 不足で短く出しても、Preflop の Call 額は BB の全額（他の Player は BB 額を合わせる）。
      const withBet = {
        ...posted,
        currentBet: Math.max(
          state.currentBet,
          event.blind === "big" ? state.bigBlind : event.amount,
        ),
      };
      // Big Blind が出たら Preflop の最初の Actor が決まる（Blind の投入は「行動」に数えない）。
      return event.blind === "big"
        ? { ...withBet, actorIndex: nextActorAfter(withBet, index) }
        : withBet;
    }

    case "HOLE_CARD_DEALT":
      return updatePlayer(state, indexOf(state, event.playerId), (p) => ({
        ...p,
        holeCards: event.cards,
      }));

    case "ACTION_TAKEN": {
      const index = indexOf(state, event.playerId);
      const increment = event.toAmount - state.currentBet;
      // Full Bet / Raise は増分が直近の Raise 幅以上のとき。未満の All-in（Short All-in）は Raise を再開しない。
      const isFullRaise = increment > 0 && increment >= state.lastRaiseSize;
      const fullRaiseCount = state.fullRaiseCount + (isFullRaise ? 1 : 0);
      const acted = updatePlayer(state, index, (p) => ({
        ...commit(p, event.amount),
        folded: p.folded || event.action === "fold",
        actedAtRaiseCount: fullRaiseCount,
      }));
      const after: HandState = {
        ...acted,
        currentBet: Math.max(state.currentBet, event.toAmount),
        lastRaiseSize: isFullRaise ? increment : state.lastRaiseSize,
        fullRaiseCount,
      };
      return { ...after, actorIndex: nextActorAfter(after, index) };
    }

    case "BOARD_DEALT": {
      // Street が変わると Betting Round の状態を初期化する。
      const reset: HandState = {
        ...state,
        board: [...state.board, ...event.cards],
        street: event.street,
        currentBet: 0,
        lastRaiseSize: state.bigBlind,
        fullRaiseCount: 0,
        players: state.players.map((p) => ({
          ...p,
          streetCommitted: 0,
          actedAtRaiseCount: null,
        })),
      };
      // Postflop は Button の次（左）から行動する。
      return { ...reset, actorIndex: nextActorAfter(reset, state.buttonIndex) };
    }

    case "CARDS_TABLED":
      return updatePlayer(state, indexOf(state, event.playerId), (p) => ({
        ...p,
        holeCards: event.cards,
        shown: true,
      }));

    case "UNCALLED_BET_RETURNED":
      // totalCommitted を減らすので、updatePlayer が pot も同額だけ減らす。
      return updatePlayer(state, indexOf(state, event.playerId), (p) => ({
        ...p,
        stack: p.stack + event.amount,
        streetCommitted: p.streetCommitted - event.amount,
        totalCommitted: p.totalCommitted - event.amount,
      }));

    case "POT_AWARDED": {
      const players = state.players.map((p) => {
        const award = event.awards.find((a) => a.playerId === p.playerId);
        return award === undefined
          ? p
          : { ...p, stack: p.stack + award.amount };
      });
      return {
        ...state,
        players,
        pot: state.pot - event.potTotal,
        awards: addAwards(state.awards, event.awards),
        actorIndex: null,
      };
    }

    case "HAND_FINISHED":
      return { ...state, status: "complete", actorIndex: null };
  }
}

/** Pot ごとの配分を Player ごとの合計へ足し込む（同じ Player が複数の Pot を取っても 1 行にまとめる）。 */
function addAwards(
  total: readonly PlayerChips[],
  awards: readonly PlayerChips[],
): PlayerChips[] {
  const merged: { playerId: string; amount: number }[] = total.map((t) => ({
    ...t,
  }));
  for (const a of awards) {
    const existing = merged.find((m) => m.playerId === a.playerId);
    if (existing === undefined) merged.push({ ...a });
    else existing.amount += a.amount;
  }
  return merged;
}

/** Stack から amount を出して Commit する。Stack が 0 になったら All-in。 */
function commit(p: PlayerState, amount: number): PlayerState {
  const stack = p.stack - amount;
  return {
    ...p,
    stack,
    streetCommitted: p.streetCommitted + amount,
    totalCommitted: p.totalCommitted + amount,
    allIn: p.allIn || (amount > 0 && stack === 0),
  };
}

// Player を 1 人更新する。totalCommitted の増減を pot にも同時に反映し、両者がずれないようにする。
function updatePlayer(
  state: HandState,
  index: number,
  update: (p: PlayerState) => PlayerState,
): HandState {
  const before = playerAt(state, index);
  const after = update(before);
  const players = state.players.map((p, i) => (i === index ? after : p));
  return {
    ...state,
    players,
    pot: state.pot + (after.totalCommitted - before.totalCommitted),
  };
}

export function playerAt(state: HandState, index: number): PlayerState {
  const p = state.players[index];
  if (p === undefined) {
    throw new RangeError(`席番号が範囲外: ${index}`);
  }
  return p;
}

export function indexOf(state: HandState, playerId: string): number {
  const index = state.players.findIndex((p) => p.playerId === playerId);
  if (index < 0) {
    throw new RangeError(`卓にいない Player: ${playerId}`);
  }
  return index;
}

/** Fold も All-in もしておらず、まだ Chip を出せる Player の数。 */
export function countCanAct(state: HandState): number {
  return state.players.filter((p) => !p.folded && !p.allIn).length;
}

export function countNotFolded(state: HandState): number {
  return state.players.filter((p) => !p.folded).length;
}

/**
 * この Player に行動が要るか。
 * 未行動なら、相手が残っている限り行動する（Preflop の BB Option を含む）。行動済みでも、Commit が最高額に届いていなければ行動する。
 */
function needsToAct(state: HandState, p: PlayerState): boolean {
  if (p.folded || p.allIn) return false;
  if (p.streetCommitted < state.currentBet) return true;
  return p.actedAtRaiseCount === null && countCanAct(state) >= 2;
}

/** from の次（時計回り）から、行動が要る最初の Player を探す。 */
function nextActorAfter(state: HandState, from: number): number | null {
  if (countNotFolded(state) <= 1) return null;
  const n = state.players.length;
  for (let step = 1; step <= n; step++) {
    const index = (from + step) % n;
    if (needsToAct(state, playerAt(state, index))) return index;
  }
  return null;
}
