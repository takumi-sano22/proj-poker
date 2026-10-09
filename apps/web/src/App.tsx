// Basic UI: Hero として Hand を続けて遊ぶ画面。Stack は Hand をまたいで持ち越し、Hero の Bust か
// CPU の全員 Bust で Session が終わる（D80）。
// 表示はすべてサーバーの HeroView と Session の状態に基づく。クライアントは状態を進めず、合法性も判定しない（D40・D73）。
// CPU の障害で Hand が止まったら、卓の中央にダイアログを出して続け方を選ばせる（D86）。
// 見出しの切り替えで Replay（保存済みの Hand の再生。#68）を開く。Replay を見ている間も卓の Session（SSE）はそのまま続く。
// Hand が終わったら、Hero の欄と Replay から、その Hand の Review（#84）を開ける。Review と Replay は互いの場面へ移れる。
// Session が終わったら、終了の案内から Session Review（#116）を開ける。Session Review から各 Hand の Review へ移れる。
// Session Review の Recommended Drill から Targeted Drill（#117）を始められる。Drill の Hand は別の画面（同じ卓の部品）で 1 Hand だけ遊び、
// 終わったら練習した判断の Review を開ける。Drill の間も通常の卓の Session（SSE）はそのまま残り、「卓に戻る」で続きに戻る。
// 狭い画面（スマホ幅）では、卓の中央に重ねていた欄（Hand の結果・CPU 障害のダイアログ・Session 終了の案内）が席と重なるので、
// 画面下に固定した Hero の欄へ置く（#5。広い画面は従来どおり卓の中央）。
// 新しい Session の開始で Cash / Tournament の Preset を選べる（#190・D128）。Tournament の Hand では、見出しに Level・Blind・Ante を、
// 卓の右（狭い画面は卓の下）に Tournament の欄（次の Level・残人数・Payout・Elimination・終わったら Result）を出す。Cash の画面は変えない。
import type { HeroView } from "@proj-poker/engine";
import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Amount } from "./components/Amount.js";
import {
  BbDisplayProvider,
  BbDisplayToggle,
  useBbSetting,
} from "./components/BbDisplay.js";
import { ChipControls } from "./components/ChipControls.js";
import { DrillBanner } from "./components/DrillBanner.js";
import { HeroFeedback } from "./components/DealerFeedback.js";
import { FastForward } from "./components/FastForward.js";
import { HandLog } from "./components/HandLog.js";
import { OpponentNotes } from "./components/OpponentNotes.js";
import { OutageDialog } from "./components/OutageDialog.js";
import { PlayingCard } from "./components/PlayingCard.js";
import { ReplayScreen } from "./components/ReplayScreen.js";
import { ReviewScreen } from "./components/ReviewScreen.js";
import { SessionReviewScreen } from "./components/SessionReviewScreen.js";
import { Table } from "./components/Table.js";
import {
  SessionModePicker,
  TournamentPanel,
} from "./components/TournamentPanel.js";
import { UserReadToggle } from "./components/UserRead.js";
import { Term, VocabularyProvider } from "./components/Vocabulary.js";
import { useDelayed } from "./hooks/useDelayed.js";
import { useHandSession, type HandSession } from "./hooks/useHandSession.js";
import { useNarrowScreen } from "./hooks/useNarrowScreen.js";
import { useTournament } from "./hooks/useTournament.js";
import type { ReplayStart } from "./hooks/useReplay.js";
import {
  ApiError,
  type SessionStatus,
  type TournamentTableStatus,
} from "./lib/api.js";
import { startDrill, type DrillView } from "./lib/drill-api.js";
import { AI_DELAY_NOTICE_MS } from "./lib/config.js";
import { TERMS, formatChips, termLabel } from "./lib/format.js";
import { handLevelOf, tournamentEndMessage } from "./lib/tournament.js";
import {
  canFastForward,
  heroRulingStatus,
  heroSeatOf,
  lastSeqOf,
  operationKey,
  waitingMessage,
} from "./lib/view-model.js";

