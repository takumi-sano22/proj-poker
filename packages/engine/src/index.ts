// Poker Engine の公開入口。このパッケージは I/O・DB・LLM を import しない（CLAUDE.md 不変条件 1・2、D68）。
export const ENGINE_PACKAGE_NAME = "@proj-poker/engine";

export {
  DECK_SIZE,
  RANKS,
  SUITS,
  cardToString,
  cardsEqual,
  createDeck,
  parseCard,
  parseCards,
} from "./card.js";
export type { Card, Rank, Suit } from "./card.js";

export {
  createRng,
  createShuffledDeck,
  randomInt,
  shuffle,
  shuffleDeck,
} from "./rng.js";
export type { Rng } from "./rng.js";

export { HandCategory, compareHands, evaluateHand } from "./hand-evaluator.js";
export type { HandValue } from "./hand-evaluator.js";

export { DEFAULT_CHIP_DENOMINATIONS, composeChips } from "./chips.js";
export type { ChipColor, ChipCount, ChipDenomination } from "./chips.js";

export {
  MAX_PLAYERS,
  MIN_PLAYERS,
  PHASE1_CASH_PRESET,
  isChipAmount,
} from "./table-config.js";
export type {
  AnteConfig,
  ButtonRule,
  OddChipRule,
  PostedAnteKind,
  ReopenRule,
  RulingRules,
  TableConfig,
} from "./table-config.js";

export { splitPot } from "./pot-split.js";

export { buildPots } from "./side-pots.js";
export type { Pot, PotContributor } from "./side-pots.js";

export { isVisibleTo, visibilityOf } from "./hand-events.js";
export type {
  ActionType,
  CpuProviderKind,
  CpuSeatMetadata,
  FallbackKind,
  HandAbortReason,
  HandEvent,
  HandEventBody,
  HandEventType,
  InvalidOutputStage,
  OutageKind,
  PlayerChips,
  RulingBasis,
  RulingOutcome,
  SeatInit,
  SessionEndReason,
  Street,
  Visibility,
} from "./hand-events.js";

export { foldHandEvents } from "./hand-state.js";
export type { HandState, PlayerState } from "./hand-state.js";

export { getLegalActions } from "./legal-actions.js";
export type {
  ActionRejection,
  CanonicalAction,
  LegalAction,
  LegalActionSet,
  PlayerAction,
} from "./legal-actions.js";

export {
  applyAction,
  applyPhysicalActions,
  recordAiEvent,
  recordSessionEvent,
  recordUserRead,
  resolvePendingOutOfTurn,
  startHand,
  USER_READ_TEXT_MAX,
} from "./hand-engine.js";
export type {
  AiEventBody,
  EngineError,
  EngineResult,
  HandMetadataInput,
  HandProgress,
  PhysicalProgress,
  SessionEventBody,
  StartHandInput,
  UserReadInput,
} from "./hand-engine.js";

export {
  FIRST_TOURNAMENT_PROGRESS,
  TOURNAMENT_CONFIG_VERSION,
  TOURNAMENT_PRESET_IDS,
  TOURNAMENT_PRESETS,
  isTournamentHandContext,
  isTournamentPresetId,
  levelAt,
  nextTournamentProgress,
  sessionSettingsOf,
  tableConfigForLevel,
  tournamentHandContext,
  validateTournamentConfig,
} from "./tournament.js";
export type {
  AnteKind,
  BlindLevel,
  BlindSchedule,
  PayoutStructure,
  SessionMode,
  SessionSettings,
  TournamentConfig,
  TournamentHandContext,
  TournamentPresetId,
  TournamentProgress,
  TournamentSession,
} from "./tournament.js";

export { resolveOutOfTurn, rulePhysicalActions } from "./ruling.js";
export type {
  Declaration,
  PendingOutOfTurn,
  PhysicalAction,
  RulingCode,
  RulingResult,
} from "./ruling.js";

export { nextHandSeating } from "./position.js";
export type { NextHandSeating, PreviousHandResult } from "./position.js";

export {
  projectHeroView,
  projectKnowledgeState,
  publicEvents,
  visibleEvents,
} from "./projection.js";
export type {
  DecisionMath,
  HeroView,
  KnowledgeState,
  PositionInfo,
  PublicActionRecord,
  PublicRulingRecord,
  SeatView,
  TableView,
} from "./projection.js";

export {
  DEFAULT_IMPORTANT_SPOT_RULES,
  extractImportantSpots,
  heroDecisions,
  heroInformationSets,
  projectHandSummary,
} from "./hand-summary.js";
export type {
  HandOutcome,
  HandSummary,
  HeroDecision,
  HeroInformationSet,
  ImportantSpot,
  ImportantSpotReason,
  ImportantSpotRules,
  PotResult,
  ShowdownRecord,
  UserReadRecord,
} from "./hand-summary.js";

export { buildDrillSpot, startDrillHand } from "./drill.js";
export type {
  DrillScriptAction,
  DrillSpot,
  DrillSpotChange,
  DrillSpotDelta,
  StartDrillHandInput,
} from "./drill.js";

export { projectLearningReveal } from "./learning-reveal.js";

export {
  STAT_DEFINITIONS,
  STATS_DEFINITION_VERSION,
  projectPlayerStats,
  toStatsHand,
} from "./stats.js";
export type {
  PlayerStats,
  StatContribution,
  StatDefinition,
  StatId,
  StatKind,
  StatTable,
  StatValue,
  StatsAction,
  StatsHand,
  StatsOptions,
  StatsProjection,
} from "./stats.js";
export type { LearningReveal, RevealedHoleCards } from "./learning-reveal.js";

export { breakEvenFoldFrequency, potOdds } from "./pot-math.js";

export { comboKey, parseRange } from "./range.js";
export type { Combo } from "./range.js";

export {
  LOOSE_RANGE_PROFILE,
  RANGE_PROFILES,
  STANDARD_RANGE_PROFILE,
  TIGHT_RANGE_PROFILE,
} from "./range-config.js";
export type {
  PositionName,
  PreflopSpot,
  RangeProfile,
} from "./range-config.js";

export {
  classifyPreflop,
  heroRange,
  positionName,
  villainRange,
} from "./range-model.js";
export type {
  PostflopNarrowing,
  RangeAssumption,
  VillainRange,
} from "./range-model.js";

export {
  DEFAULT_EQUITY_OPTIONS,
  EquityUnavailableError,
  equityVsRanges,
} from "./equity.js";
export type { EquityOptions, EquityResult } from "./equity.js";

export { analyzeDecision, compareRangeProfiles } from "./decision-analysis.js";
export type {
  AlternativeAction,
  DecisionAnalysis,
  DecisionAnalysisOptions,
  RangeComparison,
} from "./decision-analysis.js";
