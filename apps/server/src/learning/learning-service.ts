// Learning の読み出し（#116・docs/07 §4〜§6・D111・D115・D116）。Session Review と Recent / Long-term の Player Profile を、
// Event Log（正本）と Pass A の reviews から都度計算して返す（Score・Stats・Profile は保存しない。D111）。
// - Review を作らない（D115: 自動・一括の Review をしない。課金の経路を増やさない）。読むのは Pass A の reviews だけで、
//   Pass B（reveal_reviews）は受け取らない
// - Hypothesis は #114 の Snapshot（reviews から作り直せる派生データ。D113）を、Profile を読むたびに同じ Evidence から入れ替えて返す。
//   正本（Event Log・reviews）は書き換えない
// - Stats は Hero の行だけを返す（他 Player の詳細 HUD を出さない。D32）
// - Learning Reset（D114・#118）: Score / Hypothesis / 自然言語の Profile は、それぞれのカテゴリの最後の Reset より後に終わった Hand の
//   Evidence だけで計算する（learning-reset.ts）。Stats と Session Review（1 Session の振り返り）は Reset の対象にしない
// ユーザーの弱点なので、CPU の KnowledgeState・Prompt・CPU Memory へは渡さない（不変条件 2）。
import { projectPlayerStats, type StatTable } from "@proj-poker/engine";
import type { EventStore, StoredHandEvent } from "../event-store.js";
import type { ScoreSource } from "./ability-evidence.js";
import type {
  HypothesisSnapshot,
  HypothesisSnapshotStore,
} from "./hypothesis-snapshot.js";
import {
  endedAfter,
  type LearningResetCategory,
  type LearningResetRecord,
  type LearningResetStore,
  type ResetBoundaries,
} from "./learning-reset.js";
import {
  computePlayerProfile,
  DEFAULT_PROFILE_POLICY,
  renderProfileText,
  type ProfilePolicy,
  type StructuredProfile,
} from "./profile.js";
import {
  computeSessionReview,
  type SessionHandRecord,
  type SessionReview,
} from "./session-review.js";

export interface LearningServiceOptions {
  readonly events: EventStore;
  /** Pass A の Review（reviews）。Pass B の Store は渡せない。 */
  readonly reviews: ScoreSource["reviews"];
  readonly heroId: string;
  readonly hypotheses: HypothesisSnapshotStore;
  /** Learning Reset の区切り（D114。v8 の learning_resets）。 */
  readonly resets: LearningResetStore;
  /** 通常の集計から除く Hand（D116: Drill の Hand。drills テーブルから作る）。省略時は空。 */
  readonly excludeHandIds?: () => ReadonlySet<string>;
  /** Profile・Hypothesis・Score の Policy。省略時は既定の Version。変えても正本（Event Log・reviews）から計算し直す。 */
  readonly policy?: ProfilePolicy;
  readonly now?: () => Date;
}

/**
 * Player Profile の応答。Hypothesis は Snapshot の行（作り直した時刻つき）。
 * decisions・recent・longTerm は score の区切りより後、hypotheses は hypothesis の区切りより後、text は profile の区切りより後の
 * Evidence から作る（D114）。
 */
export interface ProfileResponse {
  readonly profile: Omit<StructuredProfile, "hypotheses"> & {
    readonly hypotheses: readonly HypothesisSnapshot[];
  };
  /** Structured Profile からの決定論のテンプレート文（表示用の派生。LLM を呼ばない）。 */
  readonly text: string;
  /** カテゴリごとの最後の Learning Reset の時刻（無ければ null。D114）。 */
  readonly resets: ResetBoundaries;
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

  /** 通常の集計から除く Hand（Drill の Hand）。読むたびに drills から作る。 */
  private excluded(): ReadonlySet<string> {
    return this.options.excludeHandIds?.() ?? new Set();
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
      excludeHandIds: this.excluded(),
    });
  }

  /**
   * Recent / Long-term の Player Profile（終わった Hand から）。Hypothesis の Snapshot も作り直す。
   * Score・Hypothesis・自然言語の Profile はカテゴリごとの Learning Reset より後の Hand だけ、Stats は全期間（D114）。
   */
  profile(): ProfileResponse {
    const { heroId, resets } = this.options;
    const policy = this.options.policy ?? DEFAULT_PROFILE_POLICY;
    const excludeHandIds = this.excluded();
    const stored = this.finishedHands();
    const boundaries = resets.boundaries();
    // 同じ Event Log・同じ reviews から、カテゴリの区切りごとに Structured Profile を作る（過去の結果・文を入力にしない）。
    const since = (category: LearningResetCategory) =>
      this.structured(stored, boundaries[category], policy, excludeHandIds);
    const scored = since("score");
    const hypotheses = this.replaceSnapshot(since("hypothesis").hypotheses);
    const stats = projectPlayerStats(
      stored.map((s) => s.map((e) => e.event)),
      { excludeHandIds },
    );
    const hero = stats.players.find((p) => p.playerId === heroId);
    return {
      profile: { ...scored, hypotheses },
      // 文の Long-term の呼び名も、profile の区切りがあれば「Reset 後」にする（画面の注記と食い違わせない）。
      text: renderProfileText(since("profile"), {
        afterReset: boundaries.profile !== null,
      }),
      resets: boundaries,
      heroStats: {
        version: stats.version,
        hands: hero?.hands ?? 0,
        overall: hero?.overall ?? null,
      },
    };
  }

  /**
   * Learning Reset（D114）。区切りの行を足し、Hypothesis の Snapshot をその区切りで作り直す。
   * Event Log・reviews・User Read / Note / Tag・Stats は変えない（正本を消さない）。
   */
  reset(categories: readonly LearningResetCategory[]): {
    readonly reset: LearningResetRecord;
    readonly resets: ResetBoundaries;
  } {
    const { resets } = this.options;
    const reset = resets.add(categories);
    const boundaries = resets.boundaries();
    if (reset.categories.includes("hypothesis")) {
      const policy = this.options.policy ?? DEFAULT_PROFILE_POLICY;
      this.replaceSnapshot(
        this.structured(
          this.finishedHands(),
          boundaries.hypothesis,
          policy,
          this.excluded(),
        ).hypotheses,
      );
    }
    return { reset, resets: boundaries };
  }

  /** 終わった Hand の保存済みの Event（開始の古い順）。 */
  private finishedHands(): readonly (readonly StoredHandEvent[])[] {
    const { events } = this.options;
    return events.finishedHandIds().map((id) => events.read(id));
  }

  /** 区切り（since）より後に終わった Hand だけで Structured Profile を作る。 */
  private structured(
    stored: readonly (readonly StoredHandEvent[])[],
    since: string | null,
    policy: ProfilePolicy,
    excludeHandIds: ReadonlySet<string>,
  ): StructuredProfile {
    const { reviews, heroId } = this.options;
    const hands = stored
      .filter((s) => endedAfter(s, since))
      .map((s) => s.map((e) => e.event));
    return computePlayerProfile(
      { hands, reviews, heroId },
      { excludeHandIds, policy },
    );
  }

  /** Snapshot は同じ Evidence・同じ関数で作った Hypothesis で全行入れ替える（D113: 作り直せる派生データ）。 */
  private replaceSnapshot(
    hypotheses: StructuredProfile["hypotheses"],
  ): readonly HypothesisSnapshot[] {
    return this.options.hypotheses.replace(
      hypotheses,
      this.now().toISOString(),
    );
  }
}