/**
 * 見ている画面。Replay は開く Hand と step を、Review は Hand と最初に開く判断を、Session Review は Session の Hand（どれか 1 つ）を持つ。
 */
type Screen =
  | { readonly kind: "table" }
  | { readonly kind: "replay"; readonly start: ReplayStart | null }
  | {
      readonly kind: "review";
      readonly handId: string;
      readonly decisionIndex: number | null;
    }
  | { readonly kind: "session_review"; readonly handId: string }
  | { readonly kind: "drill" };

/**
 * 表示中の Hand の Tournament の状況（#190）。Cash の Hand・まだ読めていない間・別の Hand の値は null（卓の部品は Cash のまま）。
 * Hand の結果・Session の終わりの案内（卓の中央と Hero の欄の両方の経路）が、Hero の順位と Payout を出すために読む。
 */
const TournamentContext = createContext<TournamentTableStatus | null>(null);

/** Drill の卓（#117）で、通常の卓と違う操作（練習した判断の Review・卓に戻る）。 */
interface DrillMode {
  readonly decisionIndex: number;
  readonly onExit: () => void;
}

export function App() {
  const session = useHandSession();
  const narrow = useNarrowScreen();
  const [screen, setScreen] = useState<Screen>({ kind: "table" });
  // Drill（#117）: 元の判断は ref に置き、開始の要求（再送を含む）はその値で送る。応答の Drill の説明は state に置く。
  const drillSource = useRef<{
    readonly handId: string;
    readonly decisionIndex: number;
  } | null>(null);
  const [drill, setDrill] = useState<DrillView | null>(null);
  const requestDrill = useCallback(async () => {
    const source = drillSource.current;
    if (source === null) {
      throw new ApiError("invalid_input", "Drill の元の判断が選ばれていない");
    }
    const res = await startDrill(source.handId, source.decisionIndex);
    setDrill(res.drill);
    return res;
  }, []);
  const drillSession = useHandSession({ start: requestDrill });
  const startDrillHand = drillSession.start;
  const openDrill = useCallback(
    (handId: string, decisionIndex: number) => {
      drillSource.current = { handId, decisionIndex };
      setDrill(null);
      setScreen({ kind: "drill" });
      startDrillHand();
    },
    [startDrillHand],
  );
  const backToTable = useCallback(() => setScreen({ kind: "table" }), []);
  const openReview = useCallback(
    (handId: string, decisionIndex: number | null) =>
      setScreen({ kind: "review", handId, decisionIndex }),
    [],
  );
  const openReplay = useCallback(
    (handId: string, step: number) =>
      setScreen({ kind: "replay", start: { handId, step } }),
    [],
  );
  const openSessionReview = useCallback(
    (handId: string) => setScreen({ kind: "session_review", handId }),
    [],
  );
  const { view } = session;
  // 通常の卓の Tournament の状況（Cash の Hand は null）。Drill の卓は Tournament にならないので読まない。
  const tournament = useTournament(session.handId, view);
  // 見出しの Level・Ante は表示中の Hand の公開の HAND_STARTED から作る（読み込みを待たない。Cash は null）。
  const handLevel = view === null ? null : handLevelOf(view);
  // BB 補助表示の設定（viewer ごとにこのブラウザへ保存。実額は設定に関わらず常に出す。D49）
  const [showBB, setShowBB] = useBbSetting();

  return (
    <BbDisplayProvider value={showBB}>
      {/* Fast Forward 中は卓の動きの演出（transition）も止める（D15）。待ちの短縮はサーバー側 */}
      <div className={`app${session.fastForward ? " app--fast-forward" : ""}`}>
        <header className="app__header">
          <h1 className="app__title">proj-poker</h1>
          <div className="app__header-end">
            {screen.kind === "table" &&
              view !== null &&
              (handLevel === null ? (
                <p className="app__meta">
                  ブラインド（Blinds） {formatChips(view.smallBlind)} /{" "}
                  {formatChips(view.bigBlind)}
                </p>
              ) : (
                // Tournament の Hand は Level と Ante も出す。見出しの行が折り返して卓を押し下げないよう短く書く
                // （項目の名前は Tournament の欄にある。hover では Blind の項目名を出す）。
                <p
                  className="app__meta"
                  title="Level · ブラインド（Blinds） · Ante"
                >
                  Level {handLevel.level} · {formatChips(view.smallBlind)} /{" "}
                  {formatChips(view.bigBlind)}
                  {handLevel.ante !== null && (
                    <span className="app__meta-ante"> · {handLevel.ante}</span>
                  )}
                </p>
              ))}
            <BbDisplayToggle showBB={showBB} onChange={setShowBB} />
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() =>
                setScreen(
                  screen.kind === "table"
                    ? { kind: "replay", start: null }
                    : { kind: "table" },
                )
              }
            >
              {screen.kind === "table" ? "Replay を見る" : "卓に戻る"}
            </button>
          </div>
        </header>

        {screen.kind === "replay" ? (
          // 開く Hand・step が変わったら作り直す（Review から別の場面を開いたとき）。
          <ReplayScreen
            key={
              screen.start === null
                ? "list"
                : `${screen.start.handId}:${screen.start.step}`
            }
            start={screen.start}
            onOpenReview={openReview}
          />
        ) : screen.kind === "session_review" ? (
          <SessionReviewScreen
            key={screen.handId}
            handId={screen.handId}
            onOpenReview={openReview}
            onStartDrill={openDrill}
          />
        ) : screen.kind === "drill" ? (
          // Drill の Hand（開始の応答が届くまでは準備中。前の Drill の卓は出さない）。
          drill === null ||
          drillSession.view === null ||
          drillSession.handId !== drill.drillHandId ? (
            <main className="app__empty">
              <p>Drill を準備しています…</p>
              <Notice session={drillSession} />
            </main>
          ) : (
            <TableScreen
              session={drillSession}
              narrow={narrow}
              onOpenReview={openReview}
              onOpenSessionReview={openSessionReview}
              drill={{
                decisionIndex: drill.decisionIndex,
                onExit: backToTable,
              }}
              banner={
                <DrillBanner
                  drill={drill}
                  bigBlind={drillSession.view.bigBlind}
                  players={drillSession.players}
                />
              }
            />
          )
        ) : screen.kind === "review" ? (
          <ReviewScreen
            key={`${screen.handId}:${screen.decisionIndex ?? "list"}`}
            handId={screen.handId}
            initialDecision={screen.decisionIndex}
            onOpenReplay={openReplay}
          />
        ) : view === null ? (
          <StartScreen session={session} />
        ) : (
          <TableScreen
            session={session}
            narrow={narrow}
            onOpenReview={openReview}
            onOpenSessionReview={openSessionReview}
            tournament={tournament}
          />
        )}
      </div>
    </BbDisplayProvider>
  );
}

