// 保存済み Event の upcast（D76）。旧版の payload を、読み込み時に現在の HandEvent の形へそろえる。
// 保存済みの行は書き換えない（events は append-only。D37）。読むたびに同じ変換をする。
import type { HandEvent } from "@proj-poker/engine";

// 版 9 は SESSION_STARTED に Tournament の設定の Snapshot（項目 tournament。cash の Session は持たない。D129・#183）を足した。
// 版 8 までの SESSION_STARTED は tournament を持たず、版 9 の cash の Session の SESSION_STARTED と同じ形なので、変換せずに読み、
// cash の Session として読む（Engine の sessionSettingsOf）。版 8 の行は版 9 の行として読めるので、upcast の関数は足さない。
// 版 10 は Tournament の Hand の Ante と Level（D128・D129・#184）として、HAND_STARTED に ante（Ante の種類と額）・tournament（Level と経過）を、
// Event の種類に ANTE_POSTED を足した。どちらの項目も持たない Hand（Cash・Tournament でない Hand）は版 9 と同じ形で、Engine は ante の無い
// HAND_STARTED を Ante なし（none）の Hand として畳み込む（hand-state.ts の initialState）。版 9 までの行は ante も ANTE_POSTED も持たない
// ので、変換せずに Ante なしの Hand として読む。版 9 の行は版 10 の行として読めるので、upcast の関数は足さない（版 9 と同じ扱い）。
// 版 9 で保存した Tournament の Hand（Level を持たない）の次の Hand の Level は、Orchestrator が Session の Hand の数から作る。

/** 版 1〜7 に無い Event（Hero の User Read。版 8 で足した。D112・#115）。 */
type UserReadEventV8 = Extract<HandEvent, { type: "USER_READ_RECORDED" }>;

/**
 * 版 7 の Event。版 8 は Event の種類（USER_READ_RECORDED）を足しただけで、版 7 にあった Event の形は変えていないので、
 * 版 7 の Event はそのまま版 8 の Event として読める（変換は要らない）。
 */
export type HandEventV7 = Exclude<HandEvent, UserReadEventV8>;

/** 版 1〜6 に無い Event（Hand ごとの Best-effort Metadata。版 7 で足した。#97）。 */
type MetadataEventV7 = Extract<HandEventV7, { type: "HAND_METADATA_RECORDED" }>;

/**
 * 版 6 の Event。版 7 は Event の種類（HAND_METADATA_RECORDED）を足しただけで、版 6 にあった Event の形は変えていないので、
 * 版 6 の Event はそのまま版 7 の Event として読める（変換は要らない）。
 */
export type HandEventV6 = Exclude<HandEventV7, MetadataEventV7>;

/** 版 1〜5 に無い Event（Session の開始・終了・Hand の打ち切り・Emergency Bot への切り替え。版 6 で足した。D95）。 */
type SessionEventV6 = Extract<
  HandEventV6,
  {
    type:
      | "SESSION_STARTED"
      | "SESSION_ENDED"
      | "HAND_ABORTED"
      | "EMERGENCY_BOT_ENGAGED";
  }
>;

/**
 * 版 5 の Event。版 6 は Event の種類（SESSION_STARTED / SESSION_ENDED / HAND_ABORTED / EMERGENCY_BOT_ENGAGED）を足しただけで、
 * 版 5 にあった Event の形は変えていないので、版 5 の Event はそのまま版 6 の Event として読める（変換は要らない）。
 */
export type HandEventV5 = Exclude<HandEventV6, SessionEventV6>;

/** 版 1〜4 に無い Event（Hero の宣言・Chip の操作・Dealer の裁定。版 5 で足した。D90）。 */
type LiveEventV5 = Extract<
  HandEventV5,
  { type: "PLAYER_DECLARED" | "PHYSICAL_CHIP_ACTION" | "DEALER_RULING" }
>;

/**
 * 版 4 の Event。版 5 は Event の種類（PLAYER_DECLARED / PHYSICAL_CHIP_ACTION / DEALER_RULING）を足しただけで、
 * 版 4 にあった Event の形は変えていないので、版 4 の Event はそのまま版 5 の Event として読める（変換は要らない）。
 */
