// Session Review / Learning の画面（#116・docs/07 §2〜§6・docs/06 §14・D16・D32・D34・D49・D115）。Session の終わりに開く。
// - Decision Quality を主に置き、収支（実額が正本・BB は補助）は事実の欄に小さく置く（「負けたから下手」と読ませない）
// - Score は点数だけを出さず、Confidence・件数と「M 件中 N 件を Review 済み」を必ず添える。未 Review の判断をまとめて Review する
//   Button は置かない（D115）。Review は Strength / Leak・Important Hands の行から Hand の Review 画面を開いて 1 つずつ作る
// - Stats は Hero 自身の行だけ（他 Player の HUD を出さない。D32）。Hidden Persona・CPU の Private な状態・他者の札・Pass B は届かない
// - Recommended Drill は候補（Leak の最初の判断）から Targeted Drill を始める入口（#117）。Drill の結果は通常の Score と別の欄に出す（D105）
// - Learning Reset（#118・D114）の入口は Player Profile の下に置く。Reset 後は Score・弱点の仮説・まとめの文に区切りの時刻を添える
//   （Session Review と Stats は Reset の対象ではない）
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ACTION_TERMS, STREET_TERMS, termLabel } from "../lib/format.js";
import {
  ABILITY_TERMS,
  HYPOTHESIS_STATUS_LABELS,
  HYPOTHESIS_TYPE_LABELS,
  STAT_IDS,
  STAT_TERMS,
  TREND_LABELS,
  durationText,
  hypothesisTone,
  netText,
  resetSinceNote,
  sampleCaveat,
  scoreMeta,
  scoreText,
  statText,
} from "../lib/learning.js";
import { fetchDrills, type DrillResults } from "../lib/drill-api.js";
import { DRILL_VARIANT_LABELS } from "../lib/drill.js";
import {
  fetchProfile,
  fetchSessionReview,
  type AbilityScore,
  type HeroStats,
  type ProfileResponse,
  type ProfileWindow,
  type SessionDecisionRef,
  type SessionImportantHand,
  type SessionReview,
} from "../lib/learning-api.js";
import {
  ASSESSMENT_TERMS,
  IMPORTANT_SPOT_REASON_LABELS,
  assessmentTone,
} from "../lib/review.js";
import type { Assessment } from "../lib/review-api.js";
import { useShowBB } from "./BbDisplay.js";
import { LearningReset } from "./LearningReset.js";
import { PlayingCard } from "./PlayingCard.js";

/** Hand の Review を開く（decisionIndex を渡すとその判断の Review）。 */
type OpenReview = (handId: string, decisionIndex: number | null) => void;

/** 元の判断から Targeted Drill を始める（#117）。 */
type StartDrill = (handId: string, decisionIndex: number) => void;

interface SessionReviewScreenProps {
  /** Session の Hand（どれでもよい。終わった Session の最後の Hand を渡す）。 */
  readonly handId: string;
  readonly onOpenReview: OpenReview;
  readonly onStartDrill: StartDrill;
}

type Load<T> =
  | { readonly state: "loading" }
  | { readonly state: "failed" }
  | { readonly state: "ready"; readonly value: T };

/** 読み込みと読み直し。load（呼び出し側で固定した関数）が変わったら前の応答は捨てる。 */
function useLoad<T>(load: () => Promise<T>): readonly [Load<T>, () => void] {
  const [state, setState] = useState<Load<T>>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let current = true;
    load().then(
      (value) => {
        if (current) setState({ state: "ready", value });
      },
      () => {
        if (current) setState({ state: "failed" });
      },
    );
    return () => {
      current = false;
    };
  }, [load, attempt]);
  const retry = useCallback(() => {
    setState({ state: "loading" });
    setAttempt((n) => n + 1);
  }, []);
  return [state, retry];
}

