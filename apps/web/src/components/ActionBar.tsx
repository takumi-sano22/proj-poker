// Declaration Button（docs/06 §5）。出すボタンはサーバーが返した Legal Action だけで決め、ここで合法性を判定しない（D40）。
// Bet / Raise の額は Preset と Slider で決め、数値の入力欄は作らない（docs/06 §4。Chip Drag は Phase 4）。
import type {
  HeroView,
  LegalAction,
  LegalActionSet,
  PlayerAction,
} from "@proj-poker/engine";
import { useState } from "react";
import {
  ACTION_TERMS,
  formatBB,
  formatChips,
  termLabel,
} from "../lib/format.js";
import { sizingPresets } from "../lib/view-model.js";

interface ActionBarProps {
  readonly view: HeroView;
  readonly legal: LegalActionSet;
  readonly disabled: boolean;
  readonly onAction: (action: PlayerAction) => void;
}

type SizedAction = Extract<LegalAction, { type: "bet" | "raise" }>;

export function ActionBar({ view, legal, disabled, onAction }: ActionBarProps) {
  const find = <T extends LegalAction["type"]>(type: T) =>
    legal.actions.find(
      (a): a is Extract<LegalAction, { type: T }> => a.type === type,
    );
  const fold = find("fold");
  const check = find("check");
  const call = find("call");
  const sized: SizedAction | undefined = find("bet") ?? find("raise");
  const allIn = find("all_in");
  const bb = view.bigBlind;

  return (
    <div className="action-bar" role="group" aria-label="宣言（Declaration）">
      {sized !== undefined && (
        <SizingControl
          key={`${sized.type}:${sized.min}:${sized.max}`}
          view={view}
          toCall={legal.toCall}
          range={sized}
          disabled={disabled}
          onAction={onAction}
        />
      )}
      <div className="action-bar__buttons">
        {fold !== undefined && (
          <DeclarationButton
            variant="secondary"
            label={termLabel(ACTION_TERMS.fold)}
            disabled={disabled}
            onClick={() => onAction({ type: "fold" })}
          />
        )}
        {check !== undefined && (
          <DeclarationButton
            variant="secondary"
            label={termLabel(ACTION_TERMS.check)}
            disabled={disabled}
            onClick={() => onAction({ type: "check" })}
          />
        )}
        {call !== undefined && (
          <DeclarationButton
            variant="secondary"
            label={termLabel(ACTION_TERMS.call)}
            amount={formatChips(call.amount)}
            amountBB={formatBB(call.amount, bb)}
            disabled={disabled}
            onClick={() => onAction({ type: "call" })}
          />
        )}
        {allIn !== undefined && (
          <DeclarationButton
            variant="danger"
            label={termLabel(ACTION_TERMS.all_in)}
            amount={`${formatChips(allIn.amount)} まで`}
            amountBB={formatBB(allIn.amount, bb)}
            disabled={disabled}
            onClick={() => onAction({ type: "all_in" })}
          />
        )}
      </div>
    </div>
  );
}

interface SizingControlProps {
  readonly view: HeroView;
  readonly toCall: number;
  readonly range: SizedAction;
  readonly disabled: boolean;
  readonly onAction: (action: PlayerAction) => void;
}

function SizingControl({
  view,
  toCall,
  range,
  disabled,
  onAction,
}: SizingControlProps) {
  const presets = sizingPresets(view, toCall, range);
  const [amount, setAmount] = useState(range.min);
  const term = termLabel(ACTION_TERMS[range.type]);
  const suffix = range.type === "raise" ? " まで" : "";

  return (
    <div className="sizing">
      <div
        className="sizing__presets"
        role="group"
        aria-label="額の候補（Preset）"
      >
        {presets.map((p) => (
          <button
            key={p.key}
            type="button"
            className="btn btn--ghost btn--sm"
            aria-pressed={amount === p.amount}
            disabled={disabled}
            onClick={() => setAmount(p.amount)}
          >
            {p.label}
            <span className="btn__sub">{formatChips(p.amount)}</span>
          </button>
        ))}
      </div>
      <input
        className="sizing__slider"
        type="range"
        min={range.min}
        max={range.max}
        step={1}
        value={amount}
        disabled={disabled}
        aria-label={`${term} の額`}
        aria-valuetext={`${formatChips(amount)}（${formatBB(amount, view.bigBlind)}）`}
        onChange={(e) => setAmount(Number(e.currentTarget.value))}
      />
      <DeclarationButton
        variant="primary"
        label={term}
        amount={`${formatChips(amount)}${suffix}`}
        amountBB={formatBB(amount, view.bigBlind)}
        disabled={disabled}
        onClick={() => onAction({ type: range.type, amount })}
      />
    </div>
  );
}

interface DeclarationButtonProps {
  readonly variant: "primary" | "secondary" | "danger";
  readonly label: string;
  readonly amount?: string;
  readonly amountBB?: string;
  readonly disabled: boolean;
  readonly onClick: () => void;
}

function DeclarationButton({
  variant,
  label,
  amount,
  amountBB,
  disabled,
  onClick,
}: DeclarationButtonProps) {
  return (
    <button
      type="button"
      className={`btn btn--${variant} btn--md declaration`}
      disabled={disabled}
      onClick={onClick}
    >
      <span className="declaration__label">{label}</span>
      {amount !== undefined && (
        <span className="declaration__amount">
          {amount}
          {amountBB !== undefined && (
            <span className="declaration__bb">{amountBB}</span>
          )}
        </span>
      )}
    </button>
  );
}
