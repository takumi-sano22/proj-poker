// Review の根拠（Evidence）の表示（#84・docs/05 §6・docs/06 §10 Spot Detail）。値はサーバーの Evidence をそのまま読むだけで、
// 計算・評価はしない（数値は Engine が決定論で作ったもの）。金額は実額を出し、BB は補助（D49）。
// Pass A の根拠（判断時点の卓・Math・Range・Solver・KB）は判断時点の情報だけで、他者の札・後の Street は入らない。
// Tournament の判断（#189・#190・D130）は、ICM / Prize Equity（賞金 pt の期待値）を Chip EV（Chip の損得）と別の項目・別の欄で出す。
import type { ReactNode } from "react";
import { STREET_TERMS, formatPercent, termLabel } from "../lib/format.js";
import {
  ALL_IN_DECISION_LABELS,
  PREFLOP_SPOT_LABELS,
  SOLVER_FALLBACK_NOTE,
  TOURNAMENT_STAGE_LABELS,
  decisionLabel,
  solverActionLabel,
  solverNote,
  tendencyItemLabel,
  tendencyValueText,
} from "../lib/review.js";
import type {
  DecisionContext,
  KnowledgeItem,
  MathEvidence,
  OpponentObservation,
  RangeEvidence,
  SolverEvidence,
  TournamentEvidence,
} from "../lib/review-api.js";
import {
  anteText,
  equityText,
  payoutText,
  placeText,
} from "../lib/tournament.js";
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

/**
 * 卓の傾向（Table Tendency。D122・#169）。Review の Evidence に保存されている決定論の値をそのまま読むだけで、画面で計算しない。
 * 判断より前の Hand の public の Action だけから数えた、Hero 以外の卓全体の傾向（個々の相手の傾向ではない）。
 * 表示するのは Evidence の項目（割合と分子 / 分母・機会があった Hand の数・十分か）と数えた Hand の数だけで、
 * CPU の Private Memory・Persona・Tilt は Evidence に無く、ここにも出さない。
 * 十分な項目が無い Review（#153 より前の Review を含む）は、無いと分かる文だけを出す。
 */
