// Basic UI: Hero として Hand を続けて遊ぶ画面。Stack は Hand をまたいで持ち越し、Hero の Bust か
// CPU の全員 Bust で Session が終わる（D80）。
// 表示はすべてサーバーの HeroView と Session の状態に基づく。クライアントは状態を進めず、合法性も判定しない（D40・D73）。
// CPU の障害で Hand が止まったら、卓の中央にダイアログを出して続け方を選ばせる（D86）。
import type { HeroView } from "@proj-poker/engine";
import { useCallback } from "react";
import { Amount } from "./components/Amount.js";
import { ChipControls } from "./components/ChipControls.js";
import { HandLog } from "./components/HandLog.js";
import { OutageDialog } from "./components/OutageDialog.js";
import { PlayingCard } from "./components/PlayingCard.js";
import { Table } from "./components/Table.js";
import { useDelayed } from "./hooks/useDelayed.js";
import { useHandSession, type HandSession } from "./hooks/useHandSession.js";
import type { SessionStatus } from "./lib/api.js";
import { AI_DELAY_NOTICE_MS } from "./lib/config.js";
import { TERMS, formatChips, termLabel } from "./lib/format.js";
import {
  heroRulingStatus,
  heroSeatOf,
  lastSeqOf,
  operationKey,
  rulingText,
  waitingMessage,
} from "./lib/view-model.js";

export function App() {
  const session = useHandSession();
  const { view, players } = session;
  const nameOf = useCallback(
    (playerId: string) =>
      players.find((p) => p.playerId === playerId)?.displayName ?? playerId,
    [players],
  );

  return (
    <div className="app">
      <header className="app__header">
        <h1 className="app__title">proj-poker</h1>
        {view !== null && (
          <p className="app__meta">
            ブラインド（Blinds） {formatChips(view.smallBlind)} /{" "}
            {formatChips(view.bigBlind)}
          </p>
        )}
      </header>

      {view === null ? (
        <main className="app__empty">
          <p>No-Limit Texas Hold'em の卓に Hero として座ります。</p>
          <button
            type="button"
            className="btn btn--primary btn--lg"
            disabled={session.pending}
            onClick={session.start}
          >
            Hand を始める
          </button>
          <Notice session={session} />
        </main>
      ) : (
        <>
          <main className="app__main">
            <div className="app__table">
              <Table
                view={view}
                nameOf={nameOf}
                center={
                  <TableCenter view={view} nameOf={nameOf} session={session} />
                }
              />
            </div>
            <aside className="app__side">
              <HandLog view={view} nameOf={nameOf} />
            </aside>
          </main>
          <HeroDock view={view} nameOf={nameOf} session={session} />
        </>
      )}
    </div>
  );
}

interface ViewProps {
  readonly view: HeroView;
  readonly nameOf: (playerId: string) => string;
  readonly session: HandSession;
}

/**
 * 卓の中央の欄: Hand の結果、CPU の障害のダイアログ、障害で Session を終えた後の案内のどれか（無ければ何も出さない）。
 */
function TableCenter({ view, nameOf, session }: ViewProps) {
  if (view.status === "complete") {
    return <HandResult view={view} nameOf={nameOf} session={session} />;
  }
  const status = session.sessionStatus;
  if (status?.state === "ended") {
    return (
      <div className="result" role="status">
        <p className="result__session">{sessionEndMessage(status)}</p>
        <button
          type="button"
          className="btn btn--primary btn--md"
          disabled={session.pending}
          onClick={session.start}
        >
          新しい Session を始める
        </button>
      </div>
    );
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

/** 画面下に固定する Hero の欄: Hole Cards と Chip・宣言の操作、裁定と待ち・観戦の案内。 */
function HeroDock({ view, nameOf, session }: ViewProps) {
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
            <span className="dock__label">{termLabel(TERMS.stack)}</span>
            <Amount value={hero.stack} bigBlind={view.bigBlind} />
          </div>
        )}
      </div>
      <div className="dock__controls">
        <Notice session={session} />
        <DockBody view={view} nameOf={nameOf} session={session} />
      </div>
    </section>
  );
}

function DockBody({ view, nameOf, session }: ViewProps) {
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
  if (view.status === "complete") {
    return (
      <p className="dock__message">
        {session.sessionStatus?.state === "ended"
          ? "Session が終了しました。"
          : "Hand が終了しました。"}
      </p>
    );
  }
  if (session.sessionStatus?.state === "ended") {
    return <p className="dock__message">Session が終了しました。</p>;
  }
  if (outage?.current != null) {
    return (
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
  if (hero === undefined) return <p className="dock__message">{waiting}</p>;
  if (hero.folded) {
    // Fold 後も観戦を続ける（docs/06 §8）。他者の札は Showdown で公開されたものだけが表に向く。
    return (
      <p className="dock__message">
        フォールド（Fold）しました。Hand の終了まで観戦します。{waiting}
      </p>
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
      {ruling !== null && (
        <p className="dock__ruling" role="status">
          {rulingText(ruling)}
        </p>
      )}
      <p className="dock__message">
        {view.legalActions !== null ? "Hero の手番です。" : waiting}
      </p>
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

/** Session が終わった理由の案内（D80）。 */
function sessionEndMessage(
  status: Extract<SessionStatus, { state: "ended" }>,
): string {
  switch (status.reason) {
    case "hero_busted":
      return "Hero の Stack がなくなりました（Bust）。この Session は終了です。";
    case "hero_last_standing":
      return "CPU が全員 Bust し、Hero が勝ち残りました。この Session は終了です。";
    case "ai_outage":
      return "AI の判断を受け取れなかったため、この Hand を打ち切って Session を終了しました。";
  }
}

/**
 * Hand の結果（卓の中央）。獲得額は実額で出す。
 * 次 Hand のボタンは Session が続くときだけ出し、Session が終わったら理由と、新しい Session を始めるボタンを出す。
 * Session の状態がまだ届いていなければ、どちらのボタンも出さない（終わった Session で次 Hand を押させない）。
 */
function HandResult({ view, nameOf, session }: ViewProps) {
  const status = session.sessionStatus;
  return (
    <div className="result" role="status">
      <ul className="result__list">
        {view.awards.map((a) => (
          <li key={a.playerId}>
            {nameOf(a.playerId)} が {termLabel(TERMS.pot)}{" "}
            <Amount value={a.amount} bigBlind={view.bigBlind} inline /> を獲得
          </li>
        ))}
      </ul>
      {status?.state === "ended" && (
        <p className="result__session">{sessionEndMessage(status)}</p>
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
      {status?.state === "ended" && (
        <button
          type="button"
          className="btn btn--primary btn--md"
          disabled={session.pending}
          onClick={session.start}
        >
          新しい Session を始める
        </button>
      )}
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
