// App Shell の部品（Home / Play / Learn。D136・#218）: 上部のナビゲーション、Home、Learn の一覧、Learn の画面の「戻る」。
// どの部品も Hand・Session を自分では始めない。Home の照会は読み取り専用（GET /api/session/current。D144）で、開始は Hero が
// 「続きから遊ぶ」・「新しい Session を始める」を押したときに、呼び出し側（App）が既存の冪等な POST /api/hands で行う。
// Learn の一覧には、今ある機能（Replay・Hand Review・Session Review・Drill・Player Profile）の入口だけを置く（未実装の機能の入口は作らない）。
import type { HandSession } from "../hooks/useHandSession.js";
import {
  useCurrentSession,
  type CurrentSessionLoad,
} from "../hooks/useCurrentSession.js";
import type { CurrentSession, SessionRequest } from "../lib/api.js";
import { backLabel, type Area, type LearnReturn } from "../lib/shell.js";
import { SESSION_CHOICES, sessionChoiceValue } from "../lib/tournament.js";
import { SessionModePicker } from "./TournamentPanel.js";

const AREAS: readonly { readonly area: Area; readonly label: string }[] = [
  { area: "home", label: "Home" },
  { area: "play", label: "Play" },
  { area: "learn", label: "Learn" },
];

/** 上部のナビゲーション（Home / Play / Learn）。選んでも API は呼ばない（画面を切り替えるだけ）。 */
export function ShellNav({
  area,
  onSelect,
}: {
  readonly area: Area;
  readonly onSelect: (area: Area) => void;
}) {
  return (
    <nav className="shell-nav" aria-label="画面の切り替え">
      {AREAS.map((a) => (
        <button
          key={a.area}
          type="button"
          className="shell-nav__tab"
          aria-current={a.area === area ? "page" : undefined}
          onClick={() => onSelect(a.area)}
        >
          {a.label}
        </button>
      ))}
    </nav>
  );
}

/** Session の種類の表示名（Cash Game / Tournament の Preset）。 */
function kindLabel(kind: CurrentSession["kind"]): string {
  const value = sessionChoiceValue(kind);
  return SESSION_CHOICES.find((c) => c.value === value)?.label ?? value;
}

/**
 * Home。表示するたびに今の Session の状態を読み（読むだけ）、続けられる Session があれば「続きから遊ぶ」を、無ければ（終わっていれば）
 * 新しい Session の種類の選択と開始の Button を出す。知らない state・読めないときは、どちらの開始も出さない（D144 の安全側）。
 */
export function HomeScreen({
  session,
  onContinue,
  onStartNew,
}: {
  readonly session: HandSession;
  /** 続いている Session の続きへ（呼び出し側が Play へ移し、必要なら既存の冪等な開始を送る）。 */
  readonly onContinue: () => void;
  /** 選んだ種類で新しい Session を始める（呼び出し側が Play へ移して開始を送る）。 */
  readonly onStartNew: () => void;
}) {
  const { load, reload } = useCurrentSession();
  return (
    <main className="home">
      <h2 className="home__title">Home</h2>
      <p className="home__lead">
        No-Limit Texas Hold'em の卓に Hero として座ります。遊んだ Hand は Learn
        で振り返れます。
      </p>
      <HomeSessionPanel
        load={load}
        onReload={reload}
        pending={session.pending}
        choice={session.sessionChoice}
        onChoiceChange={session.setSessionChoice}
        onContinue={onContinue}
        onStartNew={onStartNew}
      />
    </main>
  );
}

/**
 * Home の Session の欄（照会の結果ごとの表示）。照会の結果だけで出す Button を決める:
 * - in_hand / ready_for_next_hand: 「続きから遊ぶ」だけ（新しい Session は今の Session の後）
 * - Session が無い / ended: 新しい Session の種類の選択と「新しい Session を始める」
 * - 読めない・知らない state: 開始の Button は出さず、読み直しだけ（D144 の安全側）
 */
export function HomeSessionPanel({
  load,
  onReload,
  pending,
  choice,
  onChoiceChange,
  onContinue,
  onStartNew,
}: {
  readonly load: CurrentSessionLoad;
  readonly onReload: () => void;
  /** 開始の要求を送っている間（Button を押させない）。 */
  readonly pending: boolean;
  readonly choice: SessionRequest;
  readonly onChoiceChange: (next: SessionRequest) => void;
  readonly onContinue: () => void;
  readonly onStartNew: () => void;
}) {
  return (
    <section className="home__card" aria-label="Session">
      {load.state === "loading" ? (
        <p className="home__status" role="status">
          Session の状態を確かめています…
        </p>
      ) : load.state === "failed" ? (
        <div className="notice" role="status">
          <p>
            Session
            の状態を読めませんでした。サーバーとの接続を確かめて、もう一度読み込んでください。
          </p>
          <button
            type="button"
            className="btn btn--secondary btn--sm"
            onClick={onReload}
          >
            もう一度読み込む
          </button>
        </div>
      ) : load.lookup.kind === "unknown" ? (
        <div className="notice" role="status">
          <p>
            今の Session
            の状態を、この画面では確かめられませんでした（この画面が扱えない状態です）。安全のため、ここからは
            Hand を始めません。
          </p>
          <button
            type="button"
            className="btn btn--secondary btn--sm"
            onClick={onReload}
          >
            もう一度読み込む
          </button>
        </div>
      ) : load.lookup.kind === "known" &&
        load.lookup.session.state !== "ended" ? (
        <>
          <p className="home__status">
            <strong>{kindLabel(load.lookup.session.kind)}</strong> の Session が
            {load.lookup.session.state === "in_hand"
              ? " Hand の途中です。"
              : "続いています（Hand の合間）。"}
          </p>
          <button
            type="button"
            className="btn btn--primary btn--lg"
            disabled={pending}
            onClick={onContinue}
          >
            続きから遊ぶ
          </button>
          <p className="home__note">
            新しい Session は、今の Session が終わってから始められます。
          </p>
        </>
      ) : (
        <>
          <p className="home__status">
            {load.lookup.kind === "known" ? (
              <>
                <strong>{kindLabel(load.lookup.session.kind)}</strong> の
                Session は終了しました。
              </>
            ) : (
              "続けられる Session はありません。"
            )}
          </p>
          <SessionModePicker
            value={choice}
            onChange={onChoiceChange}
            disabled={pending}
          />
          <button
            type="button"
            className="btn btn--primary btn--lg"
            disabled={pending}
            onClick={onStartNew}
          >
            新しい Session を始める
          </button>
        </>
      )}
    </section>
  );
}

