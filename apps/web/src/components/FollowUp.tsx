// Follow-up Q&A（#83・#84・docs/05 §7）。Pass と Version で指定した Review に続けて質問する欄。履歴はその Version に紐づき、
// 別の Version・別の Pass の会話は混ざらない。答えはその Review の根拠だけで作られ、範囲外の質問は「範囲外」と返る。
// 答えを待つ間は次の質問を送れない（サーバーも 409 で弾く）。送った質問は、答えが届くまで入力欄に残す（失敗しても書き直さずに送り直せる）。
import { useState, type FormEvent } from "react";
import { useDelayed } from "../hooks/useDelayed.js";
import { usePolled } from "../hooks/usePolled.js";
import { ApiError } from "../lib/api.js";
import { REVIEW_DELAY_NOTICE_MS } from "../lib/config.js";
import { followUpScopeNote, generationMessage } from "../lib/review.js";
import {
  FOLLOWUP_QUESTION_MAX,
  askFollowUp,
  followUpsPath,
  type FollowUpStatus,
  type ReviewPass,
} from "../lib/review-api.js";

interface FollowUpProps {
  readonly handId: string;
  readonly decisionIndex: number;
  readonly pass: ReviewPass;
  readonly version: number;
}

/** 入力欄の下書き。sentTurns は送ったときの履歴の数（答えが増えたら下書きを空にする）。 */
interface Draft {
  readonly path: string;
  readonly text: string;
  readonly sentTurns: number | null;
}

export function FollowUp({
  handId,
  decisionIndex,
  pass,
  version,
}: FollowUpProps) {
  const path = followUpsPath(handId, decisionIndex, pass, version);
  const followUps = usePolled<FollowUpStatus>(path);
  const [draft, setDraft] = useState<Draft>({
    path,
    text: "",
    sentTurns: null,
  });
  const [deep, setDeep] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<{
    readonly path: string;
    readonly message: string;
  } | null>(null);

  const data = followUps.data;
  const turns = data?.turns ?? [];
  const generation = data?.generation ?? { state: "idle" as const };
  const pending = generation.state === "pending";
  const delayed = useDelayed(
    pending ? `${path}:${turns.length}` : null,
    REVIEW_DELAY_NOTICE_MS,
  );
  // Version を変えたら下書きは持ち越さない。答えが届いたら（履歴が増えたら）空にする。
  const own = draft.path === path ? draft : { path, text: "", sentTurns: null };
  const text =
    own.sentTurns !== null && turns.length > own.sentTurns ? "" : own.text;
  const limitReached = data !== null && turns.length >= data.maxTurns;
  const message = error?.path === path ? error.message : null;
  const waitText = generationMessage(generation, "答え", delayed);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const question = text.trim();
    if (question === "" || pending || sending || limitReached) return;
    setSending(true);
    setError(null);
    try {
      await followUps.mutate(
        askFollowUp(path, question, deep ? "deep" : "standard"),
      );
      setDraft({ path, text, sentTurns: turns.length });
    } catch (err) {
      setError({ path, message: askErrorText(err) });
    } finally {
      setSending(false);
    }
  }

  const label =
    pass === "decision" ? "この Review に質問する" : "この答え合わせに質問する";
  return (
    <section className="followup" aria-label={label}>
      <h4 className="followup__title">{label}（Follow-up）</h4>
      {followUps.failed && data === null && (
        <p className="notice" role="status">
          質問の履歴を読み込めませんでした。
          <button
            type="button"
            className="btn btn--secondary btn--sm"
            onClick={followUps.refresh}
          >
            読み込み直す
          </button>
        </p>
      )}
      {turns.length > 0 && (
        <ol className="followup__turns">
          {turns.map((t) => {
            const note = followUpScopeNote(t.answer.scope, pass);
            return (
              <li key={t.followupId} className="followup__turn">
                <p className="followup__q">
                  <span className="followup__who">質問</span>
                  {t.question}
                </p>
                <div className="followup__a">
                  <span className="followup__who">答え</span>
                  {note !== null && <p className="followup__note">{note}</p>}
                  {t.answer.text !== "" && <p>{t.answer.text}</p>}
                </div>
              </li>
            );
          })}
        </ol>
      )}
      {waitText !== null && (
        <p
          className={`followup__status${generation.state === "failed" ? " followup__status--failed" : ""}`}
          role="status"
        >
          {waitText}
        </p>
      )}
      {message !== null && (
        <p className="followup__status followup__status--failed" role="status">
          {message}
        </p>
      )}
      {limitReached ? (
        <p className="evidence__muted">
          この Version への質問は上限（{data.maxTurns} 回）に達しました。
        </p>
      ) : (
        <form className="followup__form" onSubmit={(e) => void submit(e)}>
          <textarea
            className="followup__input"
            value={text}
            maxLength={FOLLOWUP_QUESTION_MAX}
            rows={2}
            placeholder={
              pass === "decision"
                ? "例: Call ではなく Raise ならどうでしたか？"
                : "例: 相手の札は想定の Range のどこにありましたか？"
            }
            aria-label="質問"
            disabled={pending || sending}
            onChange={(e) =>
              setDraft({ path, text: e.target.value, sentTurns: null })
            }
          />
          <div className="followup__actions">
            <label className="followup__deep">
              <input
                type="checkbox"
                checked={deep}
                disabled={pending || sending}
                onChange={(e) => setDeep(e.target.checked)}
              />
              詳しく答える（時間がかかります）
            </label>
            <button
              type="submit"
              className="btn btn--secondary btn--sm"
              disabled={text.trim() === "" || pending || sending}
            >
              質問する
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

/** 質問を送れなかったときの案内（驚かせない文言で、送り直しへ誘導する）。 */
function askErrorText(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.kind) {
      case "followup_in_progress":
        return "前の質問の答えを作っています。答えが届いてから送ってください。";
      case "followup_limit":
        return "この Version への質問は上限に達しました。";
      case "invalid_question":
        return "質問を入力してください。";
      default:
        break;
    }
  }
  return "質問を送れませんでした。もう一度「質問する」を押してください。";
}