/**
 * 最初の画面（まだ Hand が無い）。新しい Session の種類（Cash / Tournament の Preset。D128）を選んで始める。
 * 前の Session が続いていて（再起動後の Resume など）種類が違えば、サーバーが拒否し、案内から続きに戻れる（Notice）。
 */
function StartScreen({ session }: { readonly session: HandSession }) {
  return (
    <main className="app__empty">
      <p>No-Limit Texas Hold'em の卓に Hero として座ります。</p>
      <SessionModePicker
        value={session.sessionChoice}
        onChange={session.setSessionChoice}
        disabled={session.pending}
      />
      <button
        type="button"
        className="btn btn--primary btn--lg"
        disabled={session.pending}
        onClick={session.startNewSession}
      >
        Hand を始める
      </button>
      <Notice session={session} />
    </main>
  );
}

/**
 * 卓の画面（卓・進行ログ・Hero の欄）。通常の卓と Drill の卓（#117）で同じ部品を使う。
 * Drill の卓は、上に Drill の説明（banner）を置き、CPU の Note / Tag の欄を出さない（Drill の相手は Drill の設定の RuleBot）。
 * Tournament の Hand（tournament が null でない）は、進行ログの上に Tournament の欄を置く（#190。Cash の画面は変えない）。
 */
function TableScreen({
  session,
  narrow,
  onOpenReview,
  onOpenSessionReview,
  drill = null,
  banner = null,
  tournament = null,
}: {
  readonly session: HandSession;
  readonly narrow: boolean;
  readonly onOpenReview: OpenReview;
  readonly onOpenSessionReview: OpenSessionReview;
  readonly drill?: DrillMode | null;
  readonly banner?: ReactNode;
  readonly tournament?: TournamentTableStatus | null;
}) {
  const { view, players } = session;
  const nameOf = useCallback(
    (playerId: string) =>
      players.find((p) => p.playerId === playerId)?.displayName ?? playerId,
    [players],
  );
  if (view === null) {
    return <StartScreen session={session} />;
  }
  return (
    // 卓の上の用語（Poker Vocabulary）の詳細は、今の Hand の Hero に見える情報で例を作る。
    // 順位・Payout の案内は表示中の Hand の値だけで作る（欄は次の Hand を読み終えるまで前の値を出す。useTournament）。
    <TournamentContext.Provider
      value={tournament?.handId === view.handId ? tournament : null}
    >
      <VocabularyProvider view={view} nameOf={nameOf}>
        {banner}
        <main className="app__main">
          <div className="app__table">
            <Table
              view={view}
              nameOf={nameOf}
              // 狭い画面では卓の中央に何も重ねない（結果などは Hero の欄に出す）
              center={
                narrow ? null : (
                  <TableCenter
                    view={view}
                    nameOf={nameOf}
                    session={session}
                    onOpenSessionReview={onOpenSessionReview}
                    drill={drill}
                  />
                )
              }
            />
          </div>
          <aside className="app__side">
            {tournament !== null && (
              <TournamentPanel
                status={tournament}
                heroId={view.viewerId}
                nameOf={nameOf}
              />
            )}
            <HandLog view={view} nameOf={nameOf} />
            {/* Hero の CPU ごとの Note / Tag（#115）。HUD（統計）ではなく Hero 自身のメモ（D32）。Drill の卓には出さない */}
            {drill === null && (
              <OpponentNotes
                handId={view.handId}
                players={players}
                seatedIds={view.seats.map((s) => s.playerId)}
              />
            )}
          </aside>
        </main>
        <HeroDock
          view={view}
          nameOf={nameOf}
          session={session}
          narrow={narrow}
          onOpenReview={onOpenReview}
          onOpenSessionReview={onOpenSessionReview}
          drill={drill}
        />
      </VocabularyProvider>
    </TournamentContext.Provider>
  );
}

