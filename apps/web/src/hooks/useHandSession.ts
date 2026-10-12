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
// - Hero の未送信の操作の下書き（TurnDraft。#219・D146）もここ（画面の切り替えより上・Session ごと）に持つ。寿命の規則は
//   lib/turn-draft.ts の純関数で、ここは displayed / authoritative と送信の結果を渡すだけ。操作の部品（ChipControls）が外れても
//   （Home / Learn / Replay / Review・障害のダイアログ・RULING / ETIQUETTE の欄）下書きは消えない。メモリだけに置き、保存しない
import type { Declaration, HeroView, PhysicalAction } from "@proj-poker/engine";
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
import type { TurnDraft } from "../lib/chip-ops.js";
import {
  INITIAL_DRAFT_STATE,
  actionsToSend,
  checkSend,
  confirmChange,
  dismissDiscarded as dismissDiscardedNotice,
  edit as editDraft,
  markSending,
  reconcile,
  settleSend,
  shownDraft,
  type ContextChange,
  type DiscardNotice,
  type DraftState,
  type SendResult,
} from "../lib/turn-draft.js";
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

/** 表示が最新に追いついていなかったので操作を送らなかったときの案内（D143）。 */
export const RESYNCED_NOTICE: SessionNotice = {
  message:
    "卓の表示を最新の状態に合わせました。操作はまだ送っていません。卓を確かめて、もう一度確定してください。",
  retryable: false,
};

/**
 * 送った操作の応答が届かなかったときの案内。server が受けたかどうか分からないので、同じ時点・同じ操作の再送だけを操作の欄に出す
 * （届いていれば server が stale_view で弾くので二重には適用されない。新しい操作と混ぜない）。
 */
