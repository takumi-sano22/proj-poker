// Hand の画面状態。卓の状態はサーバーの HeroView、Session の状態（D80）はサーバーの SessionStatus だけを正とし、
// クライアントで状態を進めない（Bust や Session 終了をクライアントで判定しない）。
// - 受信経路は 2 つ（REST の応答と SSE の Push）。どちらが先に届いても seq の新しい方だけを残す
// - 送信中は ref と state の 2 層で二重送信を止める（state は描画用、ref は同じ tick 内の連打用）
// - CPU の障害の状態（D86）も REST の応答と SSE の outage イベントの両方から受け、revision の新しい方だけを残す
import type { HeroView, PhysicalAction } from "@proj-poker/engine";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  chooseOutage,
  handStreamUrl,
  recordUserRead,
  sendHeroPhysicalActions,
  setFastForward as requestFastForward,
  startHand,
  type HeroActionResponse,
  type OutageChoice,
  type OutageStatus,
  type SessionStatus,
  type TablePlayer,
} from "../lib/api.js";
import {
  lastSeqOf,
  parseHeroView,
  parseOutageStatus,
  parseSessionStatus,
  selectLatestView,
  selectOutageStatus,
  selectSessionStatus,
  type HandOutageStatus,
  type HandSessionStatus,
} from "../lib/view-model.js";

export type ConnectionState = "idle" | "open" | "reconnecting" | "lost";

export interface SessionNotice {
  readonly message: string;
  /** 押せば同じ操作をやり直せるか（届かなかった送信など）。 */
  readonly retryable: boolean;
}

export interface HandSession {
  readonly handId: string | null;
  readonly players: readonly TablePlayer[];
  readonly view: HeroView | null;
  /** 表示中の Hand から見た Session の状態。まだ届いていなければ null。 */
  readonly sessionStatus: SessionStatus | null;
  /** 表示中の Hand の CPU の障害の状態。まだ届いていなければ null。 */
  readonly outage: OutageStatus | null;
  readonly pending: boolean;
  readonly notice: SessionNotice | null;
  readonly connection: ConnectionState;
  readonly start: () => void;
  /** Hero の 1 回の手番の物理的な操作（した順）を送る。手番でなくても送る（裁定はサーバー）。 */
  readonly operate: (actions: readonly PhysicalAction[]) => void;
  /** 表示中の障害の続け方を選ぶ（Retry / Emergency Bot / Session 終了）。 */
  readonly resolveOutage: (choice: OutageChoice) => void;
  readonly retry: () => void;
  /** 表示中の Hand の Fast Forward が入っているか（Hand が終わっていれば false）。 */
  readonly fastForward: boolean;
  /** Fast Forward を送信中か（操作の送信 pending とは別。観戦中の切り替えを操作の送信と取り合わない）。 */
  readonly fastForwardPending: boolean;
  /** Fast Forward を入れる・切る。入れられるのは Hero が Fold した後だけ（サーバーが判定する）。 */
  readonly setFastForward: (enabled: boolean) => void;
  /**
   * Hero の User Read（判断の前の読み・意図。D112）を記録する。Hero の手番の間だけ受け付けられる。記録できたら true。
   * 操作の送信と同じ二重送信の止め方（pending）を使う（読みで Log が進むので、読みの応答の前に操作を送ると stale_view になる）。
   */
  readonly recordRead: (
    lastSeq: number,
    targetPlayerId: string | null,
    text: string,
  ) => Promise<boolean>;
}

/** User Read の記録の失敗の案内。手番が過ぎた・Hand が終わったときは、読みを残せる時点を伝える。 */
function readNoticeOf(error: unknown): SessionNotice {
  const kind = error instanceof ApiError ? error.kind : "unknown";
  if (kind === "not_actor" || kind === "hand_complete") {
    return {
      message: "読みは Hero の手番の間だけ記録できます。",
      retryable: false,
    };
  }
  if (kind === "stale_view") {
    // 同じ読みの再送は最初の lastSeq で送るので、前の送信が届いて記録済みならここに来る。
    return {
      message:
        "読みはすでに記録されているかもしれません。進行ログを確かめてください。",
      retryable: false,
    };
  }
  return noticeOf(error);
}

