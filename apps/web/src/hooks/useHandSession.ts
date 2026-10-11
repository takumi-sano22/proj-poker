// Hand の画面状態。卓の状態はサーバーの HeroView、Session の状態（D80）はサーバーの SessionStatus だけを正とし、
// クライアントで状態を進めない（Bust や Session 終了をクライアントで判定しない）。
// - 受信経路は 2 つ（REST の応答と SSE の Push）。どちらが先に届いても seq の新しい方だけを残す
// - 送信中は ref と state の 2 層で二重送信を止める（state は描画用、ref は同じ tick 内の連打用）
// - CPU の障害の状態（D86）も REST の応答と SSE の outage イベントの両方から受け、revision の新しい方だけを残す
// - 新しい Session の設定（Cash / Tournament の Preset。#183・#190）は Hero が選んだ値を持ち、新しい Session を始める操作だけが送る
//   （「次の Hand へ」・「卓に戻る」は送らず、続く Session をそのまま続ける）
// - 受け取った最新の View（authoritative）と、Hero に見せる卓（displayed）を分ける（Presentation Controller。#222・D140・D143）。
//   画面へ渡す view は displayed で、Hero の操作は displayed が authoritative に追いついているときだけ、その lastSeq で送る。
//   追いついていなければ送らずに表示を最新へ合わせ、Hero にもう一度確定させる（古い操作を送らない・暗黙に送らない）。
//   SSE の再接続・Hand への復帰（resync）では古い演出を捨てて最新の公開状態に合わせる
// - ETIQUETTE の確認（Ack。#226・D145）の状態も REST の応答と SSE の etiquette イベントの両方から受け、revision の新しい方だけを残す。
//   確認を待つ間は、表示をその裁定の step で止め（holdThroughSeq）、RULING → ETIQUETTE の欄を出し（useDealerOverlay）、Hero が
//   明示的に確認したら Ack を送る。進行の再開は server が決め、応答の状態に従う（client は自動で Ack しない・操作を暗黙の確認にしない）
import type { HeroView, PhysicalAction } from "@proj-poker/engine";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  acknowledgeEtiquette as requestEtiquetteAck,
  chooseOutage,
  handStreamUrl,
  recordUserRead,
  sendHeroPhysicalActions,
  setFastForward as requestFastForward,
  startHand,
  type HeroActionResponse,
  type StartHandResponse,
  type OutageChoice,
  type OutageStatus,
  type SessionRequest,
  type SessionStatus,
  type TablePlayer,
} from "../lib/api.js";
import type { DealerOverlay } from "../lib/dealer-overlay.js";
import { canSendFrom, type PresentationSpeed } from "../lib/presentation.js";
import { runStart } from "../lib/start-flow.js";
import {
  lastSeqOf,
  parseEtiquetteEvent,
  parseEtiquetteStatus,
  parseHeroView,
  parseOutageStatus,
  parseSessionStatus,
  selectEtiquetteStatus,
  selectLatestView,
  selectOutageStatus,
  selectSessionStatus,
  type HandEtiquetteStatus,
  type HandOutageStatus,
  type HandSessionStatus,
} from "../lib/view-model.js";
import { useDealerOverlay } from "./useDealerOverlay.js";
import { usePresentation } from "./usePresentation.js";

export type ConnectionState = "idle" | "open" | "reconnecting" | "lost";

/** 操作の送信の結果。sent は送信を始めた（結果は応答で届く）、resynced は表示が古かったので送らずに最新へ合わせた、ignored は送る物が無い。 */
export type OperateResult = "sent" | "resynced" | "ignored";

/** 表示が最新に追いついていなかったので操作を送らなかったときの案内（D143）。 */
export const RESYNCED_NOTICE: SessionNotice = {
  message:
    "卓の表示を最新の状態に合わせました。操作はまだ送っていません。卓を確かめて、もう一度確定してください。",
  retryable: false,
};

/** ETIQUETTE の確認を待っている間に、操作・次の Hand の開始が拒否されたときの案内（D145。自動で確認・再送しない）。 */
export const ETIQUETTE_REQUIRED_NOTICE: SessionNotice = {
  message:
    "Dealer の作法の注意をまだ確認していません。注意の欄の「確認しました」を押すと進行が再開します（操作はまだ送っていません）。",
  retryable: false,
};

