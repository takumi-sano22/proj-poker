// Learning Reset の入口（#118・docs/04 §11・docs/06 §14・D114）。Session Review / Player Profile の画面の下に置く最小の入口。
// - Reset は区切りの行を足すだけで、Hand の記録（Event Log）・Review・Note / Tag・User Read・Stats は消えない。取り消しはできない。
//   その 2 つを確認の文言で必ず示す
// - 取り消せない操作なので、確定の前に確認を挟み、確認の初期フォーカスは「やめる」に置く（ui-design-recipes modal §4.1）
// - 送信中は状態と ref の 2 層で二重送信を防ぎ、画面を離れた後の応答は捨てる（LC-041）
import { useEffect, useRef, useState } from "react";
import {
  LEARNING_RESET_CATEGORIES,
  resetLearning,
  type LearningResetCategory,
  type ResetBoundaries,
} from "../lib/learning-api.js";
import { RESET_CATEGORY_LABELS, resetAtText } from "../lib/learning.js";

type Phase = "idle" | "confirm" | "sending" | "failed" | "done";

export function LearningReset({
  resets,
  onDone,
}: {
  /** カテゴリごとの最後の Reset の時刻（Profile を読めていなければ null）。 */
  readonly resets: ResetBoundaries | null;
  /** Reset の後に、Profile・Drill の結果を読み直す。 */
  readonly onDone: () => void;
}) {
  const [selected, setSelected] = useState<ReadonlySet<LearningResetCategory>>(
    () => new Set(LEARNING_RESET_CATEGORIES),
  );
  const [phase, setPhase] = useState<Phase>("idle");
  const [doneAt, setDoneAt] = useState<string | null>(null);
  const sending = useRef(false);
  const mounted = useRef(true);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // 確認を開いたら、安全な「やめる」へフォーカスを置く（開いた直後の Enter で確定させない）。
  useEffect(() => {
    if (phase === "confirm") cancelRef.current?.focus();
  }, [phase]);

  const categories = LEARNING_RESET_CATEGORIES.filter((c) => selected.has(c));
  const busy = phase === "sending";
  const confirming =
    phase === "confirm" || phase === "sending" || phase === "failed";

  const toggle = (category: LearningResetCategory, on: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(category);
      else next.delete(category);
      return next;
    });
    if (phase === "done") setPhase("idle");
  };

  const submit = () => {
    if (sending.current || categories.length === 0) return;
    sending.current = true;
    setPhase("sending");
    resetLearning(categories).then(
      (res) => {
        sending.current = false;
        if (!mounted.current) return;
        setDoneAt(res.reset.createdAt);
        setPhase("done");
        onDone();
      },
      () => {
        sending.current = false;
        if (mounted.current) setPhase("failed");
      },
    );
  };

  const last = resets === null ? [] : lastResets(resets);

  return (
    <section
      className="review-section learning-reset"
      aria-labelledby="learning-reset"
    >
      <h3 className="review-section__title" id="learning-reset">
        学習の記録を数え直す（Learning Reset）
      </h3>
      <p className="review-section__note">
        選んだ項目を、Reset した時点より後に終わった Hand
        の判断だけで数え直します。Hand の記録・Review・Note / Tag・User
        Read・Stats は消えず、Replay や Review はそのまま開けます。
      </p>
      {last.length > 0 && (
        <ul className="learning-reset__last" aria-label="最後の Learning Reset">
          {last.map((l) => (
            <li key={l.category}>
              {RESET_CATEGORY_LABELS[l.category].label}: {resetAtText(l.at)}{" "}
              から
            </li>
          ))}
        </ul>
      )}
      <fieldset className="learning-reset__options" disabled={confirming}>
        <legend className="learning-reset__legend">数え直す項目</legend>
        {LEARNING_RESET_CATEGORIES.map((c) => (
          <label key={c} className="learning-reset__option">
            <input
              type="checkbox"
              checked={selected.has(c)}
              onChange={(e) => toggle(c, e.target.checked)}
            />
            <span>
              {RESET_CATEGORY_LABELS[c].label}
              <span className="learning-row__meta">
                {RESET_CATEGORY_LABELS[c].detail}
              </span>
            </span>
          </label>
        ))}
      </fieldset>
      {!confirming && (
        <div>
          <button
            type="button"
            className="btn btn--secondary btn--sm"
            disabled={categories.length === 0}
            onClick={() => setPhase("confirm")}
          >
            数え直す…
          </button>
        </div>
      )}
      {confirming && (
        <div
          className="learning-reset__confirm"
          role="group"
          aria-labelledby="learning-reset-confirm"
        >
          <p id="learning-reset-confirm">
            {categories.map((c) => RESET_CATEGORY_LABELS[c].label).join("・")}{" "}
            を、今より後に終わる Hand
            の判断だけで数え直します。この操作は取り消せません。Hand
            の記録・Review・Note / Tag・User Read・Stats は消えません。
          </p>
          {phase === "failed" && (
            <p role="status">
              数え直しを始められませんでした。もう一度お試しください。
            </p>
          )}
          <div className="learning-reset__actions">
            <button
              ref={cancelRef}
              type="button"
              className="btn btn--secondary btn--sm"
              disabled={busy}
              onClick={() => setPhase("idle")}
            >
              やめる
            </button>
            <button
              type="button"
              className="btn btn--danger btn--sm"
              disabled={busy}
              onClick={submit}
            >
              {busy ? "数え直しています…" : "数え直す"}
            </button>
          </div>
        </div>
      )}
      {phase === "done" && doneAt !== null && (
        <p className="review-section__note" role="status">
          {resetAtText(doneAt)} から数え直しました。
        </p>
      )}
    </section>
  );
}

/** Reset したことのあるカテゴリと、その最後の時刻（カテゴリの順）。 */
function lastResets(
  resets: ResetBoundaries,
): { readonly category: LearningResetCategory; readonly at: string }[] {
  return LEARNING_RESET_CATEGORIES.flatMap((category) => {
    const at = resets[category];
    return at === null ? [] : [{ category, at }];
  });
}