/** サーバーの失敗を、驚かせない案内文にする（ui.md: 一時的な失敗は再送へ誘導する）。 */
function noticeOf(error: unknown): SessionNotice {
  const kind = error instanceof ApiError ? error.kind : "unknown";
  switch (kind) {
    case "network":
      return {
        message: "サーバーに届きませんでした。もう一度送ってください。",
        retryable: true,
      };
    case "stale_outage":
      return {
        message:
          "AI の状態が先に変わっていました。最新の表示を見て、もう一度選んでください。",
        retryable: false,
      };
    case "stale_view":
      return {
        message:
          "卓の状態が先に進んでいました。最新の卓を見て、もう一度選んでください。",
        retryable: false,
      };
    case "not_actor":
      // 物理的な操作では、保留中の Out-of-Turn があるのにもう一度操作したときに返る（保留は Hero の手番で裁定する）。
      return {
        message:
          "前の操作を保留しています。Hero の手番で Dealer が裁定するまでお待ちください。",
        retryable: false,
      };
    case "invalid_input":
      // 持っている額を超える Chip など、物理的に出せない操作（同じ内容の再送では通らない）。
      return {
        message:
          "その操作は受け付けられませんでした。卓の表示を見て、操作し直してください。",
        retryable: false,
      };
    case "not_spectating":
      return {
        message:
          "Fast Forward は Hero が Fold した後、Hand の終了までの間だけ使えます。",
        retryable: false,
      };
    case "hand_complete":
      return { message: "この Hand は終了しています。", retryable: false };
    case "hand_not_found":
      return {
        message:
          "この Hand はサーバーに見つかりませんでした（サーバーが再起動した可能性があります）。「卓に戻る」から始め直してください。",
        retryable: false,
      };
    case "illegal_action":
      return {
        message: "その操作は今は選べません。表示中のボタンから選んでください。",
        retryable: false,
      };
    default:
      return {
        message: "うまく処理できませんでした。もう一度送ってください。",
        retryable: true,
      };
  }
}