interface ViewProps {
  readonly view: HeroView;
  readonly nameOf: (playerId: string) => string;
  readonly session: HandSession;
}

/**
 * Hero の欄に出す Session の終わりの案内の状態（無ければ null）。通常の卓は、画面の幅によらず Hero の欄に出す（#158）。
 * Drill の卓は Session の終わりを案内しない（Hand が終わったら「卓に戻る」）。
 */
function sessionEndInDock(
  session: HandSession,
  drill: DrillMode | null,
): Extract<SessionStatus, { state: "ended" }> | null {
  const status = session.sessionStatus;
  return drill === null && status?.state === "ended" ? status : null;
}

/** 終わった Session の Session Review を開く（その Session の Hand を渡す）。 */
type OpenSessionReview = (handId: string) => void;

/**
 * 卓の中央の欄（広い画面）: Hand の結果、CPU の障害のダイアログのどれか（無ければ何も出さない）。
 * Session が終わった後は、獲得額の一覧だけを出す。理由と Button（振り返る・新しい Session）は Hero の欄に置く（#158）。
 * 結果の欄に Button が縦に 2 つ並ぶと背が高くなり、画面の高さによっては下の Hero の席に覆われて押せないため。
 */
function TableCenter({
  view,
  nameOf,
  session,
  onOpenSessionReview,
  drill,
}: ViewProps & {
  readonly onOpenSessionReview: OpenSessionReview;
  readonly drill: DrillMode | null;
}) {
  const sessionEnd = sessionEndInDock(session, drill);
  if (view.status === "complete") {
    return (
      <HandResult
        view={view}
        nameOf={nameOf}
        session={session}
        onOpenSessionReview={onOpenSessionReview}
        drill={drill}
        awardsOnly={sessionEnd !== null}
      />
    );
  }
  if (session.sessionStatus?.state === "ended") {
    // 障害で打ち切った Hand の後（獲得額の無い Hand）。案内は Hero の欄だけに出す。
    return null;
  }
  const outage = session.outage?.current;
  if (outage != null) {
    return (
      <OutageDialog
        actorName={nameOf(outage.playerId)}
        kind={outage.kind}
        disabled={session.pending}
        onChoose={session.resolveOutage}
      />
    );
  }
  return null;
}

