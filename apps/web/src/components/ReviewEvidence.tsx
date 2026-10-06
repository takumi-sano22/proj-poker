// Review の根拠（Evidence）の表示（#84・docs/05 §6・docs/06 §10 Spot Detail）。値はサーバーの Evidence をそのまま読むだけで、
// 計算・評価はしない（数値は Engine が決定論で作ったもの）。金額は実額を出し、BB は補助（D49）。
// Pass A の根拠（判断時点の卓・Math・Range・Solver・KB）は判断時点の情報だけで、他者の札・後の Street は入らない。
import type { ReactNode } from "react";
import { STREET_TERMS, formatPercent, termLabel } from "../lib/format.js";
import {
  PREFLOP_SPOT_LABELS,
  SOLVER_FALLBACK_NOTE,
  decisionLabel,
  solverActionLabel,
  solverNote,
} from "../lib/review.js";
import type {
  DecisionContext,
  KnowledgeItem,
  MathEvidence,
  RangeEvidence,
  SolverEvidence,
} from "../lib/review-api.js";
import { Amount } from "./Amount.js";
import { PlayingCard } from "./PlayingCard.js";

type NameOf = (playerId: string) => string;

/** 根拠の 1 区分。既定は閉じておき、要点（評価と説明）を先に読ませる（D04）。cited は Review AI が根拠に挙げたか。 */
export function EvidenceSection({
  title,
  cited,
  open = false,
  children,
}: {
  readonly title: string;
  readonly cited?: boolean;
  readonly open?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <details className="evidence" open={open}>
      <summary className="evidence__summary">
        <span>{title}</span>
        {cited === true && (
          <span className="badge evidence__cited">説明の根拠</span>
        )}
      </summary>
      <div className="evidence__body">{children}</div>
    </details>
  );
}