export function SessionReviewScreen({
  handId,
  onOpenReview,
  onStartDrill,
}: SessionReviewScreenProps) {
  const loadSession = useCallback(() => fetchSessionReview(handId), [handId]);
  const [session, retrySession] = useLoad(loadSession);
  const [profile, retryProfile] = useLoad(fetchProfile);
  const [drills, retryDrills] = useLoad(fetchDrills);
  return (
    <main className="review learning">
      <div className="review__head">
        <h2 className="review__title">Session の振り返り（Session Review）</h2>
      </div>
      {session.state === "ready" ? (
        <SessionReviewBody
          review={session.value}
          onOpenReview={onOpenReview}
          onStartDrill={onStartDrill}
        />
      ) : (
        <LoadState
          load={session}
          what="Session の振り返り"
          onRetry={retrySession}
        />
      )}
      <section className="review-section" aria-labelledby="learning-drills">
        <h3 className="review-section__title" id="learning-drills">
          Drill の結果（通常の Score と別に数えます）
        </h3>
        {drills.state === "ready" ? (
          <DrillResultsBody
            results={drills.value}
            onOpenReview={onOpenReview}
          />
        ) : (
          <LoadState load={drills} what="Drill の結果" onRetry={retryDrills} />
        )}
      </section>
      <section className="review-section" aria-labelledby="learning-profile">
        <h3 className="review-section__title" id="learning-profile">
          Player Profile（直近 / 全期間）
        </h3>
        {profile.state === "ready" ? (
          <ProfileBody response={profile.value} />
        ) : (
          <LoadState
            load={profile}
            what="Player Profile"
            onRetry={retryProfile}
          />
        )}
      </section>
      <LearningReset
        resets={profile.state === "ready" ? profile.value.resets : null}
        onDone={() => {
          retryProfile();
          retryDrills();
        }}
      />
    </main>
  );
}

function LoadState({
  load,
  what,
  onRetry,
}: {
  readonly load: Load<unknown>;
  readonly what: string;
  readonly onRetry: () => void;
}) {
  if (load.state === "loading") {
    return <p className="evidence__muted">読み込んでいます…</p>;
  }
  return (
    <div className="notice" role="status">
      <p>{what}を読み込めませんでした。</p>
      <button
        type="button"
        className="btn btn--secondary btn--sm"
        onClick={onRetry}
      >
        読み込み直す
      </button>
    </div>
  );
}

/** Session Review の本体（静的な描画のテストのために分ける）。 */
export function SessionReviewBody({
  review,
  onOpenReview,
  onStartDrill,
}: {
  readonly review: SessionReview;
  readonly onOpenReview: OpenReview;
  readonly onStartDrill: StartDrill;
}) {
  const dq = review.decisionQuality;
  return (
    <>
      <DecisionQuality review={review} />
      <SessionFacts review={review} />
      <section className="review-section" aria-labelledby="learning-ability">
        <h3 className="review-section__title" id="learning-ability">
          Ability ごとの Score（この Session）
        </h3>
        <ScoreRows abilities={review.abilities} />
      </section>
      <div className="learning-split">
        <DecisionList
          id="learning-strength"
          title="良かった判断（Strength）"
          empty={
            dq.reviewed === 0
              ? "Review 済みの判断がまだありません。"
              : "「良い判断」と評価された判断はまだありません。"
          }
          decisions={review.strengths}
          onOpenReview={onOpenReview}
        />
        <DecisionList
          id="learning-leak"
          title="改善の余地がある判断（Leak）"
          empty={
            dq.reviewed === 0
              ? "Review 済みの判断がまだありません。"
              : "改善が提案された判断はありません。"
          }
          decisions={review.leaks}
          onOpenReview={onOpenReview}
        />
      </div>
      <ImportantHands
        hands={review.importantHands}
        onOpenReview={onOpenReview}
      />
      <section className="review-section" aria-labelledby="learning-stats">
        <h3 className="review-section__title" id="learning-stats">
          Hero の Stats（この Session）
        </h3>
        <StatsRows stats={review.heroStats} />
      </section>
      <RecommendedDrill
        drill={review.recommendedDrill}
        onStartDrill={onStartDrill}
      />
    </>
  );
}

/** Decision Quality Summary（主）。M 件中 N 件・Overall の点数と確度・段階評価の内訳・件数の注意。 */
function DecisionQuality({ review }: { readonly review: SessionReview }) {
  const dq = review.decisionQuality;
  const counted = (Object.keys(dq.assessments) as Assessment[]).filter(
    (a) => dq.assessments[a] > 0,
  );
  return (
    <section
      className="learning-card learning-card--primary"
      aria-labelledby="learning-dq"
    >
      <h3 className="review-section__title" id="learning-dq">
        判断の質（Decision Quality）
      </h3>
      <p className="learning-count">
        この Session の判断 {dq.total} 件中 {dq.reviewed} 件を Review 済み
      </p>
      <div className="learning-score">
        <span className="learning-score__value">{scoreText(dq.overall)}</span>
        {dq.overall.score !== null && (
          <span className="learning-score__meta">{scoreMeta(dq.overall)}</span>
        )}
      </div>
      {counted.length > 0 && (
        <ul className="learning-dist" aria-label="段階評価の内訳">
          {counted.map((a) => (
            <li
              key={a}
              className={`learning-chip assessment--${assessmentTone(a)}`}
            >
              {termLabel(ASSESSMENT_TERMS[a])} {dq.assessments[a]} 件
            </li>
          ))}
        </ul>
      )}
      <p className="review-section__note">
        {sampleCaveat(dq.reviewed, dq.total, dq.overall.confidence)}
      </p>
      <p className="review-section__note">
        Score は Review 済みの判断だけで数えます（Live Mechanics
        は含めません）。まだ Review していない判断は、下の判断・Hand から Review
        の画面を開いて 1 つずつ作れます。
      </p>
    </section>
  );
}

