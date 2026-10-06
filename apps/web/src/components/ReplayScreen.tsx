// Replay の画面（#68・D93・docs/06 §10）。Hand 一覧から選び、保存済みの Event を Hero の視点で Previous / Next / Play / Pause で再生する。
// 表示はサーバーが返した step（Hero の視点の HeroView）だけに基づき、他者の札は Showdown で公開された時点から表に向く。
// 卓・進行ログ・Chip の構成（#62）・Dealer Feedback（#66）・用語の詳細は、卓の画面と同じ部品を使う。
// Learning-only Full Reveal と Jump to Important Spot は Phase 5 の Review で扱う（D93）。
import type { HeroView } from "@proj-poker/engine";
import { useCallback } from "react";
import { useReplay, type ReplayState } from "../hooks/useReplay.js";
import type { ReplayHand } from "../lib/api.js";
import { TERMS, termLabel } from "../lib/format.js";
import {
  formatHeroNet,
  formatStartedAt,
  heroCardsLabel,
  stepCaption,
} from "../lib/replay.js";
import { heroSeatOf } from "../lib/view-model.js";
import { Amount } from "./Amount.js";
import { useShowBB } from "./BbDisplay.js";
import { HeroFeedback } from "./DealerFeedback.js";
import { HandLog } from "./HandLog.js";
import { PlayingCard } from "./PlayingCard.js";
import { Table } from "./Table.js";
import { Term, VocabularyProvider } from "./Vocabulary.js";

export function ReplayScreen() {
  const replay = useReplay();
  return replay.hand === null ? (
    <ReplayList replay={replay} />
  ) : (
    <ReplayPlayer replay={replay} hand={replay.hand} />
  );
}

function ReplayList({ replay }: { readonly replay: ReplayState }) {
  const showBB = useShowBB();
  const { hands, listLoad, handLoad } = replay;
  return (
    <main className="replay-list">
      <div className="replay-list__head">
        <h2 className="replay-list__title">Replay（Hand 一覧）</h2>
        <button
          type="button"
          className="btn btn--secondary btn--sm"
          disabled={listLoad === "loading"}
          onClick={replay.refresh}
        >
          一覧を更新
        </button>
      </div>
      <p className="replay-list__note">
        保存した Hand を Hero の視点で一手ずつ再生します。途中で終わった Hand
        は「未完了」と表示し、サーバーを再起動すると一覧から消えます。
      </p>
      {listLoad === "failed" && (
        <p className="notice" role="status">
          一覧を読み込めませんでした。「一覧を更新」でもう一度読み込んでください。
        </p>
      )}
      {handLoad === "failed" && (
        <p className="notice" role="status">
          Hand を読み込めませんでした。もう一度選んでください。
        </p>
      )}
      {hands === null ? (
        listLoad === "loading" && (
          <p className="replay-list__empty">読み込んでいます…</p>
        )
      ) : hands.length === 0 ? (
        <p className="replay-list__empty">
          まだ再生できる Hand がありません。卓で Hand を遊ぶと、ここに並びます。
        </p>
      ) : (
        <ul className="replay-list__items">
          {hands.map((h) => {
            const net = formatHeroNet(h, showBB);
            return (
              <li key={h.handId}>
                <button
                  type="button"
                  className="replay-item"
                  disabled={handLoad === "loading"}
                  onClick={() => replay.open(h.handId)}
                >
                  <span className="replay-item__time">
                    {formatStartedAt(h.startedAt)}
                  </span>
                  <span className="replay-item__cards">
                    {heroCardsLabel(h)}
                  </span>
                  {net === null ? (
                    <span className="badge replay-item__badge">未完了</span>
                  ) : (
                    <span className="replay-item__net">{net}</span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}

interface PlayerProps {
  readonly replay: ReplayState;
  readonly hand: ReplayHand;
}

function ReplayPlayer({ replay, hand }: PlayerProps) {
  const { players, steps } = hand;
  const nameOf = useCallback(
    (playerId: string) =>
      players.find((p) => p.playerId === playerId)?.displayName ?? playerId,
    [players],
  );
  const view = steps[replay.step] ?? steps.at(-1);
  if (view === undefined) return null;
  const last = steps.length - 1;
  const hero = heroSeatOf(view);

  return (
    <VocabularyProvider view={view} nameOf={nameOf}>
      <div className="replay__head">
        <p className="replay__title">
          Replay（Hero の視点）
          {!hand.complete && <span className="badge">未完了</span>}
        </p>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={replay.close}
        >
          一覧へ戻る
        </button>
      </div>
      <main className="app__main">
        <div className="app__table">
          <Table
            view={view}
            nameOf={nameOf}
            center={
              <ReplayCenter
                view={view}
                nameOf={nameOf}
                atEnd={replay.step >= last}
                complete={hand.complete}
              />
            }
          />
        </div>
        <aside className="app__side">
          <HandLog view={view} nameOf={nameOf} />
        </aside>
      </main>
      <section className="dock" aria-label="Replay の操作">
        <div className="dock__hero">
          <div className="dock__cards" aria-label="Hero の札（Hole Cards）">
            {(hero?.holeCards ?? []).map((card, i) => (
              <PlayingCard
                key={i}
                card={card}
                size="lg"
                muted={hero?.folded ?? false}
              />
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
          <div className="replay__now">
            <p className="replay__caption" aria-live="polite">
              {stepCaption(view, nameOf)}
            </p>
            <span className="replay__count">
              {replay.step + 1} / {steps.length}
            </span>
          </div>
          <HeroFeedback view={view} />
          {/* 狭い画面でも 3 つが 1 行に並ぶよう、ラベルは日本語と英語の 2 段にする */}
          <div className="replay-controls">
            <button
              type="button"
              className="btn btn--secondary btn--sm"
              disabled={replay.step <= 0}
              onClick={replay.previous}
            >
              <span>前へ</span>{" "}
              <span className="replay-controls__sub">Previous</span>
            </button>
            {replay.playing ? (
              <button
                type="button"
                className="btn btn--primary btn--sm"
                onClick={replay.pause}
              >
                <span>一時停止</span>{" "}
                <span className="replay-controls__sub">Pause</span>
              </button>
            ) : (
              <button
                type="button"
                className="btn btn--primary btn--sm"
                disabled={last <= 0}
                onClick={replay.play}
              >
                <span>再生</span>{" "}
                <span className="replay-controls__sub">Play</span>
              </button>
            )}
            <button
              type="button"
              className="btn btn--secondary btn--sm"
              disabled={replay.step >= last}
              onClick={replay.next}
            >
              <span>次へ</span>{" "}
              <span className="replay-controls__sub">Next</span>
            </button>
          </div>
        </div>
      </section>
    </VocabularyProvider>
  );
}

interface CenterProps {
  readonly view: HeroView;
  readonly nameOf: (playerId: string) => string;
  readonly atEnd: boolean;
  readonly complete: boolean;
}

/** 卓の中央: Hand の結果（獲得額は実額）か、未完了の Hand の最後の step の案内。 */
function ReplayCenter({ view, nameOf, atEnd, complete }: CenterProps) {
  if (view.status === "complete") {
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
      </div>
    );
  }
  if (atEnd && !complete) {
    return (
      <div className="result" role="status">
        <p className="result__session">
          この Hand はここで止まっています（未完了）。
        </p>
      </div>
    );
  }
  return null;
}
