// CPU ごとの Hero の Note / Tag（D31・D112・#115）の最小の入力と、その席の今の Note / Tag。
// 対象は今の Hand の席で選び、サーバーがその Session の参加者として保存する（席の番号を永続の相手とみなさない。D105）。
// 統計（HUD）ではなく Hero 自身のメモなので Play 中も出す（D32 の HUD なしとは別）。CPU には伝わらない。
// 既定は閉じておき、卓の情報量を増やさない。
import { useEffect, useRef, useState, type FormEvent } from "react";
import { ApiError, type TablePlayer } from "../lib/api.js";
import {
  NOTE_BODY_MAX,
  TAG_MAX,
  addNote,
  addTag,
  deleteNote,
  fetchSubjectNotes,
  removeTag,
  type SubjectNotes,
} from "../lib/notes-api.js";

interface OpponentNotesProps {
  readonly handId: string;
  readonly players: readonly TablePlayer[];
  /** 今の Hand に座っている席（Bust して座っていない CPU は対象にできない）。 */
  readonly seatedIds: readonly string[];
}

/** どの Hand・席の Note / Tag か（Hand・席を切り替えた後に届いた古い応答を捨てるための鍵）。 */
function keyOf(handId: string, playerId: string): string {
  return `${handId}:${playerId}`;
}

function messageOf(error: unknown): string {
  if (error instanceof ApiError && error.kind === "network") {
    return "サーバーに届きませんでした。もう一度送ってください。";
  }
  if (error instanceof ApiError && error.kind === "hand_not_found") {
    return "この卓の Hand がサーバーに見つかりませんでした。次の Hand を始めてから記録してください。";
  }
  return "うまく処理できませんでした。もう一度送ってください。";
}