/** 判断時点の卓（Table State と Action Timeline）。Board は判断時点までに公開された札だけ。 */
export function DecisionContextView({
  context,
  nameOf,
}: {
  readonly context: DecisionContext;
  readonly nameOf: NameOf;
}) {
  const bb = context.bigBlind;
  return (
    <div className="evidence-grid">
      <dl className="facts">
        <div>
          <dt>Street</dt>
          <dd>{termLabel(STREET_TERMS[context.street])}</dd>
        </div>
        <div>
          <dt>Hero の Position</dt>
          <dd>{context.heroPosition}</dd>
        </div>
        <div>
          <dt>Pot</dt>
          <dd>
            <Amount value={context.pot} bigBlind={bb} inline />
          </dd>
        </div>
        <div>
          <dt>残っている人数</dt>
          <dd>
            {context.activePlayerCount} 人（卓に {context.playerCount} 人）
          </dd>
        </div>
        <div>
          <dt>Hero の選択</dt>
          <dd>{decisionLabel(context.decision)}</dd>
        </div>
      </dl>
      <div className="evidence-cards">
        <div>
          <p className="evidence-cards__label">Hero の札</p>
          <div className="evidence-cards__row">
            {context.heroHoleCards.map((card, i) => (
              <PlayingCard key={i} card={card} size="sm" />
            ))}
          </div>
        </div>
        <div>
          <p className="evidence-cards__label">Board（判断時点）</p>
          <div className="evidence-cards__row">
            {context.board.length === 0 ? (
              <span className="evidence__muted">まだ配られていません</span>
            ) : (
              context.board.map((card, i) => (
                <PlayingCard key={i} card={card} size="sm" />
              ))
            )}
          </div>
        </div>
      </div>
      <div className="evidence-table-wrap">
        <table className="evidence-table">
          <caption>席（判断時点）</caption>
          <thead>
            <tr>
              <th scope="col">Player</th>
              <th scope="col">Stack</th>
              <th scope="col">この Street</th>
              <th scope="col">状態</th>
            </tr>
          </thead>
          <tbody>
            {context.seats.map((s) => (
              <tr
                key={s.playerId}
                className={s.isHero ? "evidence-table__hero" : undefined}
              >
                <th scope="row">
                  {nameOf(s.playerId)}（{s.position}）
                </th>
                <td>
                  <Amount value={s.stack} bigBlind={bb} inline />
                </td>
                <td>
                  <Amount value={s.streetCommitted} bigBlind={bb} inline />
                </td>
                <td>{s.folded ? "Fold" : s.allIn ? "All-in" : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div>
        <p className="evidence-cards__label">Action の流れ（判断の直前まで）</p>
        {context.actionHistory.length === 0 ? (
          <p className="evidence__muted">まだ Action はありません。</p>
        ) : (
          <ol className="timeline">
            {context.actionHistory.map((a, i) => (
              <li key={i}>
                <span className="timeline__street">
                  {STREET_TERMS[a.street].term}
                </span>
                {nameOf(a.playerId)}: {decisionLabel(a)}
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

/** Math（Pot Odds・Equity・SPR・選択肢ごとの必要 Equity と簡易 EV）。簡易 EV は GTO / Solver の値ではない（D20）。 */
export function MathView({
  math,
  bigBlind,
}: {
  readonly math: MathEvidence;
  readonly bigBlind: number;
}) {
  return (
    <div className="evidence-grid">
      <dl className="facts">
        <div>
          <dt>Call に要る額</dt>
          <dd>
            <Amount value={math.callAmount} bigBlind={bigBlind} inline />
          </dd>
        </div>
        <div>
          <dt>Pot Odds（必要な勝率）</dt>
          <dd>{math.potOdds === null ? "—" : formatPercent(math.potOdds)}</dd>
        </div>
        <div>
          <dt>Equity（仮定した Range に対する勝率）</dt>
          <dd>
            {math.equity === null
              ? "出せませんでした"
              : formatPercent(math.equity.equity)}
          </dd>
        </div>
        <div>
          <dt>有効 Stack</dt>
          <dd>
            <Amount value={math.effectiveStack} bigBlind={bigBlind} inline />
          </dd>
        </div>
        <div>
          <dt>SPR</dt>
          <dd>{math.spr === null ? "—" : math.spr.toFixed(1)}</dd>
        </div>
      </dl>
      {math.alternatives.length > 0 && (
        <div className="evidence-table-wrap">
          <table className="evidence-table">
            <caption>選択肢の比較（簡易 EV は前提つきの目安です）</caption>
            <thead>
              <tr>
                <th scope="col">選択肢</th>
                <th scope="col">出す額</th>
                <th scope="col">必要な勝率</th>
                <th scope="col">簡易 EV</th>
              </tr>
            </thead>
            <tbody>
              {math.alternatives.map((alt, i) => (
                <tr
                  key={i}
                  className={alt.chosen ? "evidence-table__hero" : undefined}
                >
                  <th scope="row">
                    {decisionLabel({
                      action: alt.action,
                      amount: alt.risk,
                      toAmount: alt.toAmount ?? 0,
                      allIn: false,
                    })}
                    {alt.chosen && (
                      <span className="badge evidence__chosen">選んだ</span>
                    )}
                  </th>
                  <td>
                    <Amount value={alt.risk} bigBlind={bigBlind} inline />
                  </td>
                  <td>
                    {alt.requiredEquity === null
                      ? "—"
                      : formatPercent(alt.requiredEquity)}
                  </td>
                  <td>
                    {alt.ev === null ? (
                      "—"
                    ) : (
                      <SignedAmount value={alt.ev} bigBlind={bigBlind} />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Assumptions items={math.assumptions} />
    </div>
  );
}

/** 符号付きの額（簡易 EV。小数は四捨五入した実額で出す）。 */
function SignedAmount({
  value,
  bigBlind,
}: {
  readonly value: number;
  readonly bigBlind: number;
}) {
  const rounded = Math.round(value);
  const sign = rounded > 0 ? "+" : rounded < 0 ? "−" : "±";
  return (
    <span className="signed">
      {sign}
      <Amount value={Math.abs(rounded)} bigBlind={bigBlind} inline />
    </span>
  );
}

/** Range の仮定（相手ごと）と、Range の想定（標準・狭い・広い）ごとの Equity の比較。 */
export function RangeView({
  range,
  nameOf,
}: {
  readonly range: RangeEvidence;
  readonly nameOf: NameOf;
}) {
  return (
    <div className="evidence-grid">
      {range.villains.length === 0 ? (
        <p className="evidence__muted">Range を仮定した相手はいません。</p>
      ) : (
        <ul className="evidence-list">
          {range.villains.map((v) => (
            <li key={v.playerId}>
              <strong>
                {nameOf(v.playerId)}（{v.position}）
              </strong>
              ：{PREFLOP_SPOT_LABELS[v.preflopSpot]}の Range を仮定（
              {v.preflopNotation}）。
              {v.postflop.length > 0 &&
                ` Postflop の Action で ${v.postflop
                  .map(
                    (n) =>
                      `${STREET_TERMS[n.street].term} ${n.combosBefore} → ${n.combosAfter}`,
                  )
                  .join("、")} Combo に絞った。`}{" "}
              残り {v.comboCount} Combo。
            </li>
          ))}
        </ul>
      )}
      {range.comparisons !== null && range.comparisons.length > 0 && (
        <dl className="facts">
          {range.comparisons.map((c) => (
            <div key={c.id}>
              <dt>{c.label}</dt>
              <dd>
                {c.equity === null ? "—" : `Equity ${formatPercent(c.equity)}`}
              </dd>
            </div>
          ))}
        </dl>
      )}
      <p className="evidence__note">
        Range は判断時点の公開情報からの仮定で、相手の実際の札ではありません。
      </p>
    </div>
  );
}

/**
 * Solver の根拠。Supported のときだけ Solver の結果（Heads-Up の解。Multiway の Exact GTO ではない）を出し、
 * それ以外は使わなかった理由と Fallback を出す（不変条件 5・docs/05 §10）。
 */
export function SolverView({ solver }: { readonly solver: SolverEvidence }) {
  const note = solverNote(solver);
  if (solver.status !== "supported") {
    return (
      <div className="evidence-grid">
        <p>{note.reason}</p>
        <p className="evidence__note">{SOLVER_FALLBACK_NOTE}</p>
      </div>
    );
  }
  return (
    <div className="evidence-grid">
      <p className="evidence__note">{note.reason}</p>
      <ul className="freq">
        {solver.strategy.map((f) => (
          <li key={f.key} className="freq__row">
            <span className="freq__label">{solverActionLabel(f.action)}</span>
            <span className="freq__bar" aria-hidden="true">
              <span
                className="freq__fill"
                style={{ width: `${Math.round(f.frequency * 100)}%` }}
              />
            </span>
            <span className="freq__value">{formatPercent(f.frequency)}</span>
          </li>
        ))}
      </ul>
      <p className="evidence__muted">
        上は Range 全体の頻度です。Hero の札（{solver.heroHandClass}）では
        {solver.heroHandClassStrategy === null
          ? "、仮定した Range の外のため頻度を出せません。"
          : `、${solver.strategy
              .map(
                (f) =>
                  `${solverActionLabel(f.action)} ${formatPercent(
                    solver.heroHandClassStrategy?.[f.key] ?? 0,
                  )}`,
              )
              .join("・")}。`}
      </p>
      <p className="evidence__muted">
        反復 {solver.convergence.iterations} 回。{solver.convergence.note}
      </p>
      <Assumptions items={[...solver.assumptions, ...solver.warnings]} />
    </div>
  );
}

/** 知識（Local KB）の項目。経験則（HEURISTIC / EXPLOIT）は断定ではない。 */
export function KnowledgeView({
  items,
  cited,
}: {
  readonly items: readonly KnowledgeItem[];
  readonly cited: readonly string[];
}) {
  if (items.length === 0) {
    return (
      <p className="evidence__muted">当てはまる知識の項目はありません。</p>
    );
  }
  return (
    <ul className="evidence-list">
      {items.map((item) => (
        <li key={item.id}>
          <details className="kb">
            <summary>
              <span className="badge">{item.label}</span> {item.title}
              {cited.includes(item.id) && (
                <span className="badge evidence__cited">説明の根拠</span>
              )}
            </summary>
            <p className="kb__body">{item.body}</p>
          </details>
        </li>
      ))}
    </ul>
  );
}

/** 前提（Assumptions）の箇条書き。無ければ何も出さない。 */
export function Assumptions({
  items,
  title = "前提（Assumptions）",
}: {
  readonly items: readonly string[];
  readonly title?: string;
}) {
  if (items.length === 0) return null;
  return (
    <div>
      <p className="evidence-cards__label">{title}</p>
      <ul className="evidence-list evidence-list--muted">
        {items.map((a, i) => (
          <li key={i}>{a}</li>
        ))}
      </ul>
    </div>
  );
}