/** Hand の Review を開く（decisionIndex を渡すとその判断の Review）。 */
type OpenReview = (handId: string, decisionIndex: number | null) => void;

/** 画面下に固定する Hero の欄: Hole Cards と Chip・宣言の操作、裁定と待ち・観戦の案内（狭い画面では結果・障害の欄も）。 */
function HeroDock({
  view,
  nameOf,
  session,
  narrow,
  onOpenReview,
  onOpenSessionReview,
  drill,
}: ViewProps & {
  readonly narrow: boolean;
  readonly onOpenReview: OpenReview;
  readonly onOpenSessionReview: OpenSessionReview;
  readonly drill: DrillMode | null;
}) {
  const hero = heroSeatOf(view);
  const cards = hero?.holeCards ?? [];
  const folded = hero?.folded ?? false;

  return (
    <section className="dock" aria-label="Hero">
      <div className="dock__hero">
        <div className="dock__cards" aria-label="Hero の札（Hole Cards）">
          {cards.map((card, i) => (
            <PlayingCard key={i} card={card} size="lg" muted={folded} />
          ))}
        </div>
        {hero !== undefined && (
          <div className="dock__stack">
            <span className="dock__label">
              <Term id="stack" />
            </span>
            <Amount value={hero.stack} bigBlind={view.bigBlind} />
          </div>
        )}
      </div>
      <div className="dock__controls">
        <Notice session={session} />
        <DockBody
          view={view}
          nameOf={nameOf}
          session={session}
          narrow={narrow}
          onOpenReview={onOpenReview}
          onOpenSessionReview={onOpenSessionReview}
          drill={drill}
        />
      </div>
    </section>
  );
}

