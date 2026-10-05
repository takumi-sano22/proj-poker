// Basic UI（Phase 1）: Hero として 1 Hand を最後まで遊ぶ画面。
// 表示はすべてサーバーの HeroView に基づく。クライアントは状態を進めず、合法性も判定しない（D40・D73）。
import type { HeroView } from "@proj-poker/engine";
import { useCallback } from "react";
import { ActionBar } from "./components/ActionBar.js";
import { Amount } from "./components/Amount.js";
import { HandLog } from "./components/HandLog.js";
import { PlayingCard } from "./components/PlayingCard.js";
import { Table } from "./components/Table.js";
import { useHandSession, type HandSession } from "./hooks/useHandSession.js";
import { TERMS, formatChips, termLabel } from "./lib/format.js";
import { heroSeatOf, lastSeqOf } from "./lib/view-model.js";

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
                  view.status === "complete" ? (
                    <HandResult view={view} nameOf={nameOf} session={session} />
                  ) : null
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

/** 画面下に固定する Hero の欄: Hole Cards と Declaration Button、待ち・観戦の案内。 */
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
  if (view.status === "complete") {
    return <p className="dock__message">Hand が終了しました。</p>;
  }
  if (view.legalActions !== null) {
    return (
      // 新しい判断のたびに額の選択を初期化する（前の判断の Slider 位置を持ち越さない）。
      <ActionBar
        key={lastSeqOf(view)}
        view={view}
        legal={view.legalActions}
        disabled={session.pending}
        onAction={session.act}
      />
    );
  }
  const hero = heroSeatOf(view);
  const waiting =
    view.actorId === null ? "進行中…" : `${nameOf(view.actorId)} の手番…`;
  if (hero?.folded) {
    // Fold 後も観戦を続ける（docs/06 §8）。他者の札は Showdown で公開されたものだけが表に向く。
    return (
      <p className="dock__message">
        フォールド（Fold）しました。Hand の終了まで観戦します。{waiting}
      </p>
    );
  }
  return <p className="dock__message">{waiting}</p>;
}

/** Hand の結果（卓の中央）。獲得額は実額で出す。 */
function HandResult({ view, nameOf, session }: ViewProps) {
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
      <button
        type="button"
        className="btn btn--primary btn--md"
        disabled={session.pending}
        onClick={session.start}
      >
        次の Hand へ
      </button>
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
          ? "サーバーとの接続が切れました。新しい Hand を始めてください。"
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
          新しい Hand を始める
        </button>
      )}
    </div>
  );
}