export function OpponentNotes({
  handId,
  players,
  seatedIds,
}: OpponentNotesProps) {
  const cpus = players.filter(
    (p) => p.kind === "cpu" && seatedIds.includes(p.playerId),
  );
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState(cpus[0]?.playerId ?? "");
  // 選んでいた CPU が次の Hand で座っていなければ（Bust）、座っている最初の CPU にする。
  const playerId = cpus.some((p) => p.playerId === chosen)
    ? chosen
    : (cpus[0]?.playerId ?? "");
  // Hand・席（keyOf）ごとに、最後に届いた今の Note / Tag と失敗の案内を持つ。席を切り替えた後に前の席の応答が届いても、
  // その席の欄に入るだけで、表示中の席の欄を上書きしない。
  const [loaded, setLoaded] = useState<Readonly<Record<string, SubjectNotes>>>(
    {},
  );
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const [busy, setBusy] = useState(false);
  // 同じ tick の連打は state の更新より先に来るので、ref でも止める（2 層のガード）。
  const inFlight = useRef(false);
  // Hand・席ごとの、最後に送った要求の番号。読み直しと追加・削除が行き違ったとき、後に送った要求の応答だけを残す。
  const issued = useRef(new Map<string, number>());
  const nextRequest = useRef(0);
  const issue = (requested: string): number => {
    const n = ++nextRequest.current;
    issued.current.set(requested, n);
    return n;
  };
  const isLatest = (requested: string, n: number): boolean =>
    issued.current.get(requested) === n;
  const [noteText, setNoteText] = useState("");
  // 送った Note の noteId。失敗した追加の再送は同じ noteId で送り、応答だけが失われていても Note を増やさない。
  const noteDraftId = useRef<string | null>(null);
  const [tagText, setTagText] = useState("");
  const key = keyOf(handId, playerId);

  const store = (requested: string, notes: SubjectNotes) => {
    setLoaded((prev) => ({ ...prev, [requested]: notes }));
    setErrors((prev) => {
      const rest: Record<string, string> = { ...prev };
      delete rest[requested];
      return rest;
    });
  };
  const fail = (requested: string, error: unknown) =>
    setErrors((prev) => ({ ...prev, [requested]: messageOf(error) }));

  // 開いている間、Hand・席が変わるたびに読み直す（別の Session の席は別の相手）。
  // 読み込みの間（その席の今の状態をまだ持たない間）は追加・削除を止める。
  useEffect(() => {
    if (!open || playerId === "") return;
    const requested = keyOf(handId, playerId);
    const n = issue(requested);
    fetchSubjectNotes(handId, playerId)
      .then((notes) => {
        if (isLatest(requested, n)) store(requested, notes);
      })
      .catch((e: unknown) => {
        if (isLatest(requested, n)) fail(requested, e);
      });
  }, [open, handId, playerId]);

  const current = loaded[key] ?? null;
  const error = errors[key] ?? null;
  // 読み込めなかったときは案内（error）だけを出し、「読み込み中」を残さない。
  const emptyText =
    current !== null ? "まだありません。" : error === null ? "読み込み中…" : "";
  const locked = busy || current === null;

  /** 追加・削除を送り、応答（今の Note / Tag）で置き換える。送信中は次の送信を止める。 */
  const run = async (request: () => Promise<SubjectNotes>) => {
    if (inFlight.current) return false;
    inFlight.current = true;
    const requested = key;
    const n = issue(requested);
    setBusy(true);
    try {
      const notes = await request();
      if (isLatest(requested, n)) store(requested, notes);
      return true;
    } catch (e: unknown) {
      if (isLatest(requested, n)) fail(requested, e);
      return false;
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const submitNote = async (e: FormEvent) => {
    e.preventDefault();
    if (noteText.trim() === "") return;
    const noteId = (noteDraftId.current ??= crypto.randomUUID());
    if (await run(() => addNote(handId, playerId, noteId, noteText.trim()))) {
      noteDraftId.current = null;
      setNoteText("");
    }
  };

  const submitTag = async (e: FormEvent) => {
    e.preventDefault();
    if (tagText.trim() === "") return;
    if (await run(() => addTag(handId, playerId, tagText.trim()))) {
      setTagText("");
    }
  };

  if (cpus.length === 0) return null;
  return (
    <details
      className="opponent-notes"
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary className="opponent-notes__summary">CPU の Note / Tag</summary>
      <div className="opponent-notes__body">
        <p className="opponent-notes__hint">
          Hero だけのメモです。CPU には伝わりません。この Session
          の席ごとに残ります。
        </p>
        <label className="opponent-notes__field">
          <span className="opponent-notes__label">CPU</span>
          <select
            className="opponent-notes__select"
            value={playerId}
            onChange={(e) => {
              // 席を変えたら、書きかけの Note は別の席の Note として送る（noteId を作り直す）。
              noteDraftId.current = null;
              setChosen(e.target.value);
            }}
          >
            {cpus.map((p) => (
              <option key={p.playerId} value={p.playerId}>
                {p.displayName}
              </option>
            ))}
          </select>
        </label>
        {error !== null && (
          <p className="notice" role="status">
            {error}
          </p>
        )}

        <h3 className="opponent-notes__title">Tag</h3>
        {current !== null && current.tags.length > 0 ? (
          <ul className="opponent-notes__list">
            {current.tags.map((tag) => (
              <li key={tag} className="opponent-notes__item">
                <span className="opponent-notes__tag">{tag}</span>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  aria-label={`Tag「${tag}」を外す`}
                  disabled={locked}
                  onClick={() =>
                    void run(() => removeTag(handId, playerId, tag))
                  }
                >
                  外す
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="opponent-notes__empty">{emptyText}</p>
        )}
        <form
          className="opponent-notes__form opponent-notes__form--inline"
          onSubmit={(e) => void submitTag(e)}
        >
          <input
            className="opponent-notes__input"
            type="text"
            aria-label="Tag"
            placeholder="例: Loose"
            maxLength={TAG_MAX}
            value={tagText}
            onChange={(e) => setTagText(e.target.value)}
          />
          <button
            type="submit"
            className="btn btn--secondary btn--sm"
            disabled={locked || tagText.trim() === ""}
          >
            Tag を付ける
          </button>
        </form>

        <h3 className="opponent-notes__title">Note</h3>
        {current !== null && current.notes.length > 0 ? (
          <ul className="opponent-notes__list">
            {current.notes.map((note) => (
              <li key={note.noteId} className="opponent-notes__item">
                <span className="opponent-notes__note">{note.body}</span>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  aria-label="この Note を消す"
                  disabled={locked}
                  onClick={() =>
                    void run(() => deleteNote(handId, playerId, note.noteId))
                  }
                >
                  消す
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="opponent-notes__empty">{emptyText}</p>
        )}
        <form
          className="opponent-notes__form"
          onSubmit={(e) => void submitNote(e)}
        >
          <textarea
            className="opponent-notes__input opponent-notes__input--multiline"
            aria-label="Note"
            placeholder="例: River の大きい Bet は Value 寄り"
            maxLength={NOTE_BODY_MAX}
            value={noteText}
            onChange={(e) => {
              // 本文を変えたら別の Note として送る。
              noteDraftId.current = null;
              setNoteText(e.target.value);
            }}
          />
          <button
            type="submit"
            className="btn btn--secondary btn--sm"
            disabled={locked || noteText.trim() === ""}
          >
            Note を残す
          </button>
        </form>
      </div>
    </details>
  );
}
