// テスト用の HeroView。サーバーの Projection の形（@proj-poker/engine の HeroView）に合わせて手で組む。
import type { HandEvent, HeroView, SeatView } from "@proj-poker/engine";

export function seat(
  playerId: string,
  overrides: Partial<SeatView> = {},
): SeatView {
  return {
    playerId,
    isButton: false,
    stack: 200,
    streetCommitted: 0,
    totalCommitted: 0,
    folded: false,
    allIn: false,
    holeCards: null,
    ...overrides,
  };
}

const pub = { type: "public" } as const;

/** 6 人卓・Preflop・Hero（UTG）の手番。SB = cpu4、BB = cpu5、Button = cpu3。 */
export function preflopHeroToAct(overrides: Partial<HeroView> = {}): HeroView {
  const log: HandEvent[] = [
    {
      seq: 0,
      visibility: pub,
      type: "HAND_STARTED",
      handId: "h1",
      ruleProfile: "phase1_provisional_v0",
      smallBlind: 1,
      bigBlind: 2,
      oddChipRule: "first_left_of_button",
      reopenRule: "cumulative_full_raise",
      seats: ["hero", "cpu1", "cpu2", "cpu3", "cpu4", "cpu5"].map((id) => ({
        playerId: id,
        stack: 200,
      })),
      buttonPlayerId: "cpu3",
    },
    {
      seq: 2,
      visibility: pub,
      type: "BLIND_POSTED",
      playerId: "cpu4",
      blind: "small",
      amount: 1,
    },
    {
      seq: 3,
      visibility: pub,
      type: "BLIND_POSTED",
      playerId: "cpu5",
      blind: "big",
      amount: 2,
    },
    {
      seq: 4,
      visibility: { type: "private", playerId: "hero" },
      type: "HOLE_CARD_DEALT",
      playerId: "hero",
      cards: [
        { rank: 14, suit: "s" },
        { rank: 13, suit: "h" },
      ],
    },
  ];
  return {
    handId: "h1",
    viewerId: "hero",
    ruleProfile: "phase1_provisional_v0",
    smallBlind: 1,
    bigBlind: 2,
    street: "preflop",
    status: "in_progress",
    board: [],
    pot: 3,
    currentBet: 2,
    actorId: "hero",
    seats: [
      seat("hero", {
        holeCards: [
          { rank: 14, suit: "s" },
          { rank: 13, suit: "h" },
        ],
      }),
      seat("cpu1"),
      seat("cpu2"),
      seat("cpu3", { isButton: true }),
      seat("cpu4", { stack: 199, streetCommitted: 1, totalCommitted: 1 }),
      seat("cpu5", { stack: 198, streetCommitted: 2, totalCommitted: 2 }),
    ],
    legalActions: {
      playerId: "hero",
      toCall: 2,
      actions: [
        { type: "fold" },
        { type: "call", amount: 2 },
        { type: "raise", min: 4, max: 200 },
        { type: "all_in", amount: 200 },
      ],
    },
    awards: [],
    log,
    ...overrides,
  };
}