/** Learn の一覧の 1 項目。action が null なら、入口の代わりに今は開けない理由（note）を出す。 */
function LearnEntry({
  title,
  description,
  action,
  note,
}: {
  readonly title: string;
  readonly description: string;
  readonly action: {
    readonly label: string;
    readonly onClick: () => void;
  } | null;
  readonly note?: string;
}) {
  return (
    <li className="learn-hub__entry">
      <h3 className="learn-hub__entry-title">{title}</h3>
      <p className="learn-hub__entry-text">{description}</p>
      {action !== null ? (
        <button
          type="button"
          className="btn btn--secondary btn--md"
          onClick={action.onClick}
        >
          {action.label}
        </button>
      ) : (
        note !== undefined && <p className="learn-hub__entry-note">{note}</p>
      )}
    </li>
  );
}

/**
 * Learn の一覧（学習の閲覧の領域。D136）。今ある機能の入口だけを置く。開くだけでは Hand・Session を作らない
 * （Drill の開始は Session Review の Recommended Drill の Button で、Hero が押したときだけ）。
 */
export function LearnHub({
  onOpenReplay,
  onOpenLastHandReview,
  onOpenSessionReview,
  onOpenDrill,
}: {
  readonly onOpenReplay: () => void;
  /** 通常の卓で直前に終わった Hand の Review（無ければ null）。 */
  readonly onOpenLastHandReview: (() => void) | null;
  /** 通常の卓の Session の Session Review（まだ Session を遊んでいなければ null）。 */
  readonly onOpenSessionReview: (() => void) | null;
  /** 始めた Drill の卓（無ければ null）。 */
  readonly onOpenDrill: (() => void) | null;
}) {
  return (
    <main className="learn-hub">
      <h2 className="learn-hub__title">Learn</h2>
      <p className="learn-hub__lead">
        保存済みの Hand と判断を振り返ります。ここで画面を開くだけでは Hand
        は進みません。
      </p>
      <ul className="learn-hub__list">
        <LearnEntry
          title="Replay"
          description="保存済みの Hand を Hero の視点で一手ずつ見返します。各 Hand から Hand Review を開けます。"
          action={{ label: "Replay を開く", onClick: onOpenReplay }}
        />
        <LearnEntry
          title="Hand Review"
          description="判断時点の Hero の情報だけで判断を振り返ります。Replay の各 Hand、または Hand の終了後の Hero の欄から開きます。"
          action={
            onOpenLastHandReview === null
              ? null
              : {
                  label: "直前の Hand の Review を開く",
                  onClick: onOpenLastHandReview,
                }
          }
          note="直前に終わった Hand があると、ここからも開けます。"
        />
        <LearnEntry
          title="Session Review"
          description="Session の判断の傾向・Recommended Drill・Drill の結果・Player Profile を見ます。"
          action={
            onOpenSessionReview === null
              ? null
              : { label: "Session Review を開く", onClick: onOpenSessionReview }
          }
          note="この画面で Session を遊ぶと、ここから開けます。"
        />
        {onOpenDrill !== null && (
          <LearnEntry
            title="Drill"
            description="Session Review の Recommended Drill から始めた練習の卓です。"
            action={{ label: "Drill の卓を開く", onClick: onOpenDrill }}
          />
        )}
      </ul>
    </main>
  );
}

/** Learn の画面（Replay・Review・Session Review）の上の「戻る」と、Learn の一覧への移動。 */
export function LearnBackBar({
  back,
  onBack,
  onLearnHome,
}: {
  readonly back: LearnReturn;
  readonly onBack: () => void;
  readonly onLearnHome: () => void;
}) {
  return (
    <nav className="learn-bar" aria-label="Learn の移動">
      <button type="button" className="btn btn--ghost btn--sm" onClick={onBack}>
        {backLabel(back)}
      </button>
      {back !== "learn" && (
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={onLearnHome}
        >
          Learn の一覧へ
        </button>
      )}
    </nav>
  );
}