export type HandEventV4 = Exclude<HandEventV5, LiveEventV5>;

/** 版 1〜3 に無い Event（CPU の判断の経緯。版 4 で足した。D83）。 */
type AiEventV4 = Extract<
  HandEventV4,
  { type: "AI_ACTION_INVALID" | "AI_FALLBACK_USED" }
>;

/**
 * 版 3 の Event。版 4 は Event の種類（AI_ACTION_INVALID / AI_FALLBACK_USED）を足しただけで、
 * 版 3 にあった Event の形は変えていないので、版 3 の Event はそのまま版 4 の Event として読める（変換は要らない）。
 */
export type HandEventV3 = Exclude<HandEventV4, AiEventV4>;

/** 版 1・2 の HAND_STARTED（reopenRule が無い）。 */
type HandStartedV2 = Omit<
  Extract<HandEventV3, { type: "HAND_STARTED" }>,
  "reopenRule"
>;

/** 版 2 の Event。HAND_STARTED 以外の形は版 3 と同じ。 */
export type HandEventV2 =
  Exclude<HandEventV3, { type: "HAND_STARTED" }> | HandStartedV2;

/** 版 1 の POT_AWARDED（Phase 1 の単一 Pot。potIndex と eligible が無い）。 */
type PotAwardedV1 = Omit<
  Extract<HandEventV3, { type: "POT_AWARDED" }>,
  "potIndex" | "eligible"
>;

/** 版 1 の Event。POT_AWARDED 以外の形は版 2 と同じ。 */
export type HandEventV1 =
  Exclude<HandEventV2, { type: "POT_AWARDED" }> | PotAwardedV1;

/**
 * 版 1 → 版 2（D78）。版 1 は単一 Pot なので、POT_AWARDED を Main Pot（potIndex 0）とし、
 * eligible はその時点で Fold していない Player（Button の左から時計回りの順。版 2 の Engine と同じ順）で補う。
 * Fold で決着した Hand では勝者 1 人、Showdown ではその Hand に残った全員になる。
 * events は 1 Hand 分を seq 順に渡す（Fold の有無を前の Event から数えるため）。
 */
export function upcastV1ToV2(events: readonly HandEventV1[]): HandEventV2[] {
  const folded = new Set<string>();
  let seatsFromButton: readonly string[] = [];
  return events.map((event): HandEventV2 => {
    switch (event.type) {
      case "HAND_STARTED": {
        const ids = event.seats.map((s) => s.playerId);
        const button = ids.indexOf(event.buttonPlayerId);
        seatsFromButton = ids.map(
          (_, k) => ids[(button + 1 + k) % ids.length] as string,
        );
        return event;
      }
      case "ACTION_TAKEN":
        if (event.action === "fold") folded.add(event.playerId);
        return event;
      case "POT_AWARDED":
        return {
          ...event,
          potIndex: 0,
          eligible: seatsFromButton.filter((id) => !folded.has(id)),
        };
      default:
        return event;
    }
  });
}

/**
 * 版 2 → 版 3（D79）。HAND_STARTED に reopenRule（Short All-in の後の Raise の再開規則）を補う。
 * 補う値は版 3 の暫定値 cumulative_full_raise。版 2 までの Engine は「Full Raise があったか」だけで再開を判定したが、
 * 次の 2 点から、版 2 までの保存済み Hand をこの値で読んでも結果は変わらない。
 * - reopenRule は Reducer の State 遷移に使わず、Legal Action の計算（canRaise）だけに使う。保存済み Event の再生は同じ
 * - 版 2 までの Server は全員同じ Stack で Hand を始める（PHASE1_TABLE_SETUP）。Fold していない Player の
 *   「この Street で出せる上限」は全員同じなので、最高額を上げる All-in は 1 Street に 1 回までになり、
 *   Short All-in の累積と単発が一致する（Legal Action も同じになる）
 * 1 Event ずつ変換できるので、版 1 の行は upcastV1ToV2 の後にこれを通す。
 */
export function upcastV2ToV3(event: HandEventV2): HandEventV3 {
  return event.type === "HAND_STARTED"
    ? { ...event, reopenRule: "cumulative_full_raise" }
    : event;
}