/** Hands・Duration・収支（実額が正本・BB は補助。D49）。収支は判断の質と別に見る。 */
function SessionFacts({ review }: { readonly review: SessionReview }) {
  const showBB = useShowBB();
  return (
    <section className="learning-facts" aria-label="この Session の記録">
      <dl className="learning-facts__list">
        <div className="learning-fact">
          <dt>Hand 数（Hands）</dt>
          <dd>{review.hands}</dd>
        </div>
        <div className="learning-fact">
          <dt>時間（Duration）</dt>
          <dd>{durationText(review.durationMs)}</dd>
        </div>
        <div className="learning-fact">
          <dt>収支</dt>
          <dd>
            {review.bigBlind === null
              ? "—"
              : netText(review.heroNet, review.bigBlind, showBB)}
          </dd>
        </div>
      </dl>
      <p className="review-section__note">
        収支は短期の結果で、運（Variance）を含みます。上手・下手は収支ではなく、判断の質で見ます。
      </p>
    </section>
  );
}

/** Ability ごとの Score（点数・確度・件数・傾向を 1 行に）。 */
function ScoreRows({
  abilities,
}: {
  readonly abilities: readonly AbilityScore[];
}) {
  return (
    <ul className="learning-rows">
      {abilities.map((a) => (
        <li key={a.ability} className="learning-row">
          <span className="learning-row__name">
            {termLabel(ABILITY_TERMS[a.ability])}
            {a.ability === "live_mechanics" && (
              <span className="learning-row__meta">
                Poker の判断とは別の Score
              </span>
            )}
          </span>
          <span className="learning-row__value">
            <span>{a.score === null ? "—" : `${a.score} 点`}</span>
            <span className="learning-row__meta">
              {scoreMeta(a)}・傾向 {TREND_LABELS[a.trend.direction]}
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Strength / Leak の判断の一覧。行から、その判断の Review を開く。 */
function DecisionList({
  id,
  title,
  empty,
  decisions,
  onOpenReview,
}: {
  readonly id: string;
  readonly title: string;
  readonly empty: string;
  readonly decisions: readonly SessionDecisionRef[];
  readonly onOpenReview: OpenReview;
}) {
  return (
    <section className="review-section" aria-labelledby={id}>
      <h3 className="review-section__title" id={id}>
        {title}
      </h3>
      {decisions.length === 0 ? (
        <p className="evidence__muted">{empty}</p>
      ) : (
        <ul className="spot-list">
          {decisions.map((d) => (
            <li key={`${d.handId}:${d.decisionIndex}`}>
              <button
                type="button"
                className="spot-row"
                onClick={() => onOpenReview(d.handId, d.decisionIndex)}
              >
                <span className="spot-row__street">
                  Hand {d.handNumber}・{termLabel(STREET_TERMS[d.street])}
                </span>
                <span className="spot-row__main">
                  <span className="spot-row__action">
                    {termLabel(ACTION_TERMS[d.action])}
                  </span>
                </span>
                <span
                  className={`spot-row__state assessment assessment--${assessmentTone(d.assessment)}`}
                >
                  {ASSESSMENT_TERMS[d.assessment].ja}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Important Hands（判断時点の情報で選んだ Important Spot と、段階評価で選ぶ。結果は出さない）。 */
function ImportantHands({
  hands,
  onOpenReview,
}: {
  readonly hands: readonly SessionImportantHand[];
  readonly onOpenReview: OpenReview;
}) {
  return (
    <section className="review-section" aria-labelledby="learning-hands">
      <h3 className="review-section__title" id="learning-hands">
        見直したい Hand（Important Hands）
      </h3>
      <p className="review-section__note">
        判断した時点の情報で選んだ Important Spot と、改善の余地がある判断を含む
        Hand です。勝ち負けでは選んでいません。
      </p>
      {hands.length === 0 ? (
        <p className="evidence__muted">見直したい Hand はありません。</p>
      ) : (
        <ul className="spot-list">
          {hands.map((h) => (
            <li key={h.handId}>
              <button
                type="button"
                className="spot-row"
                onClick={() => onOpenReview(h.handId, null)}
              >
                <span className="spot-row__street">Hand {h.handNumber}</span>
                <span className="spot-row__main">
                  {h.heroHoleCards !== null && (
                    <span className="evidence-cards__row">
                      {h.heroHoleCards.map((card, i) => (
                        <PlayingCard key={i} card={card} size="sm" />
                      ))}
                    </span>
                  )}
                  <span className="spot-row__reasons">
                    {h.reasons.map((r) => (
                      <span key={r} className="badge">
                        {IMPORTANT_SPOT_REASON_LABELS[r]}
                      </span>
                    ))}
                    {h.leakCount > 0 && (
                      <span className="badge">改善の余地 {h.leakCount}</span>
                    )}
                  </span>
                </span>
                <span className="spot-row__state">
                  Review 済み {h.decisions.reviewed} / {h.decisions.total}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Hero 自身の Stats。分子 / 分母を必ず出す。 */
function StatsRows({ stats }: { readonly stats: HeroStats }) {
  const overall = stats.overall;
  if (overall === null || stats.hands === 0) {
    return (
      <p className="evidence__muted">数えられる Hand がまだありません。</p>
    );
  }
  return (
    <>
      <ul className="learning-rows">
        {STAT_IDS.map((id) => (
          <li key={id} className="learning-row">
            <span className="learning-row__name">
              {termLabel(STAT_TERMS[id])}
            </span>
            <span className="learning-row__value">
              {statText(id, overall[id])}
            </span>
          </li>
        ))}
      </ul>
      <p className="review-section__note">
        {stats.hands} Hand から数えた Hero 自身の統計です（Play
        中には出しません）。件数が少ないうちは割合が大きく揺れます。
      </p>
    </>
  );
}

/**
 * Recommended Drill の入口（#117）。候補（Leak の最初の判断）から、一要素だけ変えた類題（Targeted Drill）を始める。
 * Drill の Hand の結果は通常の Score と別に数える（D105）。
 */
function RecommendedDrill({
  drill,
  onStartDrill,
}: {
  readonly drill: SessionReview["recommendedDrill"];
  readonly onStartDrill: StartDrill;
}) {
  const c = drill.candidate;
  return (
    <section className="learning-card" aria-labelledby="learning-drill">
      <h3 className="review-section__title" id="learning-drill">
        おすすめの練習（Recommended Drill）
      </h3>
      <p className="review-section__note">
        {c === null
          ? "改善の余地がある判断が見つかると、ここに練習の候補を出します。"
          : `候補: Hand ${c.handNumber} の${STREET_TERMS[c.street].ja}の判断（${ASSESSMENT_TERMS[c.assessment].ja}）`}
      </p>
      <div>
        <button
          type="button"
          className="btn btn--secondary btn--sm"
          disabled={!drill.available || c === null}
          onClick={() => {
            if (c !== null) onStartDrill(c.handId, c.decisionIndex);
          }}
        >
          Drill を始める
        </button>
      </div>
      <p className="review-section__note">
        元の判断から Stack・Bet
        の額・相手の傾向のどれか一つだけを変えた類題を、1 Hand
        遊びます。結果は通常の Score に混ぜません。
      </p>
    </section>
  );
}

/** Drill の結果（通常の Score と別の系列。D105）。練習した判断の Review の数と点数、Drill ごとの行。 */
export function DrillResultsBody({
  results,
  onOpenReview,
}: {
  readonly results: DrillResults;
  readonly onOpenReview: OpenReview;
}) {
  const { score } = results;
  const finished = results.drills.filter((d) => d.finished);
  if (finished.length === 0) {
    return <p className="evidence__muted">終わった Drill はまだありません。</p>;
  }
  const since = resetSinceNote(score.since);
  return (
    <div className="learning-card">
      <p className="learning-count">
        練習した判断 {score.decisions.total} 件中 {score.decisions.reviewed}{" "}
        件を Review 済み
      </p>
      {since !== null && <p className="review-section__note">{since}</p>}
      <div className="learning-score">
        <span className="learning-score__value">
          {scoreText(score.overall)}
        </span>
        {score.overall.score !== null && (
          <span className="learning-score__meta">
            {scoreMeta(score.overall)}
          </span>
        )}
      </div>
      <ul className="spot-list">
        {[...finished].reverse().map((d) => (
          <li key={d.drillId}>
            <button
              type="button"
              className="spot-row"
              onClick={() => onOpenReview(d.drillHandId, d.decisionIndex)}
            >
              <span className="spot-row__street">
                {DRILL_VARIANT_LABELS[d.variant.kind]}
              </span>
              <span className="spot-row__main">練習した判断の Review</span>
              <span
                className={`spot-row__state${d.assessment === null ? "" : ` assessment assessment--${assessmentTone(d.assessment)}`}`}
              >
                {d.assessment === null
                  ? "未 Review"
                  : ASSESSMENT_TERMS[d.assessment].ja}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

type ProfileTab = "recent" | "longTerm";

/** Player Profile の本体（直近 / 全期間の切り替え・Weakness Hypothesis・全期間の Stats）。 */
export function ProfileBody({
  response,
  initialTab = "recent",
}: {
  readonly response: ProfileResponse;
  readonly initialTab?: ProfileTab;
}) {
  const [tab, setTab] = useState<ProfileTab>(initialTab);
  const { profile } = response;
  const shown: ProfileWindow =
    tab === "recent" ? profile.recent : profile.longTerm;
  // Learning Reset（D114）の後は、カテゴリごとに Reset より後に終わった Hand から数える。
  const scoreSince = resetSinceNote(response.resets.score);
  const hypothesisSince = resetSinceNote(response.resets.hypothesis);
  const textSince = resetSinceNote(response.resets.profile);
  return (
    <>
      <p className="learning-count">
        {scoreSince === null ? "全期間" : "Reset 後"}の判断{" "}
        {profile.decisions.total} 件中 {profile.decisions.reviewed} 件を Review
        済み
      </p>
      {scoreSince !== null && (
        <p className="review-section__note">{scoreSince}</p>
      )}
      <div className="pass-tabs" role="group" aria-label="期間">
        <TabButton active={tab === "recent"} onClick={() => setTab("recent")}>
          直近 {profile.recent.window} 件（Recent）
        </TabButton>
        <TabButton
          active={tab === "longTerm"}
          onClick={() => setTab("longTerm")}
        >
          {scoreSince === null ? "全期間" : "Reset 後"}（Long-term）
        </TabButton>
      </div>
      <div className="learning-card">
        <p className="learning-count">
          {tab === "recent"
            ? `直近の Review 済みの判断 ${shown.reviewed} 件`
            : `Review 済みの判断 ${shown.reviewed} 件`}
        </p>
        <div className="learning-score">
          <span className="learning-score__value">
            {scoreText(shown.overall)}
          </span>
          {shown.overall.score !== null && (
            <span className="learning-score__meta">
              {scoreMeta(shown.overall)}
            </span>
          )}
        </div>
        <ScoreRows abilities={shown.abilities} />
      </div>
      <section className="review-section" aria-labelledby="learning-hypo">
        <h4 className="review-section__title" id="learning-hypo">
          弱点の仮説（Weakness Hypothesis・
          {hypothesisSince === null ? "全期間" : "Reset 後"}）
        </h4>
        {hypothesisSince !== null && (
          <p className="review-section__note">{hypothesisSince}</p>
        )}
        {profile.hypotheses.length === 0 ? (
          <p className="evidence__muted">
            弱点の仮説はまだありません（改善の余地がある判断が Review
            されると作られます）。
          </p>
        ) : (
          <ul className="learning-rows">
            {profile.hypotheses.map((h) => (
              <li key={h.hypothesisId} className="learning-row">
                <span className="learning-row__name">
                  {HYPOTHESIS_TYPE_LABELS[h.type]}
                </span>
                <span className="learning-row__value">
                  <span
                    className={`assessment assessment--${hypothesisTone(h.status)}`}
                  >
                    {HYPOTHESIS_STATUS_LABELS[h.status]}
                  </span>
                  <span className="learning-row__meta">
                    支持 {h.supportingEvidenceIds.length} 件・反証{" "}
                    {h.counterEvidenceIds.length} 件
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="review-section" aria-labelledby="learning-text">
        <h4 className="review-section__title" id="learning-text">
          まとめ
        </h4>
        {textSince !== null && (
          <p className="review-section__note">{textSince}</p>
        )}
        <p className="learning-text">{response.text}</p>
      </section>
      <section className="review-section" aria-labelledby="learning-stats-all">
        <h4 className="review-section__title" id="learning-stats-all">
          Hero の Stats（全期間）
        </h4>
        <StatsRows stats={response.heroStats} />
      </section>
    </>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  readonly active: boolean;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="pass-tab pass-tab--decision"
      aria-pressed={active}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
