// Hero の User Read（判断の前の読み・意図。D33・D112）の最小の入力。Hero の手番の間だけ出す（サーバーも手番の間だけ受け付ける）。
// 閉じている間は Button 1 つにして、Hero 欄を低く保つ。読みの当たり外れ（相手の札・CPU の Persona との照合）は Play 中に出さない（D105）。
// 記録した読みは進行ログに Hero 自身の行として出て、Review（Pass A）の根拠に入る。CPU には伝わらない。
import { USER_READ_TEXT_MAX, type HeroView } from "@proj-poker/engine";
import { useRef, useState, type FormEvent } from "react";
import { lastSeqOf } from "../lib/view-model.js";

interface UserReadProps {
  readonly view: HeroView;
  readonly nameOf: (playerId: string) => string;
  readonly disabled: boolean;
  /** 記録できたら true（フォームを閉じる）。lastSeq は最初に送ったときに見ていた View の値。 */
  readonly onRecord: (
    lastSeq: number,
    targetPlayerId: string | null,
    text: string,
  ) => Promise<boolean>;
}

/** 対象を選ばない（相手を特定しない読み・Hero 自身の意図）を表す select の値。 */
const NO_TARGET = "";

export function UserReadToggle({
  view,
  nameOf,
  disabled,
  onRecord,
}: UserReadProps) {
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState(NO_TARGET);
  const [text, setText] = useState("");
  // 同じ読みの再送は、最初に送ったときの lastSeq のまま送る（応答だけが失われていたら、サーバーが stale_view で弾いて
  // 同じ読みを 2 回残さない）。対象・本文を変えたら新しい読みとして送り直す。
  const sentAt = useRef<number | null>(null);
  // 対象にできるのは、Fold していない相手の席だけ。送信中（disabled）は対象と本文を固定する（成功で入力を消すため、
  // 送信中に書き換えた内容を消さない）。
  const opponents = view.seats.filter(
    (s) => s.playerId !== view.viewerId && !s.folded,
  );

  if (!open) {
    return (
      <button
        type="button"
        className="btn btn--ghost btn--sm user-read__open"
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        読みを記録
      </button>
    );
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (text.trim() === "") return;
    sentAt.current ??= lastSeqOf(view);
    const recorded = await onRecord(
      sentAt.current,
      target === NO_TARGET ? null : target,
      text.trim(),
    );
    if (!recorded) return;
    sentAt.current = null;
    setText("");
    setTarget(NO_TARGET);
    setOpen(false);
  };

  return (
    <form
      className="user-read"
      aria-label="読みを記録"
      onSubmit={(e) => void submit(e)}
    >
      <label className="user-read__field">
        <span className="user-read__label">対象</span>
        <select
          className="user-read__select"
          disabled={disabled}
          value={target}
          onChange={(e) => {
            sentAt.current = null;
            setTarget(e.target.value);
          }}
        >
          <option value={NO_TARGET}>相手なし（意図）</option>
          {opponents.map((s) => (
            <option key={s.playerId} value={s.playerId}>
              {nameOf(s.playerId)}
            </option>
          ))}
        </select>
      </label>
      <input
        className="user-read__input"
        disabled={disabled}
        type="text"
        aria-label="読み"
        placeholder="例: River の大きい Bet は Value が多そう"
        maxLength={USER_READ_TEXT_MAX}
        value={text}
        onChange={(e) => {
          sentAt.current = null;
          setText(e.target.value);
        }}
      />
      <div className="user-read__actions">
        <button
          type="submit"
          className="btn btn--secondary btn--sm"
          disabled={disabled || text.trim() === ""}
        >
          記録する
        </button>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() => setOpen(false)}
        >
          閉じる
        </button>
        <span className="user-read__note">CPU には伝わりません</span>
      </div>
    </form>
  );
}