export function TableTendencyView({
  observation,
  cited,
}: {
  readonly observation: OpponentObservation;
  readonly cited: readonly string[];
}) {
  if (observation.status !== "available") {
    return (
      <p className="evidence__muted">
        卓の傾向はありません。この判断より前の Hand の記録が足りず、十分な項目が
        1 つも無いため、卓の傾向は根拠にしていません。
      </p>
    );
  }
  const { hands, items } = observation.tableTendency;
  return (
    <div className="evidence-grid">
      <p className="evidence__note">
        この判断より前の {hands} Hand の、公開された Action
        だけから数えた卓全体の傾向です（VPIP・PFR・攻めの頻度は Hero
        以外の席の合計、Showdown は Hand
        単位。個々の相手の傾向ではありません）。サンプルが足りない項目は保留で、根拠にしません。
      </p>
      <ul className="tendency">
        {items.map((item) => (
          <li
            key={item.id}
            className={`tendency__item${item.sufficient ? "" : " tendency__item--pending"}`}
            data-tendency-item={item.item}
          >
            <span className="tendency__name">
              {tendencyItemLabel(item.item)}
            </span>
            <span className="tendency__value">{tendencyValueText(item)}</span>
            <span className="tendency__meta">
              機会があった Hand: {item.hands}
            </span>
            <span className="tendency__badges">
              <span
                className={`badge ${item.sufficient ? "tendency__sufficient" : "tendency__pending"}`}
              >
                {item.sufficient
                  ? "サンプルが十分"
                  : "サンプルが足りない（保留）"}
              </span>
              {cited.includes(item.id) && (
                <span className="badge evidence__cited">説明の根拠</span>
              )}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Chip EV と ICM の必要 Equity を混同させないための注記（D130）。JSX の改行で日本語の間に空白が入らないよう 1 つの文字列にする。 */
const TOURNAMENT_EV_NOTE =
  "Chip EV の必要 Equity は Chip の損得、ICM の必要 Equity は賞金（pt）の期待値で計算した別の値です。Tournament では Chip の損得と賞金の損得が一致しないため、混同せずに見比べてください。";

/** Evidence の % の値（小数第 1 位に丸め済み）の表記。 */
function percent1(value: number): string {
  return `${value.toFixed(1)}%`;
}

/**
 * Tournament の根拠（#189・#190・D130）。判断時点の公開の状況（残人数・Level・Ante・Payout・Stage）と、全席の ICM Equity
 * （賞金 pt の期待値）、All-in の関わる判断では相手ごとの Chip EV の必要 Equity と ICM の必要 Equity を別の列で出す。
 * Shove の値は「その相手に Call され、ほかは Fold した場合」の条件付きで、その前提（Fold Equity・Call の頻度を含まない）を
 * サーバーの Evidence の文のまま出す。値は Engine の ICM Calculator が公開の Stack から作ったもので、画面では計算しない。
 */
export function TournamentEvidenceView({
  tournament,
  bigBlind,
  nameOf,
  cited,
}: {
  readonly tournament: TournamentEvidence;
  readonly bigBlind: number;
  readonly nameOf: NameOf;
  readonly cited: readonly string[];
}) {
  const ante = anteText(tournament.anteKind, tournament.ante);
  const { allIn } = tournament;
  return (
    <div className="evidence-grid">
      <dl className="facts">
        <div>
          <dt>段階（Stage）</dt>
          <dd>{TOURNAMENT_STAGE_LABELS[tournament.stage]}</dd>
        </div>
        <div>
          <dt>残り</dt>
          <dd>
            {tournament.remaining} / {tournament.entrants} 人
          </dd>
        </div>
        {tournament.level !== null && (
          <div>
            <dt>Level</dt>
            <dd>
              {tournament.level}
              {ante !== null && `（${ante}）`}
            </dd>
          </div>
        )}
        <div>
          <dt>Prize Pool</dt>
          <dd>{payoutText(tournament.prizePool)}</dd>
        </div>
        <div>
          <dt>Payout</dt>
          <dd>
            {tournament.payoutsByPlace
              .map((amount, i) => `${placeText(i + 1)} ${payoutText(amount)}`)
              .join("・")}
          </dd>
        </div>
      </dl>
      <div className="evidence-table-wrap">
        <table className="evidence-table" data-evidence="icm">
          <caption>
            判断時点の ICM Equity（賞金の期待値。Chip の量とは別の項目）
            {cited.includes(tournament.icm.id) && (
              <span className="badge evidence__cited">説明の根拠</span>
            )}
          </caption>
          <thead>
            <tr>
              <th scope="col">Player</th>
              <th scope="col">Stack</th>
              <th scope="col">ICM Equity</th>
            </tr>
          </thead>
          <tbody>
            {tournament.icm.seats.map((s) => (
              <tr
                key={s.playerId}
                className={s.isHero ? "evidence-table__hero" : undefined}
              >
                <th scope="row">{nameOf(s.playerId)}</th>
                <td>
                  <Amount value={s.icmStack} bigBlind={bigBlind} inline />
                </td>
                <td>
                  {equityText(s.icmEquity)}（{percent1(s.icmEquityPercent)}）
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="evidence__note">
        {`Stack は判断時点の手元の Stack にこの Hand で出した額を戻した値です（Pot の行方は決めていません）。ICM Equity は残りの順位の賞金（pt）を、Stack から決定論で分けた期待値です（${tournament.icm.method}）。`}
      </p>
      {allIn?.status === "available" && (
        <div className="evidence-grid" data-evidence="all-in">
          <div className="evidence-table-wrap">
            <table className="evidence-table">
              <caption>
                {ALL_IN_DECISION_LABELS[allIn.decision]}の必要 Equity（Chip EV
                と ICM を別に計算）
              </caption>
              <thead>
                <tr>
                  <th scope="col">相手</th>
                  <th scope="col">Chip EV の必要 Equity</th>
                  <th scope="col">ICM の必要 Equity</th>
                </tr>
              </thead>
              <tbody>
                {allIn.requirements.map((r) => (
                  <tr key={r.villainId}>
                    <th scope="row">
                      {allIn.decision === "shove"
                        ? `${nameOf(r.villainId)} に Call された場合`
                        : nameOf(r.villainId)}
                    </th>
                    <td data-requirement="chip-ev">
                      {percent1(r.chipEv.requiredEquityPercent)}
                      {cited.includes(r.chipEv.id) && (
                        <span className="badge evidence__cited">
                          説明の根拠
                        </span>
                      )}
                    </td>
                    <td data-requirement="icm">
                      {r.icm.requiredEquityPercent === null
                        ? "—"
                        : percent1(r.icm.requiredEquityPercent)}
                      {cited.includes(r.icm.id) && (
                        <span className="badge evidence__cited">
                          説明の根拠
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Assumptions
            items={allIn.assumptions.notes}
            title={
              allIn.decision === "shove"
                ? "前提（Shove の値は条件付き）"
                : "前提（Assumptions）"
            }
          />
        </div>
      )}
      {allIn?.status === "out_of_scope" && (
        <p className="evidence__muted" data-evidence="all-in-out-of-scope">
          {allIn.reason}。
        </p>
      )}
      <p className="evidence__note">{TOURNAMENT_EV_NOTE}</p>
    </div>
  );
}
