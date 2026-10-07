// 1 つの判断の Review の Pass ごとの表示（#84・docs/05 §7〜§9・docs/06 §10）。
// - Pass A（DecisionReviewPanel）: 判断時点の情報だけの Review。段階評価・要点（Practical）を先に出し、根拠は後ろに畳む（D04・D05）。
//   Hand 後の情報（相手の実際の札・結果）は出さない（不変条件 3）。
// - Pass B（RevealReviewPanel）: Hand 後に全員の札を見せる答え合わせ。Pass A と色・見出しで分け、段階評価は出さない。
// どちらも Version を選べ（D39）、「詳しく」で review_deep を選べ（D97）、Version ごとに Follow-up の欄を置く。
// 生成の待ち・失敗の案内は内部実装（モデル名・API）を前面に出さない（docs/06 §11）。
import { useDelayed } from "../hooks/useDelayed.js";
import { usePassReview, type PassReview } from "../hooks/usePassReview.js";
import { REVIEW_DELAY_NOTICE_MS } from "../lib/config.js";
import { STREET_TERMS, formatPercent, termLabel } from "../lib/format.js";
import {
  ASSESSMENT_TERMS,
  CONFIDENCE_LABELS,
  MADE_HAND_LABELS,
  assessmentTone,
  decisionLabel,
  generationMessage,
  insufficientNote,
  spaced,
  versionLabel,
} from "../lib/review.js";
import type {
  PassStatus,
  ReviewPass,
  ReviewRecord,
  RevealRecord,
} from "../lib/review-api.js";
import { FollowUp } from "./FollowUp.js";
import { PlayingCard } from "./PlayingCard.js";
import {
  Assumptions,
  DecisionContextView,
  EvidenceSection,
  KnowledgeView,
  MathView,
  RangeView,
  SolverView,
} from "./ReviewEvidence.js";

type NameOf = (playerId: string) => string;

interface PanelProps {
  readonly handId: string;
  readonly decisionIndex: number;
  readonly nameOf: NameOf;
}

/** Pass A: 判断時点の Review。 */
export function DecisionReviewPanel({
  handId,
  decisionIndex,
  nameOf,
}: PanelProps) {
  const review = usePassReview<ReviewRecord>(handId, decisionIndex, "decision");
  return (
    <div className="review-pass review-pass--decision">
      <p className="review-pass__lead">
        判断した時点に Hero が見えていた情報だけで評価します。相手の実際の札や
        Hand の結果は使いません。
      </p>
      <GenerationBar review={review} pass="decision" subject="Review" />
      {review.record !== null && (
        <DecisionReviewBody
          record={review.record}
          nameOf={nameOf}
          handId={handId}
          decisionIndex={decisionIndex}
        />
      )}
    </div>
  );
}

