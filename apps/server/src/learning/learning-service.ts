// Learning の読み出し（#116・docs/07 §4〜§6・D111・D115・D116）。Session Review と Recent / Long-term の Player Profile を、
// Event Log（正本）と Pass A の reviews から都度計算して返す（Score・Stats・Profile は保存しない。D111）。
// - Review を作らない（D115: 自動・一括の Review をしない。課金の経路を増やさない）。読むのは Pass A の reviews だけで、
//   Pass B（reveal_reviews）は受け取らない
// - Hypothesis は #114 の Snapshot（reviews から作り直せる派生データ。D113）を、Profile を読むたびに同じ Evidence から入れ替えて返す。
//   正本（Event Log・reviews）は書き換えない
// - Stats は Hero の行だけを返す（他 Player の詳細 HUD を出さない。D32）
// ユーザーの弱点なので、CPU の KnowledgeState・Prompt・CPU Memory へは渡さない（不変条件 2）。
import {
  projectPlayerStats,
  type HandEvent,
  type StatTable,
} from "@proj-poker/engine";
import type { EventStore } from "../event-store.js";
import type { ScoreSource } from "./ability-evidence.js";
import type {
  HypothesisSnapshot,
  HypothesisSnapshotStore,
} from "./hypothesis-snapshot.js";
import {
  computePlayerProfile,
  renderProfileText,
  type StructuredProfile,
} from "./profile.js";
import {
  computeSessionReview,
  type SessionHandRecord,
  type SessionReview,
} from "./session-review.js";

/**
 * 通常の集計から除く Hand（D116: Drill の Hand）。drills テーブルは #117 で作るので、今は空集合を渡す
 * （除外の口だけを通しておく。#117 で drills から作る）。
 */
const NO_EXCLUDED_HANDS: ReadonlySet<string> = new Set();

export interface LearningServiceOptions {
  readonly events: EventStore;
  /** Pass A の Review（reviews）。Pass B の Store は渡せない。 */
  readonly reviews: ScoreSource["reviews"];
  readonly heroId: string;
  readonly hypotheses: HypothesisSnapshotStore;
  readonly now?: () => Date;
}

/** Player Profile の応答。Hypothesis は Snapshot の行（作り直した時刻つき）。 */
export interface ProfileResponse {
  readonly profile: Omit<StructuredProfile, "hypotheses"> & {
    readonly hypotheses: readonly HypothesisSnapshot[];
  };
  /** Structured Profile からの決定論のテンプレート文（表示用の派生。LLM を呼ばない）。 */
  readonly text: string;
  /** Hero の Stats（全期間。他 Player の行は返さない）。 */
  readonly heroStats: {
    readonly version: string;
    readonly hands: number;
    readonly overall: StatTable | null;
  };
}

export class LearningService {
  private readonly now: () => Date;

  constructor(private readonly options: LearningServiceOptions) {
    this.now = options.now ?? (() => new Date());
  }

  /** handId の Hand が属する Session の Session Review。未知の Hand なら null。 */
  sessionReview(handId: string): SessionReview | null {
    const { events, reviews, heroId } = this.options;
    if (events.read(handId).length === 0) return null;
    const hands = events
      .sessionHandIds(handId)
      .map((id): SessionHandRecord | null => {
        const stored = events.read(id);
        const first = stored[0];
        const last = stored.at(-1);
        if (first === undefined || last === undefined) return null;
        return {
          handId: id,
          events: stored.map((s) => s.event),
          startedAt: first.recordedAt,
          endedAt: last.recordedAt,
        };
      })
      .filter((h): h is SessionHandRecord => h !== null);
    return computeSessionReview(hands, reviews, heroId, {
      excludeHandIds: NO_EXCLUDED_HANDS,
    });
  }

  /** Recent / Long-term の Player Profile（全期間の終わった Hand から）。Hypothesis の Snapshot も作り直す。 */
  profile(): ProfileResponse {
    const { events, reviews, heroId, hypotheses } = this.options;
    const hands = events
      .finishedHandIds()
      .map((id): readonly HandEvent[] => events.read(id).map((s) => s.event));
    const profile = computePlayerProfile(
      { hands, reviews, heroId },
      { excludeHandIds: NO_EXCLUDED_HANDS },
    );
    // Snapshot は Profile と同じ Evidence・同じ関数で作った Hypothesis で入れ替える（D113: 作り直せる派生データ）。
    const snapshot = hypotheses.replace(
      profile.hypotheses,
      this.now().toISOString(),
    );
    const stats = projectPlayerStats(hands, {
      excludeHandIds: NO_EXCLUDED_HANDS,
    });
    const hero = stats.players.find((p) => p.playerId === heroId);
    return {
      profile: { ...profile, hypotheses: snapshot },
      text: renderProfileText(profile),
      heroStats: {
        version: stats.version,
        hands: hero?.hands ?? 0,
        overall: hero?.overall ?? null,
      },
    };
  }
}