function DockBody({
  view,
  nameOf,
  session,
  narrow,
  onOpenReview,
  onOpenSessionReview,
  drill,
}: ViewProps & {
  readonly narrow: boolean;
  readonly onOpenReview: OpenReview;
  readonly onOpenSessionReview: OpenSessionReview;
  readonly drill: DrillMode | null;
}) {
  const outage = session.outage;
  // CPU の手番を待っている間だけ数える（手番・障害の状態が変われば数え直す）。障害で止まっている間・Session 終了後は数えない。
  const cpuWaiting =
    view.status !== "complete" &&
    view.legalActions === null &&
    view.actorId !== null &&
    outage?.current == null &&
    session.sessionStatus?.state !== "ended";
  const delayed = useDelayed(
    cpuWaiting
      ? `${view.handId}:${lastSeqOf(view)}:${view.actorId}:${outage?.revision ?? 0}`
      : null,
    AI_DELAY_NOTICE_MS,
  );
  const sessionEnd = sessionEndInDock(session, drill);
  if (view.status === "complete") {
    // 終わった Hand は保存済みなので、その Hand の Review を開ける（卓の Session はそのまま続く）。
    // Drill の Hand は、練習した判断の Review を開く（既存の Pass A の経路。D116）。
    // 狭い画面では、卓の中央の結果の欄が席と重なるので、結果（獲得額・次の Hand へ）もここに置き、Review の Button と並べる。
    const review = (
      <button
        type="button"
        className="btn btn--secondary btn--sm"
        onClick={() =>
          onOpenReview(view.handId, drill === null ? null : drill.decisionIndex)
        }
      >
        {drill === null ? "この Hand の Review" : "練習した判断の Review"}
      </button>
    );
    return (
      <div className="dock__done">
        <p className="dock__message">
          {drill !== null
            ? "Drill の Hand が終了しました。"
            : session.sessionStatus?.state === "ended"
              ? "Session が終了しました。"
              : "Hand が終了しました。"}
        </p>
        {narrow ? (
          <HandResult
            view={view}
            nameOf={nameOf}
            session={session}
            onOpenSessionReview={onOpenSessionReview}
            drill={drill}
            docked
            actions={review}
          />
        ) : sessionEnd !== null ? (
          // 広い画面でも、Session の終わりの案内は Hero の欄に置く（獲得額の一覧は卓の中央。#158）
          <>
            <SessionEnded
              status={sessionEnd}
              session={session}
              onOpenSessionReview={() => onOpenSessionReview(view.handId)}
              docked
            />
            {review}
          </>
        ) : (
          review
        )}
      </div>
    );
  }
  if (session.sessionStatus?.state === "ended") {
    return narrow || sessionEnd !== null ? (
      <SessionEnded
        status={session.sessionStatus}
        session={session}
        onOpenSessionReview={() => onOpenSessionReview(view.handId)}
        docked
      />
    ) : (
      <p className="dock__message">Session が終了しました。</p>
    );
  }
  if (outage?.current != null) {
    // 狭い画面では、席と重ならないよう、ダイアログそのものをここに出す（広い画面は卓の中央）。
    return narrow ? (
      <OutageDialog
        actorName={nameOf(outage.current.playerId)}
        kind={outage.current.kind}
        disabled={session.pending}
        docked
        onChoose={session.resolveOutage}
      />
    ) : (
      <p className="dock__message">
        {nameOf(outage.current.playerId)} の判断を待てず、Hand
        を一時停止しています。卓の中央で続け方を選んでください。
      </p>
    );
  }
  const hero = heroSeatOf(view);
  const waiting = waitingMessage(
    view.actorId === null ? null : nameOf(view.actorId),
    delayed,
  );
  // Fast Forward は Hero が Fold した後（または Hand から外れている間）の観戦だけ。待ちの案内（waiting）は速さに依らず変えない
  // （AI の応答は縮まないので、Fast Forward 中も「<CPU 名> の手番…」のまま出す。D93）。
  const fastForward = canFastForward(view) && (
    <FastForward
      active={session.fastForward}
      disabled={session.fastForwardPending}
      onChange={session.setFastForward}
    />
  );
  if (hero === undefined) {
    return (
      <>
        <p className="dock__message">{waiting}</p>
        {fastForward}
      </>
    );
  }
  if (hero.folded) {
    // Fold 後も観戦を続ける（docs/06 §8）。他者の札は Showdown で公開されたものだけが表に向く。
    return (
      <>
        <p className="dock__message">
          フォールド（Fold）しました。Hand の終了まで観戦します。{waiting}
        </p>
        {fastForward}
      </>
    );
  }
  if (hero.allIn) {
    return (
      <p className="dock__message">
        オールイン（All-in）しました。Hand の終了まで進行を待ちます。{waiting}
      </p>
    );
  }
  const ruling = heroRulingStatus(view);
  return (
    <>
      <HeroFeedback view={view} />
      {view.legalActions !== null ? (
        // 手番の間だけ、判断の前の読み（User Read。D112）を記録できる。閉じている間は案内の右の Button 1 つ。
        <div className="dock__turn">
          <p className="dock__message">Hero の手番です。</p>
          <UserReadToggle
            key={view.handId}
            view={view}
            nameOf={nameOf}
            disabled={session.pending}
            onRecord={session.recordRead}
          />
        </div>
      ) : (
        <p className="dock__message">{waiting}</p>
      )}
      {/* 手番でなくても操作できる（Out-of-Turn も裁定の対象。D91）。保留中は Hero の手番で裁定されるまで次の操作を送れない。
          操作の下書きは、裁定が 1 つ進む・Street が進むたびに捨てる（送った操作を持ち越さない）。 */}
      <ChipControls
        key={operationKey(view)}
        view={view}
        hero={hero}
        disabled={session.pending || ruling?.kind === "pending"}
        onSubmit={session.operate}
      />
    </>
  );
}