export function useHandSession(): HandSession {
  const [handId, setHandId] = useState<string | null>(null);
  const [players, setPlayers] = useState<readonly TablePlayer[]>([]);
  const [view, setView] = useState<HeroView | null>(null);
  const [session, setSession] = useState<HandSessionStatus | null>(null);
  const [outage, setOutage] = useState<HandOutageStatus | null>(null);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<SessionNotice | null>(null);
  const [connection, setConnection] = useState<ConnectionState>("idle");
  // Fast Forward（D12）。サーバーの状態を写すだけで、どの Hand のものかを持つ（別の Hand へ持ち越さない）。
  const [fastForward, setFastForwardState] = useState<{
    readonly handId: string;
    readonly enabled: boolean;
  } | null>(null);
  const [fastForwardPending, setFastForwardPending] = useState(false);
  const fastForwardInFlight = useRef(false);
  // SSE を張り直すための世代。開始が成功するたびに進める。
  const [streamEpoch, setStreamEpoch] = useState(0);

  // 遅れて届いた応答がどの Hand のものかを判定するため、現在の Hand を ref でも持つ。
  const activeHandId = useRef<string | null>(null);
  const inFlight = useRef(false);
  // 再送ボタンで同じ操作をやり直すために、最後に失敗した操作を覚えておく。
  // 操作は送ったときの handId と lastSeq ごと覚え、再送でも同じ値を送る。応答だけが失われて実は適用済みだった場合、
  // サーバーが stale_view で弾くので、次の手番へ誤って適用されない（現在の View の lastSeq で送り直さない）。
  const lastFailed = useRef<
    | { kind: "start"; afterHandId: string | null }
    | {
        kind: "operation";
        handId: string;
        lastSeq: number;
        actions: readonly PhysicalAction[];
      }
    | {
        kind: "outage";
        handId: string;
        revision: number;
        choice: OutageChoice;
      }
    | null
  >(null);

  const accept = useCallback((incoming: HeroView) => {
    setView((current) =>
      selectLatestView(current, incoming, activeHandId.current),
    );
  }, []);

  const acceptSession = useCallback((incoming: HandSessionStatus) => {
    setSession((current) =>
      selectSessionStatus(current, incoming, activeHandId.current),
    );
  }, []);

  const acceptOutage = useCallback((incoming: HandOutageStatus) => {
    setOutage((current) =>
      selectOutageStatus(current, incoming, activeHandId.current),
    );
  }, []);

  /** Action・障害の選択の応答（View・Session・障害の状態）を受け取る。 */
  const acceptResponse = useCallback(
    (sentFor: string, res: HeroActionResponse) => {
      accept(res.view);
      acceptSession({ handId: sentFor, status: res.session });
      acceptOutage({ handId: sentFor, status: res.outage });
    },
    [accept, acceptOutage, acceptSession],
  );

  // 結果（complete の View）まで見た最後の Hand。開始の要求で送り、サーバーが再送と「次の Hand」を区別する。
  const seenComplete = useRef<string | null>(null);
  useEffect(() => {
    if (view?.status === "complete") seenComplete.current = view.handId;
  }, [view]);

  /** 開始の要求を送る。afterHandId は送ったときの値のまま再送する（再送で次の Hand へ進めない）。 */
  const requestStart = useCallback(
    (afterHandId: string | null) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setPending(true);
      setNotice(null);
      lastFailed.current = null;
      startHand(afterHandId)
        .then((res) => {
          // 進行中の Hand があれば、サーバーは新しく作らずその Hand を返す（開始の再送・「卓に戻る」）。
          // 同じ Hand のときも、すでに受け取った新しい View・状態で巻き戻さない。
          activeHandId.current = res.handId;
          setHandId(res.handId);
          setPlayers(res.players);
          accept(res.view);
          acceptSession({ handId: res.handId, status: res.session });
          acceptOutage({ handId: res.handId, status: res.outage });
          setFastForwardState({
            handId: res.handId,
            enabled: res.fastForward === true,
          });
          setConnection("idle");
          // 同じ Hand ID が返っても SSE を張り直す（切れた接続の復旧）。
          setStreamEpoch((n) => n + 1);
        })
        .catch((error: unknown) => {
          lastFailed.current = { kind: "start", afterHandId };
          setNotice(noticeOf(error));
        })
        .finally(() => {
          inFlight.current = false;
          setPending(false);
        });
    },
    [accept, acceptOutage, acceptSession],
  );

  const start = useCallback(
    () => requestStart(seenComplete.current),
    [requestStart],
  );

  /**
   * Hand に対する操作（Action・障害の選択）を送る。二重送信を止め、応答を受け取り、失敗したら再送用に覚える。
   * failed は失敗したときに再送で同じ値を送るための記録。
   */
  const submit = useCallback(
    (
      sentFor: string,
      request: () => Promise<HeroActionResponse>,
      failed: NonNullable<typeof lastFailed.current>,
    ) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setPending(true);
      setNotice(null);
      lastFailed.current = null;
      request()
        .then((res) => acceptResponse(sentFor, res))
        .catch((error: unknown) => {
          // 送信中に別の Hand へ移っていたら、前の Hand の失敗は表示しない。
          if (activeHandId.current !== sentFor) return;
          lastFailed.current = failed;
          setNotice(noticeOf(error));
        })
        .finally(() => {
          inFlight.current = false;
          setPending(false);
        });
    },
    [acceptResponse],
  );

  /** 物理的な操作を送る。lastSeq は「この操作を送ると決めたときに見ていた View」の値。 */
  const send = useCallback(
    (sentFor: string, lastSeq: number, actions: readonly PhysicalAction[]) =>
      submit(
        sentFor,
        () => sendHeroPhysicalActions(sentFor, lastSeq, actions),
        { kind: "operation", handId: sentFor, lastSeq, actions },
      ),
    [submit],
  );

  /** 障害の続け方を送る。revision は「この選択をしたときに見ていた障害の状態」の値（再送でも同じ値を送る）。 */
  const sendOutageChoice = useCallback(
    (sentFor: string, revision: number, choice: OutageChoice) =>
      submit(sentFor, () => chooseOutage(sentFor, revision, choice), {
        kind: "outage",
        handId: sentFor,
        revision,
        choice,
      }),
    [submit],
  );

  const operate = useCallback(
    (actions: readonly PhysicalAction[]) => {
      if (view === null || handId === null || actions.length === 0) return;
      send(handId, lastSeqOf(view), actions);
    },
    [handId, send, view],
  );

  const currentOutage = outage?.handId === handId ? outage.status : null;
  const resolveOutage = useCallback(
    (choice: OutageChoice) => {
      if (handId === null || currentOutage?.current == null) return;
      sendOutageChoice(handId, currentOutage.revision, choice);
    },
    [currentOutage, handId, sendOutageChoice],
  );

  /**
   * Fast Forward を送る。二重送信は止めるが、操作の送信（pending）とは取り合わない（観戦中は操作が無く、障害の選択と別の経路のため）。
   * 失敗は案内だけを出し、再送ボタンは出さない（もう一度押せば同じ送信になる。再送用の記録 lastFailed は使わない）。
   */
  const setFastForward = useCallback(
    (enabled: boolean) => {
      if (handId === null || fastForwardInFlight.current) return;
      fastForwardInFlight.current = true;
      setFastForwardPending(true);
      setNotice(null);
      requestFastForward(handId, enabled)
        .then((res) => {
          // 送信中に別の Hand へ移っていたら反映しない
          if (activeHandId.current !== handId) return;
          setFastForwardState({ handId, enabled: res.fastForward });
        })
        .catch((error: unknown) => {
          if (activeHandId.current !== handId) return;
          setNotice({ ...noticeOf(error), retryable: false });
        })
        .finally(() => {
          fastForwardInFlight.current = false;
          setFastForwardPending(false);
        });
    },
    [handId],
  );

  const recordRead = useCallback(
    async (
      lastSeq: number,
      targetPlayerId: string | null,
      text: string,
    ): Promise<boolean> => {
      if (handId === null || inFlight.current) return false;
      const sentFor = handId;
      inFlight.current = true;
      setPending(true);
      setNotice(null);
      lastFailed.current = null;
      try {
        const res = await recordUserRead(
          sentFor,
          lastSeq,
          targetPlayerId,
          text,
        );
        accept(res.view);
        return true;
      } catch (error: unknown) {
        // 送信中に別の Hand へ移っていたら、前の Hand の失敗は表示しない。再送ボタンは出さない（入力はフォームに残る）。
        if (activeHandId.current === sentFor) {
          setNotice({ ...readNoticeOf(error), retryable: false });
        }
        return false;
      } finally {
        inFlight.current = false;
        setPending(false);
      }
    },
    [accept, handId],
  );

  const retry = useCallback(() => {
    const failed = lastFailed.current;
    if (failed?.kind === "start") requestStart(failed.afterHandId);
    else if (failed?.kind === "operation")
      send(failed.handId, failed.lastSeq, failed.actions);
    else if (failed?.kind === "outage")
      sendOutageChoice(failed.handId, failed.revision, failed.choice);
  }, [requestStart, send, sendOutageChoice]);

  // SSE: 接続直後に現在の View が 1 回届き、以後は Log が進むたびに届く。complete を受けたら閉じる。
  // Session の状態（session イベント）は complete の View の直前に届く。
  useEffect(() => {
    if (handId === null) return;
    const source = new EventSource(handStreamUrl(handId));
    source.addEventListener("session", (event) => {
      const data: unknown = event.data;
      const status = typeof data === "string" ? parseSessionStatus(data) : null;
      // 形の合わない data は描画に流さない（受け側の whitelist）。
      if (status === null) return;
      acceptSession({ handId, status });
    });
    source.addEventListener("outage", (event) => {
      const data: unknown = event.data;
      const status = typeof data === "string" ? parseOutageStatus(data) : null;
      // 形の合わない data は描画に流さない（受け側の whitelist）。
      if (status === null) return;
      acceptOutage({ handId, status });
    });
    source.addEventListener("view", (event) => {
      const data: unknown = event.data;
      const incoming = typeof data === "string" ? parseHeroView(data) : null;
      // 形の合わない data は描画に流さない（受け側の whitelist）。
      if (incoming === null) return;
      setConnection("open");
      accept(incoming);
      if (incoming.status === "complete") source.close();
    });
    source.addEventListener("error", () => {
      // CLOSED はブラウザが再接続を諦めた状態（Hand が見つからない等）。それ以外は自動で再接続している。
      setConnection(
        source.readyState === EventSource.CLOSED ? "lost" : "reconnecting",
      );
    });
    return () => source.close();
  }, [accept, acceptOutage, acceptSession, handId, streamEpoch]);

  return {
    handId,
    players,
    view,
    sessionStatus: session?.handId === handId ? session.status : null,
    outage: currentOutage,
    pending,
    notice,
    connection,
    start,
    operate,
    resolveOutage,
    retry,
    // サーバーは Hand の終了で切る。complete の View を受けた時点で、先に画面でも通常の表示に戻す。
    fastForward:
      fastForward?.handId === handId &&
      fastForward.enabled &&
      view?.status === "in_progress",
    fastForwardPending,
    setFastForward,
    recordRead,
  };
}