/** 確認（Ack）を送った裁定が、server の待っている裁定と違った（stale_etiquette。D145）ときの案内。別の seq を自動で確認しない。 */
export const STALE_ETIQUETTE_NOTICE: SessionNotice = {
  message:
    "確認の状態が先に変わっていました。最新の状態を読み直したので、表示中の注意を確かめてください。",
  retryable: false,
};

/** 新しい Session を求めたが、前の Session の最後の Hand に確認を待つ注意が残っていたときの案内（#245 の開始の流れ・D145）。 */
export const ETIQUETTE_BEFORE_NEW_SESSION_NOTICE: SessionNotice = {
  message:
    "前の Session の最後の Hand に、まだ確認していない Dealer の作法の注意があります。確認してから、もう一度「新しい Session を始める」を押してください。",
  retryable: false,
};

export interface SessionNotice {
  readonly message: string;
  /** 押せば同じ操作をやり直せるか（届かなかった送信など）。 */
  readonly retryable: boolean;
  /**
   * 続いている Session に戻る操作を添えるか（新しい Session の設定が、続いている Session〔再起動後の Resume など〕と違って
   * 始められなかったとき。session_mode_mismatch）。
   */
  readonly continueSession?: boolean;
}

export interface HandSession {
  readonly handId: string | null;
  readonly players: readonly TablePlayer[];
  /** Hero に見せる卓（displayed）。演出の途中なら、表示済みの Event までの卓で、操作（legalActions）を持たない。 */
  readonly view: HeroView | null;
  /** 表示が最新の View（authoritative）に追いついているか。操作を送れるのはこのときだけ（D143）。 */
  readonly synced: boolean;
  /** 残りの演出を省いて最新の公開状態に合わせる（Skip・画面への復帰）。 */
  readonly resync: () => void;
  /**
   * 表示中の Hand から見た Session の状態。まだ届いていない・表示が追いついていなければ null（Hand の結果より先に Session の終わりを
   * 見せない）。
   */
  readonly sessionStatus: SessionStatus | null;
  /** 表示中の Hand の CPU の障害の状態。まだ届いていなければ null。 */
  readonly outage: OutageStatus | null;
  /**
   * server が ETIQUETTE の確認（Ack）を待っているか（D145）。待っている間は Hero の操作・次の Hand の開始を送らない
   * （送っても server が etiquette_ack_required で拒否する）。
   */
  readonly etiquettePending: boolean;
  /** 今出す裁定の欄（RULING → ETIQUETTE。#226・D142）。無ければ null。障害のダイアログの間は null（障害を先に出す）。 */
  readonly dealerOverlay: DealerOverlay | null;
  /** 出している ETIQUETTE の裁定を確認した（Ack を送る）。送信中・確認を待っていなければ何もしない。 */
  readonly acknowledgeEtiquette: () => void;
  readonly pending: boolean;
  readonly notice: SessionNotice | null;
  readonly connection: ConnectionState;
  /** 次の Hand を始める・進行中の Hand に戻る（Session の設定は送らない。続く Session はそのまま、終わっていれば cash）。 */
  readonly start: () => void;
  /** Hero が選んだ設定（sessionChoice）で新しい Session を始める（続く Session と違う設定ならサーバーが拒否する）。 */
  readonly startNewSession: () => void;
  /** 新しい Session に求める設定（既定は Cash）。 */
  readonly sessionChoice: SessionRequest;
  readonly setSessionChoice: (choice: SessionRequest) => void;
  /**
   * Hero の 1 回の手番の物理的な操作（した順）を送る。手番でなくても送る（裁定はサーバー）。shown は Hero がその操作を組んだときに
   * 見ていた卓で、それが最新の View と同じ lastSeq のときだけ送る。違えば送らずに表示を最新へ合わせ、"resynced" を返す
   * （下書きは呼び出し側に残る。#219 の下書きの層はこの戻り値で再確認へつなぐ）。
   */
  readonly operate: (
    shown: HeroView,
    actions: readonly PhysicalAction[],
  ) => OperateResult;
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
    case "session_mode_mismatch":
      return {
        message:
          "前の Session が続いているため、別の種類の Session は始められません。続きから遊べます。",
        retryable: false,
        continueSession: true,
      };
    case "tournament_unavailable":
      return {
        message:
          "今の卓の人数では、この Tournament を始められません（Tournament は Preset の参加人数と同じ人数の卓で始めます）。",
        retryable: false,
      };
    case "review_required":
      return {
        message:
          "この判断はまだ Review されていません。先に Review を作ってから Drill を始めてください。",
        retryable: false,
      };
    case "drill_unavailable":
      return {
        message:
          "この判断からは、ルール上成り立つ Drill を作れませんでした。別の判断で試してください。",
        retryable: false,
      };
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

/** Session の種類が同じか（Tournament は Preset まで比べる）。 */
function sameSessionKind(a: SessionRequest, b: SessionRequest): boolean {
  return a.mode === "cash"
    ? b.mode === "cash"
    : b.mode === "tournament" && a.presetId === b.presetId;
}

export interface HandSessionOptions {
  /**
   * Hand の開始の要求（既定は POST /api/hands）。Drill（#117）は POST /api/drills を渡す。描画ごとに作り直さない関数を渡す
   * （変わると開始の手順を作り直す）。
   */
  readonly start?: (
    afterHandId: string | null,
    session?: SessionRequest,
  ) => Promise<StartHandResponse>;
  /** 表示演出の速度（prefers-reduced-motion なら呼び出し側が演出なしを渡す）。既定は演出なし（部品単体のテスト）。 */
  readonly speed?: PresentationSpeed;
}

export function useHandSession(options: HandSessionOptions = {}): HandSession {
  const startRequest = options.start ?? startHand;
  const [handId, setHandId] = useState<string | null>(null);
  const [players, setPlayers] = useState<readonly TablePlayer[]>([]);
  // server から届いた最新の View（authoritative）。画面には displayed を渡す。
  const [view, setView] = useState<HeroView | null>(null);
  // 送信の直前に、描画を待たずに最新の View と比べるため ref にも置く（accept で同時に更新する）。
  const latestView = useRef<HeroView | null>(null);
  const [session, setSession] = useState<HandSessionStatus | null>(null);
  const [outage, setOutage] = useState<HandOutageStatus | null>(null);
  const [etiquette, setEtiquette] = useState<HandEtiquetteStatus | null>(null);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<SessionNotice | null>(null);
  const [connection, setConnection] = useState<ConnectionState>("idle");
  const [sessionChoice, setSessionChoice] = useState<SessionRequest>({
    mode: "cash",
  });
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
    | {
        kind: "start";
        afterHandId: string | null;
        session: SessionRequest | undefined;
      }
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
    | {
        kind: "etiquette";
        handId: string;
        rulingSeq: number;
      }
    | null
  >(null);

  const accept = useCallback((incoming: HeroView) => {
    const next = selectLatestView(
      latestView.current,
      incoming,
      activeHandId.current,
    );
    latestView.current = next;
    setView(next);
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

  /** 確認（Ack）の状態を受け取る。形の合わない値・無い値（確認の API の無いサーバー）は捨てて、今の状態のまま。 */
  const acceptEtiquette = useCallback((handIdOf: string, raw: unknown) => {
    const status = parseEtiquetteStatus(raw);
    if (status === null) return;
    setEtiquette((current) =>
      selectEtiquetteStatus(
        current,
        { handId: handIdOf, status },
        activeHandId.current,
      ),
    );
  }, []);

  /** Action・障害の選択・確認の応答（View・Session・障害・確認の状態）を受け取る。 */
  const acceptResponse = useCallback(
    (sentFor: string, res: HeroActionResponse) => {
      accept(res.view);
      acceptSession({ handId: sentFor, status: res.session });
      acceptOutage({ handId: sentFor, status: res.outage });
      acceptEtiquette(sentFor, res.etiquette);
    },
    [accept, acceptEtiquette, acceptOutage, acceptSession],
  );

  /**
   * 開始の応答（Hand・View・Session・障害・確認の状態）を画面の Hand として受け取る。同じ Hand ならすでに受け取った新しい View・状態で
   * 巻き戻さない。戻り値は同じ Hand の続きか。
   */
  const adoptStarted = useCallback(
    (res: StartHandResponse): boolean => {
      const sameHand = activeHandId.current === res.handId;
      activeHandId.current = res.handId;
      setHandId(res.handId);
      setPlayers(res.players);
      accept(res.view);
      acceptSession({ handId: res.handId, status: res.session });
      acceptOutage({ handId: res.handId, status: res.outage });
      acceptEtiquette(res.handId, res.etiquette);
      setFastForwardState({
        handId: res.handId,
        enabled: res.fastForward === true,
      });
      setConnection("idle");
      return sameHand;
    },
    [accept, acceptEtiquette, acceptOutage, acceptSession],
  );

  // Presentation Controller。CPU の障害のダイアログは演出より優先する（出ている間は残りの演出を省いて最新に合わせる。§16.5）。
  // ETIQUETTE の確認を待つ間は、その裁定の step で表示を止める（holdThroughSeq。障害の優先・Skip・同期・再接続も越えない）。
  // 確認の後（応答の pendingRulingSeq が null）に続きを演出する。
  const currentOutageStatus = outage?.handId === handId ? outage.status : null;
  const currentEtiquette =
    etiquette?.handId === handId ? etiquette.status : null;
  const pendingRulingSeq = currentEtiquette?.pendingRulingSeq ?? null;
  const presentation = usePresentation(view, {
    speed: options.speed ?? "none",
    flush: currentOutageStatus?.current != null,
    holdThroughSeq: pendingRulingSeq,
  });
  // 受け取った直後の View（描画の前）に合わせる。SSE の再接続・同じ Hand の開始の応答は accept と同じ tick で同期するため。
  const presentationSync = presentation.sync;
  const resync = useCallback(
    () => presentationSync(latestView.current),
    [presentationSync],
  );

  // 結果（complete の View）まで見た最後の Hand。開始の要求で送り、サーバーが再送と「次の Hand」を区別する。
  // 「見た」は Hero に見せた卓（displayed）で判定する（演出の途中で届いた complete を見たことにしない）。
  const displayed = presentation.displayed;
  const seenComplete = useRef<string | null>(null);
  useEffect(() => {
    if (displayed?.status === "complete")
      seenComplete.current = displayed.handId;
  }, [displayed]);

  /**
   * 開始の応答の Hand を画面に開く。同じ Hand ID が返っても SSE を張り直す（切れた接続の復旧）。同じ Hand の続きなら、古い演出を
   * 捨てて最新に合わせる（新しい Hand は Hand の始まりから演出する。lib/presentation.ts の receive）。
   */
  const open = useCallback(
    (res: StartHandResponse) => {
      const sameHand = adoptStarted(res);
      setStreamEpoch((n) => n + 1);
      if (sameHand) resync();
    },
    [adoptStarted, resync],
  );

  // SSE を張り直して、最新の View・障害・確認の状態を読み直す（接続の直後に 1 回ずつ届く）。stale_etiquette・etiquette_ack_required の
  // 後に使う（応答に状態が無いので。別の seq を自動で確認しない）。
  const reread = useCallback(() => setStreamEpoch((n) => n + 1), []);

  /** 開始の要求を送る。afterHandId・session は送ったときの値のまま再送する（再送で次の Hand へ進めない）。 */
  const requestStart = useCallback(
    (afterHandId: string | null, session?: SessionRequest) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setPending(true);
      setNotice(null);
      lastFailed.current = null;
      void runStart(startRequest, afterHandId, session)
        .then((outcome) => {
          if (outcome.kind === "failed") {
            const { error, awaitingHand } = outcome;
            if (awaitingHand !== null) {
              // 2 回目の開始が確認待ちで拒否された（D145）。1 回目の応答の終わった Hand と確認の状態を開いて、確認を求める。
              open(awaitingHand);
              setNotice(ETIQUETTE_BEFORE_NEW_SESSION_NOTICE);
            } else if (
              error instanceof ApiError &&
              error.kind === "etiquette_ack_required"
            ) {
              // 次の Hand の開始が、今の Hand の確認待ちで拒否された。確認の状態を読み直して出し直す（開始を自動で送り直さない）。
              reread();
              setNotice(ETIQUETTE_REQUIRED_NOTICE);
            } else {
              lastFailed.current = {
                kind: "start",
                afterHandId: outcome.sentAfter,
                session,
              };
              setNotice(noticeOf(error));
            }
            return;
          }
          const { res } = outcome;
          open(res);
          if (outcome.awaitingEtiquette) {
            setNotice(ETIQUETTE_BEFORE_NEW_SESSION_NOTICE);
          } else if (
            // 新しい Session として選んだ種類と違う Session の続きが開いた（まだ結果を見ていない Hand・Resume した Session。サーバーは
            // 開始の再送を冪等にするため、その Hand を新しく作らずに返す）。黙って続けず、選んだ種類はこの Session の後で始められると伝える。
            session !== undefined &&
            res.sessionKind !== undefined &&
            !sameSessionKind(session, res.sessionKind)
          ) {
            setNotice({
              message:
                "前の Session が続いているため、その続きを開きました。選んだ種類の Session は、この Session が終わってから始められます。",
              retryable: false,
            });
          }
        })
        .catch((error: unknown) => setNotice(noticeOf(error)))
        .finally(() => {
          inFlight.current = false;
          setPending(false);
        });
    },
    [open, reread, startRequest],
  );

  const start = useCallback(
    () => requestStart(seenComplete.current),
    [requestStart],
  );

  const startNewSession = useCallback(
    () => requestStart(seenComplete.current, sessionChoice),
    [requestStart, sessionChoice],
  );

  /**
   * Hand に対する操作（Action・障害の選択）を送る。二重送信を止め、応答を受け取り、失敗したら再送用に覚える。送信を始めたら true。
   * failed は失敗したときに再送で同じ値を送るための記録。
   */
  const submit = useCallback(
    (
      sentFor: string,
      request: () => Promise<HeroActionResponse>,
      failed: NonNullable<typeof lastFailed.current>,
    ) => {
      if (inFlight.current) return false;
      inFlight.current = true;
      setPending(true);
      setNotice(null);
      lastFailed.current = null;
      request()
        .then((res) => acceptResponse(sentFor, res))
        .catch((error: unknown) => {
          // 送信中に別の Hand へ移っていたら、前の Hand の失敗は表示しない。
          if (activeHandId.current !== sentFor) return;
          const kind = error instanceof ApiError ? error.kind : "unknown";
          if (kind === "etiquette_ack_required" || kind === "stale_etiquette") {
            // 確認の状態が client の知っているものと違った（確認待ちの操作・別の seq の確認）。応答に状態が無いので、最新の状態を
            // 読み直して出し直す（再送ボタンを出さない・別の seq を自動で確認しない。D145）。
            reread();
            setNotice(
              kind === "stale_etiquette"
                ? STALE_ETIQUETTE_NOTICE
                : ETIQUETTE_REQUIRED_NOTICE,
            );
            return;
          }
          lastFailed.current = failed;
          setNotice(noticeOf(error));
        })
        .finally(() => {
          inFlight.current = false;
          setPending(false);
        });
      return true;
    },
    [acceptResponse, reread],
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

  /** 確認（Ack）を送る。rulingSeq は Hero に見せている ETIQUETTE の裁定の seq（再送でも同じ値を送る）。 */
  const sendEtiquetteAck = useCallback(
    (sentFor: string, rulingSeq: number) =>
      submit(sentFor, () => requestEtiquetteAck(sentFor, rulingSeq), {
        kind: "etiquette",
        handId: sentFor,
        rulingSeq,
      }),
    [submit],
  );

  const operate = useCallback(
    (shown: HeroView, actions: readonly PhysicalAction[]): OperateResult => {
      if (handId === null || actions.length === 0) return "ignored";
      // 確認を待っている間は送らない（server も拒否する。下書きは呼び出し側に残す。D145・D146）。
      if (pendingRulingSeq !== null) {
        setNotice(ETIQUETTE_REQUIRED_NOTICE);
        return "ignored";
      }
      // Hero が見ていた卓が最新でなければ送らない（未表示の最新の lastSeq を先取りしない。D143）。表示を合わせて、もう一度確定させる。
      if (!canSendFrom(shown, latestView.current)) {
        resync();
        setNotice(RESYNCED_NOTICE);
        return "resynced";
      }
      return send(handId, lastSeqOf(shown), actions) ? "sent" : "ignored";
    },
    [handId, pendingRulingSeq, resync, send],
  );

  const currentOutage = currentOutageStatus;
  // RULING → ETIQUETTE の欄（障害のダイアログが出ている間は出さない。障害を先に。D145）。
  const dealerOverlay = useDealerOverlay(
    presentation.displayed,
    pendingRulingSeq,
    currentOutage?.current != null,
  );
  const etiquetteOverlaySeq =
    dealerOverlay?.kind === "etiquette" ? dealerOverlay.rulingSeq : null;
  const acknowledgeEtiquette = useCallback(() => {
    // 出している ETIQUETTE の裁定だけを確認する（Hero が見ていない裁定を確認しない）。二重押しは submit が止める。
    if (handId === null || etiquetteOverlaySeq === null) return;
    sendEtiquetteAck(handId, etiquetteOverlaySeq);
  }, [etiquetteOverlaySeq, handId, sendEtiquetteAck]);
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
      // 読みも、Hero が見ていた卓が最新のときだけ送る（操作と同じ鮮度の条件。D143）。
      const latest = latestView.current;
      if (latest === null || lastSeq !== lastSeqOf(latest)) {
        // Hero の手番の間に卓が進むのは Hero 自身の記録だけなので、server の stale_view と同じ案内にする（自動で送り直さない）。
        resync();
        setNotice({
          ...readNoticeOf(new ApiError("stale_view", "表示が最新ではない")),
          retryable: false,
        });
        return false;
      }
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
    [accept, handId, resync],
  );

  const retry = useCallback(() => {
    const failed = lastFailed.current;
    if (failed?.kind === "start")
      requestStart(failed.afterHandId, failed.session);
    else if (failed?.kind === "operation")
      send(failed.handId, failed.lastSeq, failed.actions);
    else if (failed?.kind === "outage")
      sendOutageChoice(failed.handId, failed.revision, failed.choice);
    else if (failed?.kind === "etiquette")
      sendEtiquetteAck(failed.handId, failed.rulingSeq);
  }, [requestStart, send, sendEtiquetteAck, sendOutageChoice]);

  // SSE: 接続直後に現在の View が 1 回届き、以後は Log が進むたびに届く。complete を受けたら閉じる。
  // Session の状態（session イベント）は complete の View の直前に届く。
  useEffect(() => {
    if (handId === null) return;
    const source = new EventSource(handStreamUrl(handId));
    // 切れた後に最初に届いた View で、古い演出を捨てて最新の公開状態に合わせる（D140 Q26）。
    let reconnecting = false;
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
    source.addEventListener("etiquette", (event) => {
      const data: unknown = event.data;
      const status =
        typeof data === "string" ? parseEtiquetteEvent(data) : null;
      // 形の合わない data は描画に流さない（受け側の whitelist）。
      if (status === null) return;
      setEtiquette((current) =>
        selectEtiquetteStatus(
          current,
          { handId, status },
          activeHandId.current,
        ),
      );
    });
    source.addEventListener("view", (event) => {
      const data: unknown = event.data;
      const incoming = typeof data === "string" ? parseHeroView(data) : null;
      // 形の合わない data は描画に流さない（受け側の whitelist）。
      if (incoming === null) return;
      setConnection("open");
      accept(incoming);
      if (reconnecting) {
        reconnecting = false;
        resync();
      }
      if (incoming.status === "complete") source.close();
    });
    source.addEventListener("error", () => {
      // CLOSED はブラウザが再接続を諦めた状態（Hand が見つからない等）。それ以外は自動で再接続している。
      reconnecting = true;
      setConnection(
        source.readyState === EventSource.CLOSED ? "lost" : "reconnecting",
      );
    });
    return () => source.close();
  }, [accept, acceptOutage, acceptSession, handId, resync, streamEpoch]);

  return {
    handId,
    players,
    view: presentation.displayed,
    synced: presentation.synced,
    resync,
    sessionStatus:
      session?.handId === handId && presentation.synced ? session.status : null,
    outage: currentOutage,
    etiquettePending: pendingRulingSeq !== null,
    dealerOverlay,
    acknowledgeEtiquette,
    pending,
    notice,
    connection,
    start,
    startNewSession,
    sessionChoice,
    setSessionChoice,
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
