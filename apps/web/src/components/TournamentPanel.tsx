// Tournament の欄（#190・docs/06 §15・D49・D127〜D129）。卓の右（狭い画面は卓の下）の進行ログの上に置き、この Hand の Level・
// Blind・Ante・次の Level までの残り・残人数を常に出し、Payout と Elimination（終わったら順位と Payout の Result）を畳める欄に置く
// （進行ログを押し下げすぎない。終わったら開いて出す）。
// 値はサーバーが Event Log から計算した公開の情報（TournamentTableStatus）をそのまま読む。CPU の Persona・Private Memory・
// 他者の札は届かないので出しようがない。Payout は pt（参加費の単位）で、Chip（Stack・Pot の実額）とは別の量として書き分ける。
// Hero の Bust・優勝で終わった後は、Hero の順位と Payout・確定した他の順位を出し、残った CPU は「未決」と書く（D129）。
import type { SessionRequest, TournamentTableStatus } from "../lib/api.js";
import { formatChips } from "../lib/format.js";
import {
  SESSION_CHOICES,
  anteText,
  orderedPlacements,
  payoutText,
  placeText,
  presetSummary,
  sessionChoiceOf,
  sessionChoiceValue,
  untilNextLevelText,
} from "../lib/tournament.js";

type NameOf = (playerId: string) => string;

// 注記（JSX の改行で日本語の間に空白が入らないよう、1 つの文字列にする）。
const PAYOUT_NOTE =
  "Payout は参加費の単位（pt）の賞金で、Stack・Pot の Chip とは別の量です。";
const TIME_BASE_NOTE =
  "Level は Hand の始めに上がります（Hand の途中では上がりません）。";

/** 終わった Tournament の見出し（Result）。続いている間は Tournament の状況。 */
function panelTitle(status: TournamentTableStatus): string {
  switch (status.result.status) {
    case "in_progress":
      return "Tournament";
    case "finished":
      return "Tournament の結果（Result）";
    case "abandoned":
      return "Tournament の結果（打ち切り）";
  }
}

/** Blind と Ante の 1 行（例: "10 / 20 · BB Ante 20"）。 */
function blindsText(
  status: TournamentTableStatus,
  level: {
    readonly smallBlind: number;
    readonly bigBlind: number;
    readonly ante: number;
  },
): string {
  const ante = anteText(status.anteKind, level.ante);
  const blinds = `${formatChips(level.smallBlind)} / ${formatChips(level.bigBlind)}`;
  return ante === null ? blinds : `${blinds} · ${ante}`;
}

export function TournamentPanel({
  status,
  heroId,
  nameOf,
}: {
  readonly status: TournamentTableStatus;
  readonly heroId: string;
  readonly nameOf: NameOf;
}) {
  const { result } = status;
  const next = status.nextLevel;
  const ended = result.status !== "in_progress";
  // 続いている間は Bust した Player だけ、終わったら全員（残った CPU は未決）を並べる。
  const rows = orderedPlacements(result).filter(
    (p) => ended || p.place !== null,
  );
  const eliminated = result.placements.filter(
    (p) => p.eliminatedInHandId !== null,
  ).length;
  return (
    <section
      className="tournament"
      aria-label="Tournament"
      data-tournament-status={result.status}
    >
      <h2 className="tournament__title">
        {panelTitle(status)}
        <span className="tournament__preset">
          {presetSummary(status.presetId)}
        </span>
      </h2>
      <dl className="tournament__facts">
        <div>
          <dt>
            Level {status.level}
            <span className="tournament__muted"> / {status.levelCount}</span>
          </dt>
          <dd>{blindsText(status, status)}</dd>
        </div>
        <div>
          <dt>次の Level</dt>
          <dd>
            {next === null ? (
              "最後の Level（以後は上がりません）"
            ) : (
              <>
                {blindsText(status, next)}
                <span className="tournament__until">
                  {untilNextLevelText(status)}
                </span>
              </>
            )}
          </dd>
        </div>
        <div>
          <dt>残り</dt>
          <dd>
            {result.remaining} / {result.entrants} 人
          </dd>
        </div>
      </dl>
      {/* 終わったら開いた状態で作り直す（続いている間に開いた・閉じた状態は Hand をまたいでそのまま） */}
      <details
        key={ended ? "ended" : "in_progress"}
        className="tournament__more"
        open={ended}
      >
        <summary className="tournament__summary">
          {ended
            ? "順位と Payout"
            : `Payout と脱落（Elimination）${eliminated > 0 ? `・${eliminated} 人` : ""}`}
        </summary>
        <div className="tournament__body">
          <p className="tournament__line">
            Prize Pool {payoutText(result.prizePool)}（
            {result.payoutsByPlace
              .map((amount, i) => `${placeText(i + 1)} ${payoutText(amount)}`)
              .join("・")}
            ）
          </p>
          {rows.length === 0 ? (
            <p className="tournament__muted">まだ誰も脱落していません。</p>
          ) : (
            <ol className="tournament__places">
              {rows.map((p) => (
                <li
                  key={p.playerId}
                  className={`tournament__place${p.playerId === heroId ? " tournament__place--hero" : ""}`}
                  data-place={p.place ?? "undecided"}
                >
                  <span className="tournament__rank">{placeText(p.place)}</span>
                  <span className="tournament__name">{nameOf(p.playerId)}</span>
                  <span className="tournament__payout">
                    {payoutText(p.payout)}
                  </span>
                </li>
              ))}
            </ol>
          )}
          {ended && result.placements.some((p) => p.place === null) && (
            <p className="tournament__note">
              {result.status === "abandoned"
                ? "打ち切ったため、残っていた Player の順位と Payout は決まっていません。"
                : "Hero の Bust で終えたため、残った CPU の順位は決めていません（未決）。"}
            </p>
          )}
          <p className="tournament__note">
            {PAYOUT_NOTE}
            {status.schedule.kind === "time_base" && TIME_BASE_NOTE}
          </p>
        </div>
      </details>
    </section>
  );
}

/**
 * 新しい Session の種類（Cash / Tournament の Preset。D128）を選ぶ。選んだ値は「新しい Session を始める」で送る。
 * compact は Hero の欄（Session の終わりの案内）に置くときで、見出しの文字を出さずに欄を低く保つ（名前は aria-label で付ける）。
 */
export function SessionModePicker({
  value,
  onChange,
  disabled = false,
  compact = false,
}: {
  readonly value: SessionRequest;
  readonly onChange: (next: SessionRequest) => void;
  readonly disabled?: boolean;
  readonly compact?: boolean;
}) {
  const select = (
    <select
      className="session-pick__select"
      aria-label={compact ? "新しい Session の種類" : undefined}
      value={sessionChoiceValue(value)}
      disabled={disabled}
      onChange={(e) => onChange(sessionChoiceOf(e.target.value))}
    >
      {SESSION_CHOICES.map((c) => (
        <option key={c.value} value={c.value}>
          {c.label}
        </option>
      ))}
    </select>
  );
  if (compact) return select;
  return (
    <label className="session-pick">
      <span className="session-pick__label">新しい Session の種類</span>
      {select}
    </label>
  );
}
