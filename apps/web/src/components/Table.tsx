// 2D の卓（docs/06 §1）。席・Stack 実額・Dealer Button・SB / BB・Community Cards・Pot・手番を、
// サーバーが返した HeroView だけから描く。他者の札は seats[].holeCards に入っているもの（Showdown で公開された札）だけを表に向ける。
import type { HeroView, SeatView } from "@proj-poker/engine";
import type { CSSProperties, ReactNode } from "react";
import { TERMS, formatChips, termLabel } from "../lib/format.js";
import {
  blindsOf,
  seatDirections,
  type SeatDirection,
} from "../lib/view-model.js";
import { useNarrowScreen } from "../hooks/useNarrowScreen.js";
import { Amount } from "./Amount.js";
import { ChipStack } from "./ChipStack.js";
import { CardSlot, PlayingCard } from "./PlayingCard.js";
import { Term } from "./Vocabulary.js";

const BOARD_SIZE = 5;

/**
 * 卓の中央の高さに席の面が来る席数（真横の席がある 4・8 人、斜めの席が中央に近い 5・7 人）。
 * 狭い画面では中央の使える幅が狭いので、Street / Board / Pot を縦に積む（styles.css の data-center-stacked）。
 */
const CENTER_STACKED_SEAT_COUNTS: ReadonlySet<number> = new Set([4, 5, 7, 8]);

interface TableProps {
  readonly view: HeroView;
  readonly nameOf: (playerId: string) => string;
  /** 卓の中央に重ねる内容（Hand の結果など）。 */
  readonly center?: ReactNode;
}

export function Table({ view, nameOf, center }: TableProps) {
  const heroIndex = Math.max(
    0,
    view.seats.findIndex((s) => s.playerId === view.viewerId),
  );
  const directions = seatDirections(view.seats.length, heroIndex);
  const blinds = blindsOf(view);
  const narrow = useNarrowScreen();

  return (
    <section
      className="table"
      aria-label="卓"
      data-seat-count={view.seats.length}
      data-center-stacked={
        CENTER_STACKED_SEAT_COUNTS.has(view.seats.length) ? "" : undefined
      }
    >
      <div className="table__felt">
        <div className="table__center">
          <p className="table__street">
            {view.status === "complete" ? (
              "Hand 終了"
            ) : (
              <Term id={view.street} className="term--on-felt" />
            )}
          </p>
          <div
            className="board"
            aria-label="コミュニティカード（Community Cards）"
          >
            {Array.from({ length: BOARD_SIZE }, (_, i) => {
              const card = view.board[i];
              return card === undefined ? (
                <CardSlot key={i} />
              ) : (
                <PlayingCard key={i} card={card} />
              );
            })}
          </div>
          <div
            className="pot"
            aria-label={`${termLabel(TERMS.pot)} ${formatChips(view.pot)}`}
          >
            <span className="pot__label">
              <Term id="pot" className="term--on-felt" />
            </span>
            <Amount value={view.pot} bigBlind={view.bigBlind} />
          </div>
          {center}
        </div>
      </div>

      {view.seats.map((seat, i) => {
        const direction = directions[i] as SeatDirection;
        return (
          <Seat
            key={seat.playerId}
            seat={seat}
            direction={direction}
            name={nameOf(seat.playerId)}
            blind={blinds.get(seat.playerId)}
            isHero={seat.playerId === view.viewerId}
            isActor={
              view.status === "in_progress" && seat.playerId === view.actorId
            }
            bigBlind={view.bigBlind}
            // Hand の終了後は Pot を配り終えているので、この Street の Bet を卓に残さない
            showBet={view.status === "in_progress"}
            betInside={narrow}
          />
        );
      })}
    </section>
  );
}

interface SeatProps {
  readonly seat: SeatView;
  readonly direction: SeatDirection;
  readonly name: string;
  readonly blind: "small" | "big" | undefined;
  readonly isHero: boolean;
  readonly isActor: boolean;
  readonly bigBlind: number;
  readonly showBet: boolean;
  /** Bet の札を席の面の中に置くか（狭い画面。席と中央の間に Bet が収まらないので、席に付けて動かす）。 */
  readonly betInside?: boolean;
}