export const OPERATION_UNKNOWN_NOTICE: SessionNotice = {
  message:
    "送った操作がサーバーに届いたか確認できませんでした。操作の欄の「同じ操作をもう一度送る」で、同じ時点の操作として送り直せます（届いていれば二重には適用されません）。",
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
  /** Hero の未送信の操作の下書き（#219・D146）と、その送信・再確認の操作。 */
  readonly turnDraft: TurnDraftControls;
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

/** 送った操作の今の段階。sending は応答待ち、unknown は応答が届かず結果が分からない（同じ操作の再送だけを許す）。 */
export type DraftPhase = "idle" | "sending" | "unknown";

export interface TurnDraftControls {
  /** 画面に出す下書き（手元の Chip・Betting Area に出した Chip と宣言の順番）。送っている間は送った操作の列。 */
  readonly draft: TurnDraft;
  /** 組み始めた後に状況（currentBet・Hero の出し済みの額）が変わり、もう一度の確定を待っている操作（UX04-1=A）。 */
  readonly change: ContextChange | null;
  readonly phase: DraftPhase;
  /** 中身のあった下書きを無効化で捨てたときの通知（UX04-3=A）。 */
  readonly discarded: DiscardNotice | null;
  /**
   * 下書きを変える。shown は Hero が見ている卓（displayed）。下書きが無ければ shown の operationKey と状況を錨にして組み始める。
   * 送った操作の結果を待つ間は変えない。
   */
  readonly edit: (
    shown: HeroView,
    change: (draft: TurnDraft) => TurnDraft,
  ) => void;
  /**
   * 下書きを Dealer に渡す。completing は宣言だけで決まる宣言（Fold / Check / Call / All-in）で、送れたときだけ操作に入る
   * （送らなかったら下書きに残さない）。表示が最新でなければ送らずに合わせ、錨の operationKey と状況を照合する（D143・D146）。
   */
  readonly submit: (shown: HeroView, completing: Declaration | null) => void;
  /** 示した状況の変化を確認して、もう一度確定する。その間にさらに変わっていたら送らずに示し直す。 */
  readonly confirm: (shown: HeroView) => void;
  /** 応答が届かなかった操作を、同じ lastSeq・同じ操作で送り直す（新しい操作として送り直さない）。 */
  readonly resend: () => void;
  /** 下書きを捨てた通知を閉じる。 */
  readonly dismissDiscarded: (id: number) => void;
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
  // 同期（resync）で、描画を待たずに最新の確認待ちを使うため ref にも置く（latestView と同じ。同じ tick に届いた待ちを越えない）。
  const latestEtiquette = useRef<HandEtiquetteStatus | null>(null);
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
  // Hero の操作の下書き（#219）。送信の直前に描画を待たずに読むため ref にも置く（updateDraft で同時に更新する）。
  const [draftState, setDraftState] = useState<DraftState>(INITIAL_DRAFT_STATE);
  const draftRef = useRef<DraftState>(INITIAL_DRAFT_STATE);
  const updateDraft = useCallback(
    (change: (current: DraftState) => DraftState) => {
      const next = change(draftRef.current);
      if (next === draftRef.current) return;
      draftRef.current = next;
      setDraftState(next);
    },
    [],
  );
  // SSE を張り直すための世代。開始が成功するたびに進める。
  const [streamEpoch, setStreamEpoch] = useState(0);

  // 遅れて届いた応答がどの Hand のものかを判定するため、現在の Hand を ref でも持つ。
  const activeHandId = useRef<string | null>(null);
  const inFlight = useRef(false);
  // 再送ボタンで同じ要求をやり直すために、最後に失敗した要求（開始・障害の選択・確認）を覚えておく。
  // 送ったときの値ごと覚え、再送でも同じ値を送る。物理的な操作の再送は下書きの層（turnDraft.resend）が、送ったときの lastSeq と
  // 操作の列を持つ（応答だけが失われて実は適用済みだった場合、サーバーが stale_view で弾くので、次の手番へ誤って適用されない）。
  const lastFailed = useRef<
    | {
        kind: "start";
        afterHandId: string | null;
        session: SessionRequest | undefined;
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
    const next = selectEtiquetteStatus(
      latestEtiquette.current,
      { handId: handIdOf, status },
      activeHandId.current,
    );
    latestEtiquette.current = next;
    setEtiquette(next);
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
  const resync = useCallback(() => {
    const current = latestEtiquette.current;
    presentationSync(
      latestView.current,
      current !== null && current.handId === activeHandId.current
        ? current.status.pendingRulingSeq
        : null,
    );
  }, [presentationSync]);

  // 結果（complete の View）まで見た最後の Hand。開始の要求で送り、サーバーが再送と「次の Hand」を区別する。
  // 「見た」は Hero に見せた卓（displayed）で判定する（演出の途中で届いた complete を見たことにしない）。
  const displayed = presentation.displayed;
  const seenComplete = useRef<string | null>(null);
  // 送信の応答の処理（描画の外）で、最後に描画した displayed を読むため ref にも置く。
  const displayedRef = useRef<HeroView | null>(null);
  useEffect(() => {
    displayedRef.current = displayed;
  }, [displayed]);
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
   * failed は失敗したときに再送で同じ値を送るための記録（null なら覚えない。物理的な操作は下書きの層が同じ操作の再送を持つ）。
   * onSettled は応答の結果（受理・拒否・届かなかった）を、別の Hand へ移った後でも伝える（下書きの送信の記録を外すため）。
   */
  const submit = useCallback(
    (
      sentFor: string,
      request: () => Promise<HeroActionResponse>,
      failed: NonNullable<typeof lastFailed.current> | null,
      onSettled?: (result: SendResult) => void,
    ) => {
      if (inFlight.current) return false;
      inFlight.current = true;
      setPending(true);
      setNotice(null);
      lastFailed.current = null;
      request()
        .then((res) => {
          acceptResponse(sentFor, res);
          onSettled?.({ kind: "accepted" });
        })
        .catch((error: unknown) => {
          const kind = error instanceof ApiError ? error.kind : "unknown";
          // network（届かなかった）と unknown（5xx・壊れた応答）は、server が受けたかどうか分からない。それ以外は server の拒否。
          onSettled?.(
            kind === "network" || kind === "unknown"
              ? { kind: "unknown" }
              : {
                  kind: "rejected",
                  notApplied:
                    kind !== "stale_view" && kind !== "etiquette_ack_required",
                },
          );
          // 送信中に別の Hand へ移っていたら、前の Hand の失敗は表示しない。
          if (activeHandId.current !== sentFor) return;
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
          if (failed === null) {
            // 物理的な操作: 届いたか分からなければ、同じ操作の再送は操作の欄に出す（再送ボタンを二重に出さない）。
            // stale_view は最新の状態を読み直して、表示を合わせる（下書きは残り、自動で送り直さない。D146）。
            if (kind === "stale_view") reread();
            setNotice(
              kind === "network" || kind === "unknown"
                ? OPERATION_UNKNOWN_NOTICE
                : noticeOf(error),
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

  /**
   * 物理的な操作を送る。lastSeq は「この操作を送ると決めたときに見ていた View」の値。送り始めたら下書きに送った操作を記録し
   * （送り始めただけでは捨てない）、応答の結果で記録を更新する（lib/turn-draft.ts の markSending / settleSend）。
   */
  const send = useCallback(
    (
      sentFor: string,
      shown: HeroView,
      lastSeq: number,
      actions: readonly PhysicalAction[],
    ) => {
      const started = submit(
        sentFor,
        () => sendHeroPhysicalActions(sentFor, lastSeq, actions),
        null,
        // 応答の前に届いた最新の View で結果が分かっていることがあるので、記録を更新したら照合し直す（effect は View が変わるまで走らない）。
        (result) =>
          updateDraft((s) =>
            reconcile(
              settleSend(s, lastSeq, result),
              displayedRef.current,
              latestView.current,
            ),
          ),
      );
      if (started) {
        updateDraft((s) => markSending(s, shown, lastSeq, actions));
      }
      return started;
    },
    [submit, updateDraft],
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

  // 表示・受信が変わるたびに下書きを照合する: 有効性は Hero が見ている卓（displayed）の operationKey、送った操作の結果は最新の
  // View（authoritative）で判定する（lib/turn-draft.ts の reconcile）。画面に何を出していても（Home / Learn に移っていても）走る。
  useEffect(() => {
    updateDraft((s) => reconcile(s, displayed, latestView.current));
  }, [displayed, view, updateDraft]);

  /**
   * 下書きの操作を送る前の共通の照合。送ってよければ送る。
   * - 確認を待っている間は送らない（server も拒否する。下書きは残す。D145・D146）
   * - Hero が見ていた卓が最新でなければ送らない（未表示の最新の lastSeq を先取りしない。D143）。表示を最新へ合わせ、最新の卓で
   *   錨を照合して、捨てる・状況の変化を示す・もう一度確定させる（同期の後に Hero が見て決める）
   * - 最新なら錨を照合し、operationKey が違えば捨て、状況が違えば変化を示して再確認を待ち、同じならその卓の lastSeq で送る
   */
  const sendChecked = useCallback(
    (
      shown: HeroView,
      actions: readonly PhysicalAction[],
      check: (
        state: DraftState,
        view: HeroView,
      ) => {
        readonly kind: "send" | "changed" | "discarded" | "ignored";
        readonly state: DraftState;
      },
    ) => {
      if (handId === null || actions.length === 0) return;
      if (pendingRulingSeq !== null) {
        setNotice(ETIQUETTE_REQUIRED_NOTICE);
        return;
      }
      const latest = latestView.current;
      if (!canSendFrom(shown, latest)) {
        resync();
        if (latest === null || latest.handId !== shown.handId) {
          setNotice(RESYNCED_NOTICE);
          return;
        }
        const result = check(draftRef.current, latest);
        // 状況が同じでも、表示を合わせたので Hero にもう一度確定させる（送らない）。捨てた・変化を示したときはその表示が案内になる。
        if (result.kind !== "send") updateDraft(() => result.state);
        if (result.kind === "send") setNotice(RESYNCED_NOTICE);
        return;
      }
      const result = check(draftRef.current, shown);
      updateDraft(() => result.state);
      if (result.kind === "send")
        send(handId, shown, lastSeqOf(shown), actions);
    },
    [handId, pendingRulingSeq, resync, send, updateDraft],
  );

  const editTurnDraft = useCallback(
    (shown: HeroView, change: (draft: TurnDraft) => TurnDraft) =>
      updateDraft((s) => editDraft(s, shown, latestView.current, change)),
    [updateDraft],
  );

  const submitTurnDraft = useCallback(
    (shown: HeroView, completing: Declaration | null) => {
      const current = reconcile(draftRef.current, shown, latestView.current);
      updateDraft(() => current);
      const actions = actionsToSend(current.slot, completing);
      sendChecked(shown, actions, (state, view) =>
        checkSend(state, view, actions),
      );
    },
    [sendChecked, updateDraft],
  );

  const confirmTurnDraft = useCallback(
    (shown: HeroView) => {
      const actions = draftRef.current.slot?.change?.actions ?? [];
      sendChecked(shown, actions, confirmChange);
    },
    [sendChecked],
  );

  const resendTurnDraft = useCallback(() => {
    const sent = draftRef.current.slot?.inFlight;
    const shown = displayed;
    if (handId === null || shown === null || sent?.phase !== "unknown") return;
    // 確認を待っている間は送らない（server も拒否する。D145）。
    if (pendingRulingSeq !== null) {
      setNotice(ETIQUETTE_REQUIRED_NOTICE);
      return;
    }
    // 送ったときの lastSeq・操作のまま送り直す（最新の lastSeq に書き換えない。受理済みなら server が stale_view で弾く）。
    send(handId, shown, sent.lastSeq, sent.actions);
  }, [displayed, handId, pendingRulingSeq, send]);

  const dismissDiscarded = useCallback(
    (id: number) => updateDraft((s) => dismissDiscardedNotice(s, id)),
    [updateDraft],
  );

  const turnDraft: TurnDraftControls = {
    draft: shownDraft(draftState.slot),
    change: draftState.slot?.change ?? null,
    phase: draftState.slot?.inFlight?.phase ?? "idle",
    discarded: draftState.discarded,
    edit: editTurnDraft,
    submit: submitTurnDraft,
    confirm: confirmTurnDraft,
    resend: resendTurnDraft,
    dismissDiscarded,
  };

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
    else if (failed?.kind === "outage")
      sendOutageChoice(failed.handId, failed.revision, failed.choice);
    else if (failed?.kind === "etiquette")
      sendEtiquetteAck(failed.handId, failed.rulingSeq);
  }, [requestStart, sendEtiquetteAck, sendOutageChoice]);

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
      acceptEtiquette(handId, status);
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
  }, [
    accept,
    acceptEtiquette,
    acceptOutage,
    acceptSession,
    handId,
    resync,
    streamEpoch,
  ]);

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
    turnDraft,
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
