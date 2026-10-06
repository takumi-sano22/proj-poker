// Hand Review の画面（#84・D04・D05・D93・docs/06 §10）。保存済みの Hand の Hero の判断を選び、判断ごとに Review を見る。
// 一覧は Important Spot（判断時点の情報だけから選ばれた要点。#78）を先に並べ、ほかの判断も選べるようにする（要点先行・D04）。
// 判断を選ぶと、判断時点の Review（Pass A）と Hand 後の答え合わせ（Pass B）を別のタブで見せる。Pass A の側には
// Hand 後の情報（相手の実際の札・結果）を出さない（不変条件 3）。一覧にも Hand の結果は出さない。
// Replay（#68）の判断時点の step へ移れる（Jump to Important Spot の Review 側の入口）。
import { useCallback, useEffect, useState } from "react";
import { usePolled } from "../hooks/usePolled.js";
import {
  fetchReplayHand,
  type ReplayDecision,
  type ReplayHand,
  type ReplayImportantSpot,
} from "../lib/api.js";
import { STREET_TERMS, termLabel } from "../lib/format.js";
import { unfinishedLabel } from "../lib/replay.js";
import {
  ASSESSMENT_TERMS,
  IMPORTANT_SPOT_REASON_LABELS,
  assessmentTone,
  decisionLabel,
} from "../lib/review.js";
import { passPath, type ReviewStatus } from "../lib/review-api.js";
import { heroSeatOf } from "../lib/view-model.js";
import { PlayingCard } from "./PlayingCard.js";
import { DecisionReviewPanel, RevealReviewPanel } from "./ReviewPass.js";

interface ReviewScreenProps {
  readonly handId: string;
  /** 最初に開く判断（null は一覧）。 */
  readonly initialDecision: number | null;
  /** Replay の指定の step を開く。 */
  readonly onOpenReplay: (handId: string, step: number) => void;
}

type Load =
  | { readonly state: "loading" }
  | { readonly state: "failed" }
  | { readonly state: "ready"; readonly hand: ReplayHand };

export function ReviewScreen({
  handId,
  initialDecision,
  onOpenReplay,
}: ReviewScreenProps) {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [selected, setSelected] = useState<number | null>(initialDecision);

  // Hand（判断の一覧と Important Spot・判断時点の step）を読む。Hand が変わったら前の応答は捨てる。
  useEffect(() => {
    let current = true;
    fetchReplayHand(handId).then(
      (hand) => {
        if (current) setLoad({ state: "ready", hand });
      },
      () => {
        if (current) setLoad({ state: "failed" });
      },
    );
    return () => {
      current = false;
    };
  }, [handId, attempt]);

  const retry = useCallback(() => {
    setLoad({ state: "loading" });
    setAttempt((n) => n + 1);
  }, []);

  if (load.state !== "ready") {
    return (
      <main className="review">
        <h2 className="review__title">Hand Review</h2>
        {load.state === "loading" ? (
          <p className="evidence__muted">読み込んでいます…</p>
        ) : (
          <div className="notice" role="status">
            <p>Hand を読み込めませんでした。</p>
            <button
              type="button"
              className="btn btn--secondary btn--sm"
              onClick={retry}
            >
              読み込み直す
            </button>
          </div>
        )}
      </main>
    );
  }

  const hand = load.hand;
  const decision =
    selected === null
      ? undefined
      : hand.decisions.find((d) => d.decisionIndex === selected);
  return decision === undefined ? (
    <ReviewOverview
      hand={hand}
      onSelect={setSelected}
      onOpenReplay={onOpenReplay}
    />
  ) : (
    <SpotDetail
      key={decision.decisionIndex}
      hand={hand}
      decision={decision}
      spot={hand.importantSpots.find(
        (s) => s.decisionIndex === decision.decisionIndex,
      )}
      onBack={() => setSelected(null)}
      onOpenReplay={onOpenReplay}
    />
  );
}

