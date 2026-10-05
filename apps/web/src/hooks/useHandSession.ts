// Hand の画面状態。卓の状態はサーバーの HeroView、Session の状態（D80）はサーバーの SessionStatus だけを正とし、
// クライアントで状態を進めない（Bust や Session 終了をクライアントで判定しない）。
// - 受信経路は 2 つ（REST の応答と SSE の Push）。どちらが先に届いても seq の新しい方だけを残す
// - 送信中は ref と state の 2 層で二重送信を止める（state は描画用、ref は同じ tick 内の連打用）
import type { HeroView, PlayerAction } from "@proj-poker/engine";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  handStreamUrl,
  sendHeroAction,
  startHand,
  type SessionStatus,
  type TablePlayer,
} from "../lib/api.js";
import {
  lastSeqOf,
  parseHeroView,
  parseSessionStatus,
  selectLatestView,
  selectSessionStatus,
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
  readonly pending: boolean;
  readonly notice: SessionNotice | null;
  readonly connection: ConnectionState;
  readonly start: () => void;
  readonly act: (action: PlayerAction) => void;
  readonly retry: () => void;
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
    case "stale_view":
      return {
        message:
          "卓の状態が先に進んでいました。最新の卓を見て、もう一度選んでください。",
        retryable: false,
      };
    case "not_actor":
      return {
        message: "今は Hero の手番ではありません。卓の進行を待っています。",
        retryable: false,
      };
    case "hand_complete":
      return { message: "この Hand は終了しています。", retryable: false };
    case "hand_not_found":
      return {
        message:
          "この Hand はサーバーに見つかりませんでした（サーバーが再起動した可能性があります）。新しい Session を始めてください。",
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
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<SessionNotice | null>(null);
  const [connection, setConnection] = useState<ConnectionState>("idle");

  // 遅れて届いた応答がどの Hand のものかを判定するため、現在の Hand を ref でも持つ。
  const activeHandId = useRef<string | null>(null);
  const inFlight = useRef(false);
  // 再送ボタンで同じ操作をやり直すために、最後に失敗した操作を覚えておく。
  // Action は送ったときの handId と lastSeq ごと覚え、再送でも同じ値を送る。応答だけが失われて実は適用済みだった場合、
  // サーバーが stale_view で弾くので、次の手番へ誤って適用されない（現在の View の lastSeq で送り直さない）。
  const lastFailed = useRef<
    | { kind: "start" }
    | {
        kind: "action";
        handId: string;
        lastSeq: number;
        action: PlayerAction;
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

  const start = useCallback(() => {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setNotice(null);
    lastFailed.current = null;
    startHand()
      .then((res) => {
        activeHandId.current = res.handId;
        setHandId(res.handId);
        setPlayers(res.players);
        setView(res.view);
        setSession({ handId: res.handId, status: res.session });
        setConnection("idle");
      })
      .catch((error: unknown) => {
        lastFailed.current = { kind: "start" };
        setNotice(noticeOf(error));
      })
      .finally(() => {
        inFlight.current = false;
        setPending(false);
      });
  }, []);

  /** Action を送る。lastSeq は「この操作を選んだときに見ていた View」の値。 */
  const send = useCallback(
    (sentFor: string, lastSeq: number, action: PlayerAction) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setPending(true);
      setNotice(null);
      lastFailed.current = null;
      sendHeroAction(sentFor, lastSeq, action)
        .then((res) => {
          accept(res.view);
          acceptSession({ handId: sentFor, status: res.session });
        })
        .catch((error: unknown) => {
          // 送信中に別の Hand へ移っていたら、前の Hand の失敗は表示しない。
          if (activeHandId.current !== sentFor) return;
          lastFailed.current = {
            kind: "action",
            handId: sentFor,
            lastSeq,
            action,
          };
          setNotice(noticeOf(error));
        })
        .finally(() => {
          inFlight.current = false;
          setPending(false);
        });
    },
    [accept, acceptSession],
  );

  const act = useCallback(
    (action: PlayerAction) => {
      if (view === null || handId === null) return;
      send(handId, lastSeqOf(view), action);
    },
    [handId, send, view],
  );

  const retry = useCallback(() => {
    const failed = lastFailed.current;
    if (failed?.kind === "start") start();
    else if (failed?.kind === "action")
      send(failed.handId, failed.lastSeq, failed.action);
  }, [send, start]);

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
  }, [accept, acceptSession, handId]);

  return {
    handId,
    players,
    view,
    sessionStatus: session?.handId === handId ? session.status : null,
    pending,
    notice,
    connection,
    start,
    act,
    retry,
  };
}