export function DecisionReviewBody({
  record,
  nameOf,
  handId,
  decisionIndex,
}: {
  readonly record: ReviewRecord;
  readonly nameOf: NameOf;
  readonly handId: string;
  readonly decisionIndex: number;
}) {
  const { evidence, explanation } = record;
  const cited = record.evidenceIds.cited;
  const citedAny = (prefix: string) =>
    cited.some((id) => id.startsWith(prefix));
  const note = insufficientNote(record.generatedBy);
  const tone = assessmentTone(record.assessment);
  return (
    <article className="review-body" aria-label={`Version ${record.version}`}>
      <header className="review-verdict">
        <span className={`assessment assessment--${tone}`}>
          {termLabel(ASSESSMENT_TERMS[record.assessment])}
        </span>
        <span className="review-verdict__meta">
          確度（Confidence）: {CONFIDENCE_LABELS[record.confidence]}
        </span>
        {record.depth === "deep" && <span className="badge">詳しく</span>}
      </header>
      {note !== null && <p className="review-body__note">{note}</p>}
      <section className="review-point">
        <h4 className="review-point__title">要点</h4>
        <p>{explanation.practical}</p>
      </section>
      {explanation.conclusionChangers.length > 0 && (
        <section className="review-point">
          <h4 className="review-point__title">結論が変わる条件</h4>
          <ul className="evidence-list">
            {explanation.conclusionChangers.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        </section>
      )}
      {explanation.theory.basis !== "none" &&
        explanation.theory.text !== "" && (
          <section className="review-point">
            <h4 className="review-point__title">
              理論（
              {explanation.theory.basis === "solver"
                ? "Solver の結果から"
                : "一般的な理論"}
              ）
            </h4>
            <p>{explanation.theory.text}</p>
          </section>
        )}
      <section className="review-point">
        <h4 className="review-point__title">相手に合わせた調整（Exploit）</h4>
        <p>
          {explanation.exploit.basis === "observation" &&
          explanation.exploit.text !== ""
            ? explanation.exploit.text
            : "相手の傾向の記録がまだ無いため、相手に合わせた調整はしていません。"}
        </p>
      </section>
      <Assumptions items={record.assumptions} />

      <div className="evidence-stack">
        <p className="evidence-stack__title">根拠（Evidence）</p>
        <EvidenceSection
          title="判断時点の卓と Action の流れ"
          cited={citedAny("ctx:")}
        >
          <DecisionContextView context={evidence.context} nameOf={nameOf} />
        </EvidenceSection>
        <EvidenceSection title="計算（Math）" cited={citedAny("math:")}>
          <MathView math={evidence.math} bigBlind={evidence.context.bigBlind} />
        </EvidenceSection>
        <EvidenceSection title="相手の Range の仮定" cited={citedAny("range:")}>
          <RangeView range={evidence.range} nameOf={nameOf} />
        </EvidenceSection>
        <EvidenceSection title="Solver" cited={citedAny("solver:")}>
          <SolverView solver={evidence.solver} />
        </EvidenceSection>
        <EvidenceSection title="知識（KB）" cited={citedAny("kb:")}>
          <KnowledgeView items={evidence.knowledge.items} cited={cited} />
        </EvidenceSection>
        {evidence.userRead?.status === "collected" && (
          // 判断の前に Hero が記録した読み（D112）。Hero の主張で、当たり外れはここでは出さない。
          <EvidenceSection
            title="Hero の読み（User Read）"
            cited={citedAny("read:")}
          >
            <ul className="evidence-list">
              {evidence.userRead.items.map((item) => (
                <li key={item.id}>
                  {termLabel(STREET_TERMS[item.street])}・
                  {item.playerId === undefined
                    ? "相手を特定しない"
                    : nameOf(item.playerId)}
                  : {item.text}
                </li>
              ))}
            </ul>
          </EvidenceSection>
        )}
      </div>

      <FollowUp
        handId={handId}
        decisionIndex={decisionIndex}
        pass="decision"
        version={record.version}
      />
    </article>
  );
}

/** Pass B: Hand 後の答え合わせ（全員の札を見せる。段階評価は出さない）。 */
export function RevealReviewPanel({
  handId,
  decisionIndex,
  nameOf,
}: PanelProps) {
  const review = usePassReview<RevealRecord>(handId, decisionIndex, "reveal");
  return (
    <div className="review-pass review-pass--reveal">
      <p className="review-pass__lead">
        Hand
        が終わった後に全員の札を見せて、判断時点の読みと比べます。結果を見て判断の評価（段階評価）は変えません。
      </p>
      <GenerationBar review={review} pass="reveal" subject="答え合わせ" />
      {review.record !== null && (
        <RevealReviewBody
          record={review.record}
          nameOf={nameOf}
          handId={handId}
          decisionIndex={decisionIndex}
        />
      )}
    </div>
  );
}

export function RevealReviewBody({
  record,
  nameOf,
  handId,
  decisionIndex,
}: {
  readonly record: RevealRecord;
  readonly nameOf: NameOf;
  readonly handId: string;
  readonly decisionIndex: number;
}) {
  const { evidence, explanation } = record;
  const note = insufficientNote(record.generatedBy);
  return (
    <article className="review-body" aria-label={`Version ${record.version}`}>
      <header className="review-verdict">
        <span className="badge review-verdict__reveal">Hand 後の情報</span>
        {record.depth === "deep" && <span className="badge">詳しく</span>}
      </header>
      {note !== null && <p className="review-body__note">{note}</p>}

      <section className="review-point">
        <h4 className="review-point__title">全員の札</h4>
        <ul className="reveal-list">
          {evidence.reveal.villains.map((v) => (
            <li key={v.playerId} className="reveal-list__item">
              <span className="reveal-list__name">
                {nameOf(v.playerId)}（{v.position}）
              </span>
              <span className="evidence-cards__row">
                {v.holeCards.map((card, i) => (
                  <PlayingCard key={i} card={card} size="sm" />
                ))}
              </span>
              <span className="reveal-list__note">
                {!v.activeAtDecision
                  ? "判断の前に Fold"
                  : v.inAssumedRange === true
                    ? "仮定した Range に入っていた"
                    : v.inAssumedRange === false
                      ? "仮定した Range の外だった"
                      : ""}
                {v.madeHandAtDecision !== null &&
                  ` ・判断時点の役: ${MADE_HAND_LABELS[v.madeHandAtDecision]}`}
              </span>
            </li>
          ))}
        </ul>
        {evidence.reveal.finalBoard.length > 0 && (
          <div>
            <p className="evidence-cards__label">最後の Board</p>
            <div className="evidence-cards__row">
              {evidence.reveal.finalBoard.map((card, i) => (
                <PlayingCard key={i} card={card} size="sm" />
              ))}
            </div>
          </div>
        )}
      </section>

      <dl className="facts">
        <div>
          <dt>仮定した Range に対する Equity（判断時点）</dt>
          <dd>
            {evidence.equity.assumed === null
              ? "—"
              : formatPercent(evidence.equity.assumed)}
          </dd>
        </div>
        <div>
          <dt>実際の札に対する Equity（判断時点から）</dt>
          <dd>
            {evidence.equity.actual === null
              ? "—"
              : formatPercent(evidence.equity.actual.equity)}
          </dd>
        </div>
      </dl>

      <section className="review-point">
        <h4 className="review-point__title">読みと実際の比較</h4>
        <p>{explanation.readComparison}</p>
      </section>
      <section className="review-point">
        <h4 className="review-point__title">実際の Equity</h4>
        <p>{explanation.actualEquity}</p>
      </section>
      <section className="review-point">
        <h4 className="review-point__title">Bluff / Value の答え合わせ</h4>
        <p>{explanation.bluffValue}</p>
      </section>
      {explanation.takeaways.length > 0 && (
        <section className="review-point">
          <h4 className="review-point__title">次に活かす点</h4>
          <ul className="evidence-list">
            {explanation.takeaways.map((t, i) => (
              <li key={i}>{t}</li>
            ))}
          </ul>
        </section>
      )}

      {evidence.aggression.items.length > 0 && (
        <div className="evidence-stack">
          <EvidenceSection title="Bet / Raise の答え合わせの根拠">
            <ul className="evidence-list">
              {evidence.aggression.items.map((a, i) => (
                <li key={i}>
                  {STREET_TERMS[a.street].term}・{nameOf(a.playerId)}:{" "}
                  {decisionLabel({ ...a, amount: 0, allIn: false })}（
                  {a.playersInPot} 人の Pot。Equity{" "}
                  {a.actorEquity === null ? "—" : formatPercent(a.actorEquity)}
                  {a.label === null
                    ? ""
                    : `・${a.label === "value" ? "Value" : "Bluff"}`}
                  ）
                </li>
              ))}
            </ul>
            <p className="evidence__note">{evidence.aggression.rule}</p>
          </EvidenceSection>
        </div>
      )}

      <FollowUp
        handId={handId}
        decisionIndex={decisionIndex}
        pass="reveal"
        version={record.version}
      />
    </article>
  );
}

/**
 * 生成の操作と状態: まだ無ければ「作る」、待ちの間は案内、失敗したら理由ともう一度作るボタン、作った後は Version の選択と作り直し。
 * 「詳しく」は review_deep（時間がかかる。D97）。どちらも新しい Version として追記し、過去の Version は残る（D39）。
 */
function GenerationBar<R extends { readonly version: number }>({
  review,
  pass,
  subject,
}: {
  readonly review: PassReview<R>;
  readonly pass: ReviewPass;
  readonly subject: string;
}) {
  const status: PassStatus<R> | null = review.status;
  const generation = status?.generation ?? { state: "idle" as const };
  const pending = generation.state === "pending";
  const versions = status?.versions ?? 0;
  const delayed = useDelayed(
    pending ? `${pass}:${versions}:${generation.depth}` : null,
    REVIEW_DELAY_NOTICE_MS,
  );
  if (status === null) {
    return review.failed ? (
      <div className="notice" role="status">
        <p>{spaced(subject, false)}の状態を読み込めませんでした。</p>
        <button
          type="button"
          className="btn btn--secondary btn--sm"
          onClick={review.refresh}
        >
          読み込み直す
        </button>
      </div>
    ) : (
      <p className="evidence__muted">読み込んでいます…</p>
    );
  }
  const message = generationMessage(generation, subject, delayed);
  const disabled = pending || review.requesting;
  const latestVersion = versions;
  const shown = review.selectedVersion ?? latestVersion;
  return (
    <div className="generation">
      {message !== null && (
        <p
          className={`generation__status${generation.state === "failed" ? " generation__status--failed" : ""}`}
          role="status"
        >
          {message}
        </p>
      )}
      {review.requestFailed && (
        <p
          className="generation__status generation__status--failed"
          role="status"
        >
          {spaced(subject, false)}
          の作成を始められませんでした。もう一度押してください。
        </p>
      )}
      {review.recordFailed && (
        <p
          className="generation__status generation__status--failed"
          role="status"
        >
          選んだ Version を読み込めませんでした。もう一度選んでください。
        </p>
      )}
      <div className="generation__actions">
        {versions > 1 && (
          <label className="generation__version">
            <span>Version</span>
            <select
              value={shown}
              onChange={(e) => {
                const v = Number(e.target.value);
                review.selectVersion(v === latestVersion ? null : v);
              }}
            >
              {Array.from({ length: versions }, (_, i) => versions - i).map(
                (v) => (
                  <option key={v} value={v}>
                    {versionLabel(v, v === latestVersion)}
                  </option>
                ),
              )}
            </select>
          </label>
        )}
        <button
          type="button"
          className={`btn btn--sm ${versions === 0 ? "btn--primary" : "btn--secondary"}`}
          disabled={disabled}
          onClick={() => void review.request("standard")}
        >
          {versions === 0 ? `${spaced(subject, false)}を作る` : "作り直す"}
        </button>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          disabled={disabled}
          onClick={() => void review.request("deep")}
        >
          詳しく作る
        </button>
      </div>
      {versions > 0 && (
        <p className="generation__hint">
          作り直すと新しい Version として残り、前の Version
          も選んで見られます。「詳しく」は時間がかかります。
        </p>
      )}
    </div>
  );
}