/**
 * Session が終わった理由の案内（D80）。Tournament の Hand で、その Hand の状況が読めていれば、Hero の順位と Payout を 1 文で出す
 * （#190・D129。読めるまでは Cash と同じ文）。
 */
function sessionEndMessage(
  status: Extract<SessionStatus, { state: "ended" }>,
  tournament: TournamentTableStatus | null,
  heroId: string | undefined,
): string {
  const tournamentEnd =
    tournament === null || heroId === undefined
      ? null
      : tournamentEndMessage(tournament.result, heroId);
  if (tournamentEnd !== null) return tournamentEnd;
  switch (status.reason) {
    case "hero_busted":
      return "Hero の Stack がなくなりました（Bust）。この Session は終了です。";
    case "hero_last_standing":
      return "CPU が全員 Bust し、Hero が勝ち残りました。この Session は終了です。";
    case "ai_outage":
      return "AI の判断を受け取れなかったため、この Hand を打ち切って Session を終了しました。";
  }
}

/** Session を振り返る Button（Session Review。#116）。終わった Session の案内に置く。 */
function SessionReviewButton({ onClick }: { readonly onClick: () => void }) {
  return (
    <button
      type="button"
      className="btn btn--secondary btn--md"
      onClick={onClick}
    >
      この Session を振り返る
    </button>
  );
}

/** 新しい Session の種類の選択と「新しい Session を始める」Button（#190）。終わった Session の案内に置く。 */
function NewSessionControls({ session }: { readonly session: HandSession }) {
  return (
    <>
      <SessionModePicker
        value={session.sessionChoice}
        onChange={session.setSessionChoice}
        disabled={session.pending}
        compact
      />
      <button
        type="button"
        className="btn btn--primary btn--md"
        disabled={session.pending}
        onClick={session.startNewSession}
      >
        新しい Session を始める
      </button>
    </>
  );
}

/** Session が終わった後の案内（理由と、Session を振り返る・新しい Session を始める Button）。 */
function SessionEnded({
  status,
  session,
  onOpenSessionReview,
  docked = false,
}: {
  readonly status: Extract<SessionStatus, { state: "ended" }>;
  readonly session: HandSession;
  readonly onOpenSessionReview: () => void;
  readonly docked?: boolean;
}) {
  const tournament = useContext(TournamentContext);
  return (
    <div className={resultClass(docked)} role="status">
      <p className="result__session">
        {sessionEndMessage(status, tournament, session.view?.viewerId)}
      </p>
      <SessionReviewButton onClick={onOpenSessionReview} />
      <NewSessionControls session={session} />
    </div>
  );
}

function resultClass(docked: boolean): string {
  return docked ? "result result--docked" : "result";
}

/**
 * Hand の結果（広い画面は卓の中央、狭い画面は Hero の欄）。獲得額は実額で出す。
 * 次 Hand のボタンは Session が続くときだけ出し、Session が終わったら理由と、Session を振り返る・新しい Session を始めるボタンを出す。
 * Session の状態がまだ届いていなければ、どちらのボタンも出さない（終わった Session で次 Hand を押させない）。
 * actions は Button の並びの末尾に足す（Hero の欄では Review の Button を同じ行に置く）。
 */
