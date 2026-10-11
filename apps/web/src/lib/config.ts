// 画面の表示の設定。値は暫定値（Open Item。永久仕様ではない）。
import { PHASE1_CASH_PRESET } from "@proj-poker/engine";

/**
 * Chip の額面と色の対応（Table Config の Preset。D92・OI-004 の暫定値）。額面・色は Config 側が持ち、
 * 表示コンポーネントには書かない。色の名前に対応する実際の色は styles.css のトークン（`--color-chip-<名前>`）が持つ。
 */
export const CHIP_DENOMINATIONS = PHASE1_CASH_PRESET.chipDenominations;

/**
 * CPU の手番がこれより長く続いたら「AI応答が遅延しています」を補足する（ミリ秒。docs/06 §11・D86）。
 * 暫定値（OI-001 の Latency Policy が決まるまでの仮置き）。#50 の実測（Claude の 1 回の判断は中央値 約 7.2 秒・p90 約 8.6 秒）で、
 * 普段の待ちでは出ず、p90 を超えて待つときに出る値にした。障害として止める上限（サーバーの OPPONENT_TIMEOUT_MS。30 秒）より短い。
 */
export const AI_DELAY_NOTICE_MS = 10_000;

/**
 * Replay の Play で次の step へ進む間隔（ミリ秒。#68）。暫定値: 1 手ずつ目で追え、1 Hand（30〜60 step）が 1 分弱で終わる値。
 */
export const REPLAY_STEP_MS = 900;

/**
 * Review の生成を待っている間に状態を取り直す間隔（ミリ秒。#84）。暫定値: 生成は 1 回 十数秒〜数十秒（#82 の実測 12.5〜27.6 秒）なので、
 * 終わってから 2 秒以内に画面へ出る間隔にした。ローカルのサーバーへの GET だけで、AI は呼ばない。
 */
export const REVIEW_POLL_MS = 1_500;

/**
 * Review の生成がこれより長く続いたら「時間がかかっています」を補足する（ミリ秒。docs/06 §11）。暫定値: #82 の実測の最大（約 28 秒）を
 * 超えて待つときだけ出る値。生成は 1 つずつ順に進むので、前の生成の待ちも含む。
 */
export const REVIEW_DELAY_NOTICE_MS = 40_000;

/**
 * time-base の Tournament（D128）の進行中の Hand で、次の Level までの残り時間を取り直す間隔（ミリ秒。#190）。暫定値: 表示は分の単位
 * （切り上げ）なので、30 秒ごとに取り直せば表示が 1 分以上遅れない。ローカルのサーバーへの GET だけ。
 */
export const TOURNAMENT_REFRESH_MS = 30_000;

/**
 * Live の表示演出（Presentation Controller。#222・D140）の 1 step の所要時間の基準（ミリ秒。標準の速さ）。OI-012 の暫定値。
 * step の種類は最後の Event で決める（lib/presentation.ts の stepKindOf）。Flop は 3 枚を順に出すので Turn / River より長い。
 */
export const PRESENTATION_STEP_MS = {
  action: 550,
  flop: 1_000,
  board: 650,
  showdown: 900,
  pot: 1_000,
  finish: 400,
  other: 250,
} as const;

/** 表示演出の速度 4 段階ごとの所要時間の倍率（OI-012 の暫定値）。演出なしは 0（動きを省き、表示の内容は省かない）。 */
export const PRESENTATION_SPEED_SCALE = {
  standard: 1,
  fast: 0.5,
  turbo: 0.25,
  none: 0,
} as const;

/**
 * Hero の手番が来たとき、残っている通常の演出（Showdown の公開と Pot の配分以外）に掛ける倍率（OI-012 の暫定値。Q20）。
 */
export const PRESENTATION_HERO_TURN_SCALE = 0.25;

/**
 * 表示待ちの step の上限（有界のキュー）。超えた古い分は動きを省いて表示済みにする（卓は最新の公開状態から作るので内容は欠けない）。
 * 1 Hand の Hero に見える Event は多くて 100 前後で、通常は超えない。OI-012 の暫定値。
 */
export const PRESENTATION_MAX_PENDING_STEPS = 24;

/** Replay の Play の間隔に掛ける倍率（Live とは別に持つ速度。演出なしでも Play は進めるので最小は超高速と同じ）。OI-012 の暫定値。 */
export const REPLAY_SPEED_SCALE = {
  standard: 1,
  fast: 0.5,
  turbo: 0.25,
  none: 0.25,
} as const;

/**
 * Hero への裁定（RULING）の欄を出しておく時間（ミリ秒。D142 の「数秒」。#226）。OI-012 の暫定値。この時間で自動で閉じ、
 * ETIQUETTE の確認（Ack）が要る裁定なら続けて確認の欄を出す（確認は Hero が明示的に押すまで閉じない。D145）。
 * 表示演出の速度（演出なしを含む）には掛けない（裁定の事実を読む時間で、演出の動きではない）。
 */
export const RULING_OVERLAY_MS = 2_500;
