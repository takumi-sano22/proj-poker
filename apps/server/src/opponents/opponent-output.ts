// CPU 出力の検証（docs/03 §5・D40・D41）。順番は Schema → Legal Action → Amount Range。
// 合法性の基準は Engine が計算した Legal Action で、CPU（LLM）には判断させない。最終的な適用可否も Engine（applyAction）が決める。
import type { LegalActionSet, PlayerAction } from "@proj-poker/engine";
import type { InvalidOutputStage, OpponentOutput } from "./opponent-agent.js";

export type OutputCheck =
  | {
      readonly ok: true;
      readonly action: PlayerAction;
      readonly rationale: string | null;
    }
  | {
      readonly ok: false;
      readonly stage: InvalidOutputStage;
      readonly reason: string;
    };

const ACTION_TYPES: readonly OpponentOutput["action"][] = [
  "fold",
  "check",
  "call",
  "bet",
  "raise",
  "all_in",
];
const KNOWN_KEYS = new Set(["action", "amount", "rationale"]);

/** CPU の出力を検証し、Engine に渡す PlayerAction にする。不正なら最初に引っかかった段と理由を返す。 */
export function checkOpponentOutput(
  raw: unknown,
  legal: LegalActionSet,
): OutputCheck {
  // 1. Schema: 形だけを見る（今の手番で選べるかは次の段）。余分な項目は黙って捨てずに不正とする。
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return invalid("schema", "出力はオブジェクトにする");
  }
  const record = raw as Record<string, unknown>;
  const unknownKeys = Object.keys(record).filter((k) => !KNOWN_KEYS.has(k));
  if (unknownKeys.length > 0) {
    return invalid("schema", `知らない項目がある: ${unknownKeys.join(", ")}`);
  }
  const { action, amount, rationale } = record;
  if (
    typeof action !== "string" ||
    !(ACTION_TYPES as readonly string[]).includes(action)
  ) {
    return invalid(
      "schema",
      `action は ${ACTION_TYPES.join(" / ")} のどれか: ${String(action)}`,
    );
  }
  const type = action as OpponentOutput["action"];
  const sized = type === "bet" || type === "raise";
  if (sized && !Number.isSafeInteger(amount)) {
    return invalid("schema", `${type} の amount は整数: ${String(amount)}`);
  }
  if (!sized && amount !== undefined) {
    return invalid("schema", `${type} に amount は付けない`);
  }
  if (rationale !== undefined && typeof rationale !== "string") {
    return invalid("schema", "rationale は文字列にする");
  }

  // 2. Legal Action: 今の手番で選べる種類か。
  const option = legal.actions.find((a) => a.type === type);
  if (option === undefined) {
    const allowed = legal.actions.map((a) => a.type).join(" / ");
    return invalid(
      "legal_action",
      `今は ${type} できない（選べるのは ${allowed}）`,
    );
  }

  // 3. Amount Range: bet / raise の額が Legal な範囲（to 額の min〜max）に入っているか。
  if (option.type === "bet" || option.type === "raise") {
    const to = amount as number;
    if (to < option.min || to > option.max) {
      return invalid(
        "amount_range",
        `${option.type} の額は ${option.min}〜${option.max}: ${to}`,
      );
    }
    return ok({ type: option.type, amount: to }, rationale);
  }
  return ok({ type: option.type }, rationale);
}

function ok(action: PlayerAction, rationale: unknown): OutputCheck {
  return {
    ok: true,
    action,
    rationale: typeof rationale === "string" ? rationale : null,
  };
}

function invalid(stage: InvalidOutputStage, reason: string): OutputCheck {
  return { ok: false, stage, reason };
}
