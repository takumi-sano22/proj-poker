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