/** Review できる Hand か（終わった Hand と、AI 障害の後に打ち切った Hand。サーバーと同じ条件）。 */
function reviewable(hand: ReplayHand): boolean {
  return hand.complete || hand.aborted;
}

function useNameOf(hand: ReplayHand) {
  return useCallback(
    (playerId: string) =>
      hand.players.find((p) => p.playerId === playerId)?.displayName ??
      playerId,
    [hand.players],
  );
}

/** 一覧（要点先行）: Important Spot を先に、ほかの判断を後に並べる。Hand の結果は出さない。 */
function ReviewOverview({
  hand,
  onSelect,
  onOpenReplay,
}: {
  readonly hand: ReplayHand;
  readonly onSelect: (decisionIndex: number) => void;
  readonly onOpenReplay: (handId: string, step: number) => void;
}) {
  // Hero の札は最初の step 以降で変わらない（Hero 自身の札だけ）。最初に札が見える step から取る。
  const heroCards =
    hand.steps
      .map((s) => heroSeatOf(s)?.holeCards ?? null)
      .find((c) => c !== null) ?? null;
  const spotOf = (d: ReplayDecision) =>
    hand.importantSpots.find((s) => s.decisionIndex === d.decisionIndex);
  const important = hand.decisions.filter((d) => spotOf(d) !== undefined);
  const others = hand.decisions.filter((d) => spotOf(d) === undefined);
  const canReview = reviewable(hand);

  return (
    <main className="review">
      <div className="review__head">
        <h2 className="review__title">Hand Review</h2>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() => onOpenReplay(hand.handId, 0)}
        >
          Replay で最初から見る
        </button>
      </div>
      {heroCards !== null && (
        <div className="review__hero">
          <span className="evidence-cards__label">Hero の札</span>
          <span className="evidence-cards__row">
            {heroCards.map((card, i) => (
              <PlayingCard key={i} card={card} size="sm" />
            ))}
          </span>
        </div>
      )}
      {!canReview && (
        <p className="notice" role="status">
          この Hand は終わっていない（{unfinishedLabel(hand)}）ため、Review
          を作れません。
        </p>
      )}
      {hand.decisions.length === 0 ? (
        <p className="evidence__muted">
          この Hand には Hero の判断がありません（Hero
          の手番が来る前に終わりました）。
        </p>
      ) : (
        <>
          <section className="review-section">
            <h3 className="review-section__title">Important Spot</h3>
            <p className="review-section__note">
              判断した時点の情報だけで選んだ、見直す価値の高い判断です。
            </p>
            {important.length === 0 ? (
              <p className="evidence__muted">
                この Hand には Important Spot
                がありません。下の判断から選べます。
              </p>
            ) : (
              <ul className="spot-list">
                {important.map((d) => (
                  <SpotRow
                    key={d.decisionIndex}
                    hand={hand}
                    decision={d}
                    spot={spotOf(d)}
                    canReview={canReview}
                    onSelect={onSelect}
                  />
                ))}
              </ul>
            )}
          </section>
          {others.length > 0 && (
            <section className="review-section">
              <h3 className="review-section__title">ほかの判断</h3>
              <ul className="spot-list">
                {others.map((d) => (
                  <SpotRow
                    key={d.decisionIndex}
                    hand={hand}
                    decision={d}
                    spot={undefined}
                    canReview={canReview}
                    onSelect={onSelect}
                  />
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </main>
  );
}

/** 一覧の 1 行（判断 1 つ）。Street・Hero の選択・Important Spot の理由と、Review の状態（段階評価・作成中・未作成）。 */
function SpotRow({
  hand,
  decision,
  spot,
  canReview,
  onSelect,
}: {
  readonly hand: ReplayHand;
  readonly decision: ReplayDecision;
  readonly spot: ReplayImportantSpot | undefined;
  readonly canReview: boolean;
  readonly onSelect: (decisionIndex: number) => void;
}) {
  return (
    <li>
      <button
        type="button"
        className="spot-row"
        onClick={() => onSelect(decision.decisionIndex)}
      >
        <span className="spot-row__street">
          {termLabel(STREET_TERMS[decision.street])}
        </span>
        <span className="spot-row__main">
          <span className="spot-row__action">{decisionLabel(decision)}</span>
          {spot !== undefined && <ReasonTags reasons={spot.reasons} />}
        </span>
        {canReview && (
          <ReviewState
            handId={hand.handId}
            decisionIndex={decision.decisionIndex}
          />
        )}
      </button>
    </li>
  );
}

function ReasonTags({
  reasons,
}: {
  readonly reasons: ReplayImportantSpot["reasons"];
}) {
  return (
    <span className="spot-row__reasons">
      {reasons.map((r) => (
        <span key={r} className="badge">
          {IMPORTANT_SPOT_REASON_LABELS[r]}
        </span>
      ))}
    </span>
  );
}

/** 一覧の行の Review の状態（Pass A の最新の段階評価）。待ちの間は読み直す。 */
function ReviewState({
  handId,
  decisionIndex,
}: {
  readonly handId: string;
  readonly decisionIndex: number;
}) {
  const { data } = usePolled<ReviewStatus>(
    passPath(handId, decisionIndex, "decision"),
  );
  if (data === null) return <span className="spot-row__state" />;
  if (data.generation.state === "pending") {
    return <span className="spot-row__state">作成中…</span>;
  }
  if (data.latest === null) {
    return <span className="spot-row__state">Review 未作成</span>;
  }
  const a = data.latest.assessment;
  return (
    <span
      className={`spot-row__state assessment assessment--${assessmentTone(a)}`}
    >
      {ASSESSMENT_TERMS[a].ja}
    </span>
  );
}

/** 判断 1 つの Review。判断時点の Review（Pass A）と Hand 後の答え合わせ（Pass B）をタブで分ける。 */
function SpotDetail({
  hand,
  decision,
  spot,
  onBack,
  onOpenReplay,
}: {
  readonly hand: ReplayHand;
  readonly decision: ReplayDecision;
  readonly spot: ReplayImportantSpot | undefined;
  readonly onBack: () => void;
  readonly onOpenReplay: (handId: string, step: number) => void;
}) {
  const nameOf = useNameOf(hand);
  const [pass, setPass] = useState<"decision" | "reveal">("decision");
  const canReview = reviewable(hand);
  return (
    <main className="review">
      <div className="review__head">
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={onBack}
        >
          判断の一覧へ
        </button>
        <button
          type="button"
          className="btn btn--secondary btn--sm"
          onClick={() => onOpenReplay(hand.handId, decision.stepIndex)}
        >
          Replay でこの場面を見る
        </button>
      </div>
      <div className="spot-head">
        <h2 className="review__title">
          {termLabel(STREET_TERMS[decision.street])}・{decisionLabel(decision)}
        </h2>
        {spot !== undefined && <ReasonTags reasons={spot.reasons} />}
      </div>
      {!canReview ? (
        <p className="notice" role="status">
          この Hand は終わっていないため、Review を作れません。
        </p>
      ) : (
        <>
          <div className="pass-tabs" role="group" aria-label="Review の種類">
            <button
              type="button"
              className="pass-tab pass-tab--decision"
              aria-pressed={pass === "decision"}
              onClick={() => setPass("decision")}
            >
              判断時点の Review
            </button>
            <button
              type="button"
              className="pass-tab pass-tab--reveal"
              aria-pressed={pass === "reveal"}
              onClick={() => setPass("reveal")}
            >
              Hand 後の答え合わせ
            </button>
          </div>
          {pass === "decision" ? (
            <DecisionReviewPanel
              handId={hand.handId}
              decisionIndex={decision.decisionIndex}
              nameOf={nameOf}
            />
          ) : (
            <RevealReviewPanel
              handId={hand.handId}
              decisionIndex={decision.decisionIndex}
              nameOf={nameOf}
            />
          )}
        </>
      )}
    </main>
  );
}