export function Seat({
  seat,
  direction,
  name,
  blind,
  isHero,
  isActor,
  bigBlind,
  showBet,
  betInside = false,
}: SeatProps) {
  const classes = [
    "seat",
    isHero ? "seat--hero" : "",
    isActor ? "seat--actor" : "",
    seat.folded ? "seat--folded" : "",
  ]
    .filter(Boolean)
    .join(" ");
  // 席と Bet の位置は向きだけを渡し、半径は CSS（画面幅ごと）で決める。
  const placement = {
    "--dir-x": direction.x,
    "--dir-y": direction.y,
  } as CSSProperties;

  return (
    <>
      <div
        className={classes}
        style={placement}
        data-player-id={seat.playerId}
        aria-current={isActor ? "true" : undefined}
      >
        {/* Hero の札は画面下の操作欄に大きく出すため、卓の上では他者の札だけを描く */}
        {!isHero && <SeatCards seat={seat} />}
        <div className="seat__plate">
          <div className="seat__name-row">
            <span className="seat__name">{name}</span>
            {seat.isButton && (
              <Term id="button" className="term--bare dealer-button">
                D
              </Term>
            )}
            {blind !== undefined && (
              <Term
                id={blind === "small" ? "smallBlind" : "bigBlind"}
                className="term--bare badge"
              >
                {blind === "small" ? "SB" : "BB"}
              </Term>
            )}
          </div>
          <div
            className="seat__stack"
            aria-label={`${termLabel(TERMS.stack)} ${formatChips(seat.stack)}`}
          >
            <Amount value={seat.stack} bigBlind={bigBlind} inline />
          </div>
          <ChipStack amount={seat.stack} />
          {showBet && betInside && seat.streetCommitted > 0 && (
            <BetPill name={name} seat={seat} bigBlind={bigBlind} inside />
          )}
          <SeatStatus seat={seat} isActor={isActor} />
        </div>
      </div>
      {showBet && !betInside && seat.streetCommitted > 0 && (
        <BetPill
          name={name}
          seat={seat}
          bigBlind={bigBlind}
          placement={placement}
        />
      )}
    </>
  );
}

/** この Street の Bet の札（Chip の積み + 実額）。席の前（卓の上）か、席の面の中（inside）に置く。 */
function BetPill({
  name,
  seat,
  bigBlind,
  placement,
  inside = false,
}: {
  readonly name: string;
  readonly seat: SeatView;
  readonly bigBlind: number;
  readonly placement?: CSSProperties;
  readonly inside?: boolean;
}) {
  return (
    <div
      className={inside ? "bet bet--inside" : "bet"}
      style={placement}
      aria-label={`${name} のベット ${formatChips(seat.streetCommitted)}`}
    >
      <ChipStack amount={seat.streetCommitted} />
      <Amount value={seat.streetCommitted} bigBlind={bigBlind} inline />
    </div>
  );
}

function SeatCards({ seat }: { readonly seat: SeatView }) {
  if (seat.holeCards !== null) {
    return (
      <div className="seat__cards">
        {seat.holeCards.map((card, i) => (
          <PlayingCard key={i} card={card} size="sm" muted={seat.folded} />
        ))}
      </div>
    );
  }
  // Fold した席には札を描かない。残っている席は中身を知らないので裏向きで描く。
  if (seat.folded) return <div className="seat__cards seat__cards--empty" />;
  return (
    <div className="seat__cards">
      <PlayingCard card={null} size="sm" />
      <PlayingCard card={null} size="sm" />
    </div>
  );
}

function SeatStatus({
  seat,
  isActor,
}: {
  readonly seat: SeatView;
  readonly isActor: boolean;
}) {
  if (seat.folded)
    return (
      <span className="seat__status">
        <Term id="fold" className="term--quiet" />
      </span>
    );
  if (seat.allIn)
    return (
      <span className="seat__status seat__status--strong">
        <Term id="allIn" className="term--quiet" />
      </span>
    );
  if (isActor)
    return <span className="seat__status seat__status--turn">手番</span>;
  return null;
}