function HandResult({
  view,
  nameOf,
  session,
  onOpenSessionReview,
  drill = null,
  docked = false,
  actions = null,
  awardsOnly = false,
}: ViewProps & {
  readonly onOpenSessionReview: OpenSessionReview;
  /** 獲得額の一覧だけを出す（Session の終わりの案内と Button は Hero の欄に出すとき。#158）。 */
  readonly awardsOnly?: boolean;
  /** Drill の Hand（#117）は 1 Hand だけなので、次の Hand・Session の案内の代わりに「卓に戻る」を出す。 */
  readonly drill?: DrillMode | null;
  readonly docked?: boolean;
  readonly actions?: ReactNode;
}) {
  const status = session.sessionStatus;
  const tournament = useContext(TournamentContext);
  if (drill !== null) {
    return (
      <div className={resultClass(docked)} role="status">
        <ul className="result__list">
          {view.awards.map((a) => (
            <li key={a.playerId}>
              {nameOf(a.playerId)} が {termLabel(TERMS.pot)}{" "}
              <Amount value={a.amount} bigBlind={view.bigBlind} inline /> を獲得
            </li>
          ))}
        </ul>
        <p className="result__session">
          結果は運を含みます。練習した判断は Review で見直せます（通常の Score
          とは別に数えます）。
        </p>
        <button
          type="button"
          className="btn btn--primary btn--md"
          onClick={drill.onExit}
        >
          卓に戻る
        </button>
        {actions}
      </div>
    );
  }
  return (
    <div className={resultClass(docked)} role="status">
      <ul className="result__list">
        {view.awards.map((a) => (
          <li key={a.playerId}>
            {nameOf(a.playerId)} が {termLabel(TERMS.pot)}{" "}
            <Amount value={a.amount} bigBlind={view.bigBlind} inline /> を獲得
          </li>
        ))}
      </ul>
      {!awardsOnly && status?.state === "ended" && (
        <p className="result__session">
          {sessionEndMessage(status, tournament, view.viewerId)}
        </p>
      )}
      {status?.state === "ready_for_next_hand" && (
        <button
          type="button"
          className="btn btn--primary btn--md"
          disabled={session.pending}
          onClick={session.start}
        >
          次の Hand へ
        </button>
      )}
      {!awardsOnly && status?.state === "ended" && (
        <SessionReviewButton onClick={() => onOpenSessionReview(view.handId)} />
      )}
      {!awardsOnly && status?.state === "ended" && (
        <NewSessionControls session={session} />
      )}
      {actions}
    </div>
  );
}

/** 失敗・接続の案内。一時的な失敗は驚かせない文言で再送へ誘導する。 */
function Notice({ session }: { readonly session: HandSession }) {
  const { notice, connection, view } = session;
  const connectionText =
    view?.status === "complete"
      ? null
      : connection === "reconnecting"
        ? "サーバーとの接続を再開しています…"
        : connection === "lost"
          ? "サーバーとの接続が切れました。「卓に戻る」で、進行中の Hand があればその続きを、無ければ新しい Session を始めます。"
          : null;
  if (notice === null && connectionText === null) return null;
  return (
    <div className="notice" role="status">
      {notice !== null && <p>{notice.message}</p>}
      {connectionText !== null && <p>{connectionText}</p>}
      {notice?.retryable && (
        <button
          type="button"
          className="btn btn--secondary btn--sm"
          disabled={session.pending}
          onClick={session.retry}
        >
          もう一度送る
        </button>
      )}
      {notice?.continueSession === true && (
        // 前の Session が続いていて、選んだ種類の Session を始められなかった。設定を送らずに続きへ戻る。
        <button
          type="button"
          className="btn btn--secondary btn--sm"
          disabled={session.pending}
          onClick={session.start}
        >
          続きから遊ぶ
        </button>
      )}
      {connection === "lost" && view?.status !== "complete" && (
        <button
          type="button"
          className="btn btn--secondary btn--sm"
          disabled={session.pending}
          onClick={session.start}
        >
          卓に戻る
        </button>
      )}
    </div>
  );
}
