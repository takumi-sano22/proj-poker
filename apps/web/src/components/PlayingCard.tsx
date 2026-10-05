// Card の構造描画（D60: 52 枚を画像にせず SVG で描く。色は CSS のトークンで差し替えられる）。
import type { Card } from "@proj-poker/engine";
import {
  SUIT_SYMBOLS,
  cardSpokenLabel,
  isRedSuit,
  rankLabel,
} from "../lib/format.js";

export type CardSize = "sm" | "md" | "lg";

interface PlayingCardProps {
  /** null は裏向き（中身を知らない札）。中身はサーバーが公開したものだけを渡す。 */
  readonly card: Card | null;
  readonly size?: CardSize;
  /** Fold 済みなど、強調を下げて見せる。 */
  readonly muted?: boolean;
}

export function PlayingCard({
  card,
  size = "md",
  muted = false,
}: PlayingCardProps) {
  const className = `card card--${size}${muted ? " card--muted" : ""}`;
  if (card === null) {
    return (
      <svg
        className={className}
        viewBox="0 0 50 70"
        role="img"
        aria-label="伏せた札"
      >
        <rect
          className="card__back"
          x="0.5"
          y="0.5"
          width="49"
          height="69"
          rx="5"
        />
        <rect
          className="card__back-inner"
          x="5"
          y="5"
          width="40"
          height="60"
          rx="3"
        />
        <path className="card__back-mark" d="M25 22 L35 35 L25 48 L15 35 Z" />
      </svg>
    );
  }
  const suitClass = isRedSuit(card.suit)
    ? "card__ink--red"
    : "card__ink--black";
  return (
    <svg
      className={className}
      viewBox="0 0 50 70"
      role="img"
      aria-label={cardSpokenLabel(card)}
    >
      <rect
        className="card__face"
        x="0.5"
        y="0.5"
        width="49"
        height="69"
        rx="5"
      />
      <g className={suitClass}>
        <text className="card__rank" x="5" y="17">
          {rankLabel(card.rank)}
        </text>
        <text className="card__pip" x="5.5" y="29">
          {SUIT_SYMBOLS[card.suit]}
        </text>
        <text className="card__center" x="27" y="56" textAnchor="middle">
          {SUIT_SYMBOLS[card.suit]}
        </text>
      </g>
    </svg>
  );
}

/** Board の未公開の位置（まだ配られていない札を推測して置かない）。 */
export function CardSlot({ size = "md" }: { readonly size?: CardSize }) {
  return <span className={`card-slot card--${size}`} aria-hidden="true" />;
}
