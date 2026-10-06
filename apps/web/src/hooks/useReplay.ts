// Replay の画面状態（#68・D93）。Hand 一覧と、選んだ Hand の Hero の視点の step の列をサーバーから受け取り、
// どの step を見せるか（Previous / Next / Play / Pause）だけをクライアントで持つ。卓の状態はクライアントで進めない（D38）。
// 古い応答で画面を戻さないよう、取得のたびに番号を振り、最後に出した要求の応答だけを採る（一覧と Hand で別々に数える）。
// Jump to Important Spot（#84・D93）は、サーバーが返した判断時点の step の位置へ移るだけ（状態は作らない）。
import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchReplayHand,
  fetchReplayHands,
  type ReplayHand,
  type ReplayHandSummary,
} from "../lib/api.js";
import { REPLAY_STEP_MS } from "../lib/config.js";
import {
  nextStepIndex,
  playStartIndex,
  previousStepIndex,
} from "../lib/replay.js";

export type ReplayLoad = "idle" | "loading" | "failed";

export interface ReplayState {
  /** Hand 一覧（まだ届いていなければ null）。 */
  readonly hands: readonly ReplayHandSummary[] | null;
  readonly listLoad: ReplayLoad;
  /** 再生中の Hand（一覧を見ている間は null）。 */
  readonly hand: ReplayHand | null;
  readonly handLoad: ReplayLoad;
  readonly step: number;
  readonly playing: boolean;
  readonly refresh: () => void;
  /** Hand を開く。step を渡すとその step から見せる（Review から判断時点の場面を開くとき）。 */
  readonly open: (handId: string, step?: number) => void;
  /** 一覧へ戻る（一覧は取り直す。見ている間に終わった Hand を反映するため）。 */
  readonly close: () => void;
  readonly previous: () => void;
  readonly next: () => void;
  readonly play: () => void;
  readonly pause: () => void;
  /** 指定の step へ移る（Jump to Important Spot）。再生は止める。 */
  readonly jump: (step: number) => void;
}

/** 最初に開く Hand と step（Review から Replay を開いたとき）。 */
export interface ReplayStart {
  readonly handId: string;
  readonly step: number;
}

export function useReplay(start: ReplayStart | null = null): ReplayState {
  const [hands, setHands] = useState<readonly ReplayHandSummary[] | null>(null);
  const [listLoad, setListLoad] = useState<ReplayLoad>("loading");
  const [hand, setHand] = useState<ReplayHand | null>(null);
  const [handLoad, setHandLoad] = useState<ReplayLoad>("idle");
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(false);
  const listRequest = useRef(0);
  const handRequest = useRef(0);

  // 一覧を取りに行く。読み込み中の印は呼び出し側が付ける（最初の描画では初期値で付いている）。
  const load = useCallback(() => {
    const id = ++listRequest.current;
    fetchReplayHands().then(
      (list) => {
        if (id !== listRequest.current) return;
        setHands(list);
        setListLoad("idle");
      },
      () => {
        if (id === listRequest.current) setListLoad("failed");
      },
    );
  }, []);

  const refresh = useCallback(() => {
    setListLoad("loading");
    load();
  }, [load]);

  const open = useCallback((handId: string, startStep = 0) => {
    const id = ++handRequest.current;
    setHandLoad("loading");
    setPlaying(false);
    fetchReplayHand(handId).then(
      (loaded) => {
        if (id !== handRequest.current) return;
        setHand(loaded);
        setStep(
          Math.min(
            Math.max(0, startStep),
            Math.max(0, loaded.steps.length - 1),
          ),
        );
        setHandLoad("idle");
      },
      () => {
        if (id === handRequest.current) setHandLoad("failed");
      },
    );
  }, []);

  const close = useCallback(() => {
    // 取得中の Hand の応答が後から届いても、一覧の画面を上書きしない。
    handRequest.current++;
    setHand(null);
    setHandLoad("idle");
    setPlaying(false);
    refresh();
  }, [refresh]);

  const length = hand?.steps.length ?? 0;
  const previous = useCallback(() => {
    setPlaying(false);
    setStep((i) => previousStepIndex(i));
  }, []);
  const next = useCallback(() => {
    setPlaying(false);
    setStep((i) => nextStepIndex(i, length));
  }, [length]);
  const play = useCallback(() => {
    setStep((i) => playStartIndex(i, length));
    setPlaying(true);
  }, [length]);
  const pause = useCallback(() => setPlaying(false), []);
  const jump = useCallback(
    (to: number) => {
      setPlaying(false);
      setStep(Math.min(Math.max(0, to), Math.max(0, length - 1)));
    },
    [length],
  );

  // 再生中は一定の間隔で次の step へ進め、最後の step で止める（最後に着いたら再生中として扱わない）。
  const playingNow = playing && step < length - 1;
  useEffect(() => {
    if (!playingNow) return;
    const timer = setTimeout(
      () => setStep((i) => nextStepIndex(i, length)),
      REPLAY_STEP_MS,
    );
    return () => clearTimeout(timer);
  }, [playingNow, step, length]);

  // 最初に開いたときに一覧を取る。開く Hand の指定があれば、その Hand も開く（指定は最初の 1 回だけ使う）。
  const startRef = useRef(start);
  useEffect(() => {
    load();
    const first = startRef.current;
    if (first !== null) open(first.handId, first.step);
  }, [load, open]);

  return {
    hands,
    listLoad,
    hand,
    handLoad,
    step,
    playing: playingNow,
    refresh,
    open,
    close,
    previous,
    next,
    play,
    pause,
    jump,
  };
}
