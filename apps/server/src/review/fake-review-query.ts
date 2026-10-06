// E2E 用の Review AI（REVIEW_PROVIDER=fake。D98）。Claude を呼ばず、固定の応答を SDK の result の形で返す。
// CI の E2E（Playwright）で Review の画面の流れ（Pass A の段階評価・Pass B・Follow-up）を決定論で通すためだけに使い、本番の既定は Claude のまま。
// - 呼び出しの種類（Pass A / Pass B / Follow-up）は、渡された構造化出力の Schema の項目で見分ける（Prompt の文言に依存しない）
// - evidenceIds は Schema の enum（その Evidence が持つ id）から選ぶので、どの Hand でも検証（grounding）を通る
// - 検証・保存・画面は本番と同じ経路を通る（runStructuredQuery が result の structured_output を読む）
// 文はどの Hand にも当てはまる一般的な内容にし、固定応答であることを先頭に明記する（実際の Review と取り違えないため）。
// 起動（index.ts）から選べるので、build（dist）に入る src/review に置く（src/testing は build から外す）。
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeQuery } from "../claude/structured-query.js";

/** 応答の文の先頭に付ける印。画面で固定応答と分かるようにし、E2E はこの印で応答が届いたことを確かめる。 */
export const FAKE_REVIEW_MARK = "（E2E 用の固定応答）";

/** 応答を返すまでの待ち（ミリ秒）。生成中（pending）の表示を一度は通るように、少しだけ待つ。 */
const FAKE_DELAY_MS = 300;

type CallKind = "decision" | "reveal" | "followup";

/** Schema の項目から呼び出しの種類を見分ける。知らない形なら null（呼び出し側で誤りにする）。 */
function callKindOf(schema: Record<string, unknown>): CallKind | null {
  const properties = schema["properties"];
  if (typeof properties !== "object" || properties === null) return null;
  if ("assessment" in properties) return "decision";
  if ("readComparison" in properties) return "reveal";
  if ("scope" in properties) return "followup";
  return null;
}

/** Schema の enum（properties.<key>.enum、配列なら items.enum）を読む。 */
function enumOf(schema: Record<string, unknown>, key: string): string[] {
  const properties = schema["properties"] as Record<string, unknown>;
  const property = properties[key] as Record<string, unknown> | undefined;
  const target =
    property?.["type"] === "array"
      ? (property["items"] as Record<string, unknown> | undefined)
      : property;
  const values = target?.["enum"];
  return Array.isArray(values)
    ? values.filter((v): v is string => typeof v === "string")
    : [];
}

/** 種類ごとの固定の応答。evidenceIds は Schema の候補の先頭 2 つ（候補が無ければ空）。 */
function fakeOutput(kind: CallKind, schema: Record<string, unknown>): unknown {
  const evidenceIds = enumOf(schema, "evidenceIds").slice(0, 2);
  switch (kind) {
    case "decision":
      return {
        assessment: "reasonable",
        confidence: "medium",
        practical: `${FAKE_REVIEW_MARK}Pot Odds と仮定した Range に対する Equity から見て、この判断は実戦的に妥当な範囲です。`,
        // Solver の結果の有無に関わらず選べる general_theory にする（Schema の enum に必ずある）。
        theoryBasis: "general_theory",
        theory: `${FAKE_REVIEW_MARK}Position と Range の関係から、一般的な理論とも矛盾しません。`,
        exploitBasis: "none",
        exploit: "",
        assumptions: [
          `${FAKE_REVIEW_MARK}相手の Range は Evidence の仮定どおり`,
        ],
        conclusionChangers: [
          `${FAKE_REVIEW_MARK}相手の Range がもっと狭ければ結論が変わる`,
        ],
        evidenceIds,
      };
    case "reveal":
      return {
        readComparison: `${FAKE_REVIEW_MARK}判断時点に仮定した Range と、Hand 後に見せた実際の札を比べます。`,
        actualEquity: `${FAKE_REVIEW_MARK}実際の Equity と仮定した Range に対する Equity の違いは、1 Hand の結果だけでは判断の質を変えません。`,
        bluffValue: `${FAKE_REVIEW_MARK}Bet / Raise の答え合わせは、Evidence の基準で value か bluff かを見ます。`,
        takeaways: [
          `${FAKE_REVIEW_MARK}Range の想定の幅を次の Spot でも意識する`,
        ],
        evidenceIds,
      };
    case "followup":
      return {
        scope: evidenceIds.length > 0 ? "answered" : "out_of_scope",
        answer: `${FAKE_REVIEW_MARK}Evidence の範囲で答えると、この判断の考え方は Review の説明のとおりです。`,
        evidenceIds,
      };
  }
}

/** E2E 用の query()。SDK の result（success・structured_output）の形で 1 つだけ流す。 */
export const fakeReviewQuery: ClaudeQuery = ({ options }) => {
  const format = options.outputFormat;
  const schema = format?.type === "json_schema" ? format.schema : {};
  const kind = callKindOf(schema);
  if (kind === null) {
    throw new Error("E2E 用の Review AI が知らない構造化出力の Schema");
  }
  const message = {
    type: "result",
    subtype: "success",
    is_error: false,
    result: "",
    structured_output: fakeOutput(kind, schema),
  } as unknown as SDKMessage;
  const signal = options.abortController?.signal;
  return (async function* () {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, FAKE_DELAY_MS);
      // アプリの終了・上限の超過で止められたら待たずに終える（本番の子プロセスの停止と同じく、結果は使われない）。
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
    yield message;
  })();
};
