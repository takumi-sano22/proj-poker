// Claude の Opponent Agent のテスト。Claude は呼ばない: SDK の query() を Fake に差し替え、録画済み応答を流す（D87）。
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  PHASE1_CASH_PRESET,
  TOURNAMENT_PRESETS,
  cardToString,
  getLegalActions,
  projectKnowledgeState,
  startHand,
  tableConfigForLevel,
  tournamentKnowledgeOf,
  type HandEvent,
  type HeroView,
  type PlayerAction,
} from "@proj-poker/engine";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { PHASE1_TABLE_SETUP } from "../config.js";
import { InMemoryEventStore } from "../event-store.js";
import { HandOrchestrator } from "../hand-orchestrator.js";
import { allowedCardsAt } from "../testing/leaks.js";
import {
  ClaudeOpponent,
  ClaudeOpponentError,
  buildClaudeEnv,
  buildOpponentPrompt,
  createClaudeOpponentFactory,
  outageKindOf,
  systemPromptOf,
  type ClaudeQuery,
} from "./claude-opponent.js";
import type { OpponentMemorySummary } from "../memory/memory-summary.js";
import type { TableTendency } from "../memory/table-tendency.js";
import { OpponentOutageError, type OpponentInput } from "./opponent-agent.js";
import { checkOpponentOutput } from "./opponent-output.js";

// 録画済み応答: 2026-10-06 に SDK 0.3.289・claude-haiku-4-5 で実際に返った message から、使う項目だけを残したもの。
// 型の必須項目（usage 等）は省いているので SDKMessage へ cast する。
const RECORDED = {
  /** 正常: StructuredOutput で返った判断。 */
  success: [
    {
      type: "result",
      subtype: "success",
      is_error: false,
      num_turns: 2,
      result: "",
      structured_output: {
        action: "raise",
        amount: 6,
        rationale: "AA は最強のスターティングハンドなので、Pot を大きくする。",
      },
    },
  ],
  /** 未ログイン: assistant の error が authentication_failed で、result は success かつ is_error。 */
  notLoggedIn: [
    {
      type: "assistant",
      error: "authentication_failed",
      message: {
        content: [{ type: "text", text: "Not logged in · Please run /login" }],
      },
    },
    {
      type: "result",
      subtype: "success",
      is_error: true,
      result: "Not logged in · Please run /login",
    },
  ],
  /** StructuredOutput を呼ばずに文章で答え、ターン上限で止まった。 */
  maxTurns: [
    {
      type: "result",
      subtype: "error_max_turns",
      is_error: true,
      errors: ["Reached maximum number of turns (1)"],
    },
  ],
} as const;

/** 録画にない失敗の形（型定義 SDKAssistantMessageError / SDKResultError に沿って作ったもの）。 */
const CONSTRUCTED = {
  rateLimit: [
    {
      type: "assistant",
      error: "rate_limit",
      message: { content: [{ type: "text", text: "rate limited" }] },
    },
    {
      type: "result",
      subtype: "success",
      is_error: true,
      result: "rate limited",
    },
  ],
  duringExecution: [
    {
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      errors: ["process exited"],
    },
  ],
  structuredRetries: [
    {
      type: "result",
      subtype: "error_max_structured_output_retries",
      is_error: true,
      errors: ["could not produce valid output"],
    },
  ],
} as const;

interface FakeQuery {
  readonly query: ClaudeQuery;
  readonly calls: { prompt: string; options: Options }[];
}

/** 呼ばれるたびに respond(呼び出し) の message 列を流す Fake。受け取った prompt と options を記録する。 */
function fakeQuery(
  respond: (call: { prompt: string; options: Options }) => readonly unknown[],
): FakeQuery {
  const calls: { prompt: string; options: Options }[] = [];
  const query: ClaudeQuery = (params) => {
    calls.push(params);
    const messages = respond(params) as readonly SDKMessage[];
    return (async function* () {
      await Promise.resolve();
      yield* messages;
    })();
  };
  return { query, calls };
}

/** 6 人卓を seed で開始し、最初の Actor の入力を作る（Preflop で raise まで選べる）。 */
function firstDecisionInput(seed = 1): {
  input: OpponentInput;
  events: readonly HandEvent[];
} {
  const result = startHand({
    handId: `h${seed}`,
    seats: ["p1", "p2", "p3", "p4", "p5", "p6"].map((playerId) => ({
      playerId,
      stack: PHASE1_CASH_PRESET.startingStack,
    })),
    buttonPlayerId: "p1",
    config: PHASE1_CASH_PRESET,
    deal: { seed },
  });
  if (!result.ok) throw new Error(result.error.message);
  const legal = getLegalActions(result.value.state);
  if (legal === null) throw new Error("Actor がいない");
  return {
    input: {
      knowledge: projectKnowledgeState(result.value.events, legal.playerId),
      legal,
    },
    events: result.value.events,
  };
}

function agentWith(fake: FakeQuery, persona?: string): ClaudeOpponent {
  return new ClaudeOpponent({
    model: "test-model",
    env: { PATH: "/usr/bin" },
    query: fake.query,
    ...(persona === undefined ? {} : { persona }),
  });
}

/** Prompt に出てくる Card 表記（"As" 形式）。 */
function cardsIn(prompt: string): string[] {
  return [...prompt.matchAll(/"([2-9TJQKA][cdhs])"/g)].map((m) => m[1] ?? "");
}

describe("buildClaudeEnv", () => {
  it("ANTHROPIC_API_KEY と ANTHROPIC_AUTH_TOKEN を外し、ほかの変数（PATH・HOME 等）は写す（D87）", () => {
    const env = buildClaudeEnv({
      PATH: "/usr/bin",
      HOME: "/home/someone",
      ANTHROPIC_API_KEY: "sk-test-dummy",
      ANTHROPIC_AUTH_TOKEN: "dummy-token",
      OPPONENT_PROVIDER: "claude",
      UNSET: undefined,
    });
    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/someone",
      OPPONENT_PROVIDER: "claude",
    });
  });
});

describe("ClaudeOpponent", () => {
  it("単発の判断として呼ぶ: ターン 1・ツールなし・設定ファイルと MCP を読まない・role-based config のモデル・API キーを外した env", async () => {
    const fake = fakeQuery(() => RECORDED.success);
    const agent = createClaudeOpponentFactory({
      model: "claude-haiku-4-5",
      env: buildClaudeEnv({
        PATH: "/usr/bin",
        ANTHROPIC_API_KEY: "sk-test-dummy",
        ANTHROPIC_AUTH_TOKEN: "dummy-token",
      }),
      query: fake.query,
    })(1, "p4");
    const { input } = firstDecisionInput();
    await agent.decide(input);

    expect(fake.calls).toHaveLength(1);
    const options: Options = fake.calls[0]?.options ?? {};
    expect(options).toMatchObject({
      model: "claude-haiku-4-5",
      maxTurns: 1,
      tools: [],
      settingSources: [],
      mcpServers: {},
      strictMcpConfig: true,
      persistSession: false,
      cwd: tmpdir(),
    });
    expect(options.env).toEqual({ PATH: "/usr/bin" });
    expect(options.env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(options.env).not.toHaveProperty("ANTHROPIC_AUTH_TOKEN");
    // 構造化出力: action は今選べる type だけに絞る。
    expect(options.outputFormat?.type).toBe("json_schema");
    expect(options.outputFormat?.schema["properties"]).toMatchObject({
      action: { type: "string", enum: input.legal.actions.map((a) => a.type) },
    });
  });

  it("録画済みの正常な応答: structured_output をそのまま返し、Orchestrator の検証を通る", async () => {
    const agent = agentWith(fakeQuery(() => RECORDED.success));
    const { input } = firstDecisionInput();
    const output = await agent.decide(input);
    expect(output).toEqual(RECORDED.success[0].structured_output);
    expect(checkOpponentOutput(output, input.legal)).toMatchObject({
      ok: true,
      action: { type: "raise", amount: 6 },
    });
  });

  it("未ログイン（録画）・利用枠の上限・実行中の失敗・結果なしは障害（例外）にする", async () => {
    const { input } = firstDecisionInput();
    const cases: [readonly unknown[], RegExp][] = [
      [RECORDED.notLoggedIn, /authentication_failed.*Not logged in/],
      [CONSTRUCTED.rateLimit, /rate_limit/],
      [CONSTRUCTED.duringExecution, /error_during_execution.*process exited/],
      [[], /結果が返らなかった/],
    ];
    for (const [messages, pattern] of cases) {
      const agent = agentWith(fakeQuery(() => messages));
      await expect(agent.decide(input)).rejects.toThrow(ClaudeOpponentError);
      await expect(agent.decide(input)).rejects.toThrow(pattern);
    }
  });

  it("障害の種類を分ける: 未ログイン → unauthenticated・利用枠の上限 → usage_limit・それ以外 → error（#52）", async () => {
    const { input } = firstDecisionInput();
    const cases: [readonly unknown[], string][] = [
      [RECORDED.notLoggedIn, "unauthenticated"],
      [CONSTRUCTED.rateLimit, "usage_limit"],
      [CONSTRUCTED.duringExecution, "error"],
      [[], "error"],
    ];
    for (const [messages, kind] of cases) {
      const agent = agentWith(fakeQuery(() => messages));
      const error: unknown = await agent.decide(input).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(OpponentOutageError);
      expect((error as OpponentOutageError).outageKind).toBe(kind);
    }
    expect(outageKindOf("billing_error")).toBe("usage_limit");
    expect(outageKindOf("oauth_org_not_allowed")).toBe("unauthenticated");
    expect(outageKindOf("server_error")).toBe("error");
    expect(outageKindOf(null)).toBe("error");
  });

  it("子プロセスの起動・SDK の失敗（例外）はそのまま障害として伝わる", async () => {
    const agent = new ClaudeOpponent({
      model: "test-model",
      env: {},
      query: () => {
        throw new Error("spawn claude ENOENT");
      },
    });
    const { input } = firstDecisionInput();
    await expect(agent.decide(input)).rejects.toThrow("spawn claude ENOENT");
  });

  it("構造化出力を作れなかった（ターン上限・Schema の再試行上限）は不正な出力として返し、検証で Schema 違反になる", async () => {
    const { input } = firstDecisionInput();
    for (const messages of [RECORDED.maxTurns, CONSTRUCTED.structuredRetries]) {
      const output = await agentWith(fakeQuery(() => messages)).decide(input);
      expect(checkOpponentOutput(output, input.legal)).toMatchObject({
        ok: false,
        stage: "schema",
      });
    }
  });

  it("呼び出し側の signal が abort されたら、SDK の abortController も abort する", async () => {
    let captured: AbortController | undefined;
    let release: () => void = () => undefined;
    const query: ClaudeQuery = ({ options }) => {
      captured = options.abortController;
      return (async function* () {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        yield* RECORDED.success as unknown as SDKMessage[];
      })();
    };
    const agent = new ClaudeOpponent({ model: "m", env: {}, query });
    const { input } = firstDecisionInput();
    const controller = new AbortController();
    const pending = agent.decide(input, controller.signal);
    await Promise.resolve();
    expect(captured?.signal.aborted).toBe(false);
    controller.abort();
    expect(captured?.signal.aborted).toBe(true);
    release();
    await pending;

    // 最初から abort 済みの signal なら、呼ぶ時点で abort 済みにする。
    const aborted = AbortSignal.abort();
    const fake = fakeQuery(() => RECORDED.success);
    await agentWith(fake).decide(input, aborted);
    expect(fake.calls[0]?.options.abortController?.signal.aborted).toBe(true);
  });
});

/** Tournament の Hand（4 人残り・標準 STT の Level 3）の最初の判断の入力（KnowledgeState に Tournament Context を持つ）。 */
function tournamentDecisionInput(): {
  input: OpponentInput;
  events: readonly HandEvent[];
} {
  const STANDARD = TOURNAMENT_PRESETS.stt6_hand_count;
  const result = startHand({
    handId: "t-1",
    seats: [
      { playerId: "p1", stack: 3_000 },
      { playerId: "p2", stack: 2_500 },
      { playerId: "p3", stack: 2_000 },
      { playerId: "p4", stack: 1_500 },
    ],
    buttonPlayerId: "p1",
    config: tableConfigForLevel(
      PHASE1_CASH_PRESET,
      STANDARD.levels[2]!,
      "big_blind_ante",
    ),
    deal: { seed: 3 },
    tournament: { level: 3, handNumber: 21, playTimeMs: 0 },
  });
  if (!result.ok) throw new Error(result.error.message);
  const legal = getLegalActions(result.value.state);
  if (legal === null) throw new Error("Actor がいない");
  return {
    input: {
      knowledge: projectKnowledgeState(result.value.events, legal.playerId, {
        tournament: { config: STANDARD, entrants: 6 },
      }),
      legal,
    },
    events: result.value.events,
  };
}

describe("Tournament の Prompt（#188）", () => {
  it("Tournament Context は Hand の情報の節に混ぜず、説明つきの節に丸めた構造化データで入れる。節を除けば Context の無い Prompt と同じ", () => {
    const { input, events } = tournamentDecisionInput();
    const { tournament, ...cashLike } = input.knowledge;
    expect(tournament).toBeDefined();
    const prompt = buildOpponentPrompt(input);
    const sections = prompt.split("\n\n");
    const at = sections.findIndex((s) => s.startsWith("## トーナメントの状況"));
    // この Hand の情報の節の直後に入れる。
    expect(sections[at - 2]).toMatch(/^## あなたに見えている情報/);
    expect(sections[at - 1]).not.toContain("bubbleFactors");
    const shown = JSON.parse(sections[at + 1] ?? "") as typeof tournament;
    const raw = tournamentKnowledgeOf(events, input.knowledge.viewerId, {
      config: TOURNAMENT_PRESETS.stt6_hand_count,
      entrants: 6,
    });
    // 丸めは表示だけ（BB 換算・Equity の pt と % は小数第 1 位、Bubble Factor は小数第 2 位）。ほかの項目は同じ。
    expect(shown).toEqual({
      ...raw,
      seats: raw.seats.map((s) => ({
        ...s,
        stackBb: Math.round(s.stackBb * 10) / 10,
        icmEquity: Math.round(s.icmEquity * 10) / 10,
        icmEquityPercent: Math.round(s.icmEquityPercent * 10) / 10,
      })),
      bubbleFactors: raw.bubbleFactors.map((b) => ({
        ...b,
        bubbleFactor:
          b.bubbleFactor === null
            ? null
            : Math.round(b.bubbleFactor * 100) / 100,
      })),
    });
    expect(shown?.stage).toBe("bubble");
    // 節を除けば、Tournament Context の無い KnowledgeState の Prompt と同じ文字列。
    expect(
      prompt.replace(sections[at] + "\n\n" + sections[at + 1] + "\n\n", ""),
    ).toBe(buildOpponentPrompt({ ...input, knowledge: cashLike }));
    // ICM を計算させない・Push/Fold の Range を渡さない。
    expect(sections[at]).toContain("自分で計算し直さず");
    expect(prompt).not.toMatch(/Push\/Fold|Nash/);
    // 同じ入力からは同じ Prompt（決定論）。
    expect(buildOpponentPrompt(input)).toBe(prompt);
  });

  it("System Prompt は Tournament の Hand だけトーナメントの卓にし、Cash は #188 より前と同じ", async () => {
    const cash = firstDecisionInput().input;
    const tournament = tournamentDecisionInput().input;
    expect(systemPromptOf(cash)).toMatch(/^.*（キャッシュゲーム）の卓/);
    expect(systemPromptOf(tournament)).toMatch(/^.*（トーナメント。/);
    // 1 行目以外は同じ。
    expect(systemPromptOf(tournament).split("\n").slice(1)).toEqual(
      systemPromptOf(cash).split("\n").slice(1),
    );
    const fake = fakeQuery(() => RECORDED.success);
    await agentWith(fake).decide(tournament);
    expect(fake.calls[0]?.options.systemPrompt).toBe(
      systemPromptOf(tournament),
    );
    expect(buildOpponentPrompt(cash)).not.toContain("トーナメント");
  });

  it("Persona の節を指す行は Persona の節があるときだけ。Tournament の Memory には Tournament の Hand だけの傾向だと書く", () => {
    const { input } = tournamentDecisionInput();
    expect(buildOpponentPrompt(input)).not.toContain("リスク許容度");
    expect(buildOpponentPrompt(input, "タイトで慎重")).toContain(
      "「リスク許容度」と「規律」の程度に合わせて",
    );
    const memory: OpponentMemorySummary = {
      policyVersion: "phase7_memory_v1",
      injectionVersion: "phase7_memory_injection_v1",
      context: "tournament",
      subjects: [],
    };
    const withMemory = buildOpponentPrompt({
      ...input,
      knowledge: { ...input.knowledge, memory },
    });
    const sections = withMemory.split("\n\n");
    const at = sections.findIndex((s) => s.startsWith("## あなたの記憶"));
    expect(sections[at]).toContain("トーナメントの Hand だけから数えた傾向");
    expect(JSON.parse(sections[at + 1] ?? "")).toEqual(memory);
    // Cash の Memory の節には足さない。
    const cashMemory = buildOpponentPrompt({
      ...firstDecisionInput().input,
      knowledge: {
        ...firstDecisionInput().input.knowledge,
        memory: { ...memory, context: "cash" },
      },
    });
    expect(cashMemory).not.toContain("トーナメント");
  });
});

describe("buildOpponentPrompt", () => {
  it("Persona は中身があるときだけ節ごと入れる。前回の不正の理由は再要求のときだけ入れる", () => {
    const { input } = firstDecisionInput();
    expect(buildOpponentPrompt(input)).not.toContain("あなたの性格");
    expect(buildOpponentPrompt(input, "  ")).not.toContain("あなたの性格");
    expect(buildOpponentPrompt(input, "タイトで慎重")).toContain(
      "## あなたの性格\nタイトで慎重",
    );
    expect(buildOpponentPrompt(input)).not.toContain("前回の答え");
    const retried = buildOpponentPrompt({
      ...input,
      correction: { stage: "amount_range", reason: "raise の額は 4〜200: 1" },
    });
    expect(retried).toContain("amount_range: raise の額は 4〜200: 1");
  });

  it("Memory（#139）は節ごと出し分ける: 無ければ #139 より前と同じ文字列、あれば説明つきの節に構造化データのまま入れる", () => {
    const { input } = firstDecisionInput();
    const prompt = buildOpponentPrompt(input);
    expect(prompt).not.toContain("あなたの記憶");
    // Memory の無い入力の Prompt は、KnowledgeState をそのまま JSON にした #139 より前の形と同じ（Opponent Eval の録画の引数を変えない）。
    expect(prompt).toContain(
      JSON.stringify(input.knowledge, (_k, v: unknown) =>
        typeof v === "object" && v !== null && "rank" in v && "suit" in v
          ? cardToString(v as Parameters<typeof cardToString>[0])
          : v,
      ),
    );
    const memory: OpponentMemorySummary = {
      policyVersion: "phase7_memory_v1",
      injectionVersion: "phase7_memory_injection_v1",
      context: "cash",
      subjects: [
        {
          playerId: "p2",
          subject: { kind: "cpu_profile", cpuProfileId: "fixed_ben" },
          handsObserved: 12,
          items: [
            {
              item: "vpip",
              frequency: 0.42,
              weightedOpportunities: 11.8,
              opportunities: 12,
              sufficient: false,
              evidenceCount: 5,
              evidenceIds: ["h1#7", "h2#9", "h3#8"],
            },
          ],
        },
      ],
    };
    const withMemory = buildOpponentPrompt({
      ...input,
      knowledge: { ...input.knowledge, memory },
    });
    const sections = withMemory.split("\n\n");
    const at = sections.findIndex((s) => s.startsWith("## あなたの記憶"));
    expect(at).toBeGreaterThan(0);
    // 構造化データのまま（自然言語へ書き換えない）入り、この Hand の情報の節には Memory を混ぜない。
    expect(JSON.parse(sections[at + 1] ?? "")).toEqual(memory);
    expect(sections[at - 1]).not.toContain("handsObserved");
    expect(
      withMemory.replace(sections[at] + "\n\n" + sections[at + 1] + "\n\n", ""),
    ).toBe(prompt);
    // Persona の節を指す行は、Persona の節があるときだけ入れる。
    expect(withMemory).not.toContain("相手への適応");
    const withPersona = buildOpponentPrompt(
      { ...input, knowledge: { ...input.knowledge, memory } },
      "タイトで慎重",
    );
    expect(withPersona).toContain(
      "「相手への適応」と「相手の読みの精度」の程度に合わせて",
    );
  });

  it("Tilt（#140）は 1 以上のときだけ節ごと入れる: 無ければ今と同じ文字列、あれば Hand の情報の節に混ぜず段階だけを書く", () => {
    const { input } = firstDecisionInput();
    const prompt = buildOpponentPrompt(input, "タイトで慎重");
    expect(prompt).not.toContain("Tilt");
    const tilt = { level: 2, maxLevel: 3, policyVersion: "phase7_tilt_v1" };
    const withTilt = buildOpponentPrompt(
      { ...input, knowledge: { ...input.knowledge, tilt } },
      "タイトで慎重",
    );
    const sections = withTilt.split("\n\n");
    const at = sections.findIndex((s) => s.startsWith("## あなたの今の状態"));
    expect(at).toBeGreaterThan(0);
    expect(sections[at]).toContain("Tilt: 2（0〜3。");
    // Tilt の節を除けば Tilt の無い Prompt と同じ（Hand の情報の JSON に tilt を混ぜない。Policy の Version も出さない）。
    expect(withTilt.replace(sections[at] + "\n\n", "")).toBe(prompt);
    expect(withTilt).not.toContain("phase7_tilt_v1");
    expect(withTilt).not.toContain('"tilt"');
  });

  it("Table Tendency（#141）はあるときだけ節ごと入れる: 無ければ今と同じ文字列、あれば Hand の情報の節に混ぜず構造化データのまま入れる", () => {
    const { input } = firstDecisionInput();
    const prompt = buildOpponentPrompt(input, "タイトで慎重");
    expect(prompt).not.toContain("卓の傾向");
    const tableTendency: TableTendency = {
      policyVersion: "phase7_table_tendency_v1",
      hands: 12,
      items: [
        {
          item: "vpip",
          policyVersion: "phase7_table_tendency_v1",
          numerator: 21,
          denominator: 55,
          hands: 12,
          sufficient: true,
        },
      ],
    };
    const withTendency = buildOpponentPrompt(
      { ...input, knowledge: { ...input.knowledge, tableTendency } },
      "タイトで慎重",
    );
    const sections = withTendency.split("\n\n");
    const at = sections.findIndex((s) => s.startsWith("## 卓の傾向"));
    expect(at).toBeGreaterThan(0);
    expect(JSON.parse(sections[at + 1] ?? "")).toEqual(tableTendency);
    // 節を除けば Table Tendency の無い Prompt と同じ（Hand の情報の JSON に混ぜない）。
    expect(
      withTendency.replace(
        sections[at] + "\n\n" + sections[at + 1] + "\n\n",
        "",
      ),
    ).toBe(prompt);
    expect(sections[at - 1]).not.toContain("tableTendency");
    // Persona の節を指す行は、Persona の節があるときだけ入れる。
    expect(sections[at]).toContain("「相手への適応」の程度に合わせて");
    expect(
      buildOpponentPrompt({
        ...input,
        knowledge: { ...input.knowledge, tableTendency },
      }),
    ).not.toContain("相手への適応");
  });

  it("選べる Action と bet / raise の額の範囲を書き、自分の札は表記で入れる", () => {
    const { input } = firstDecisionInput();
    const prompt = buildOpponentPrompt(input);
    for (const action of input.legal.actions) {
      expect(prompt).toContain(`- ${action.type}`);
      if (action.type === "raise" || action.type === "bet") {
        expect(prompt).toContain(`${action.min}〜${action.max}`);
      }
      // 額が決まっている call / all_in の行には「amount は付けない」を書く（#53。call に amount を付けて Retry になる回があった）。
      if (action.type === "call" || action.type === "all_in") {
        expect(prompt).toMatch(
          new RegExp(`- ${action.type}（[^\\n]*amount は付けない）`),
        );
      }
    }
    // Preflop なので Prompt の札は自分の 2 枚だけ（holeCards と自分の席の両方に出る）。
    const own = (input.knowledge.holeCards ?? []).map(cardToString);
    expect(own).toHaveLength(2);
    expect(new Set(cardsIn(prompt))).toEqual(new Set(own));
  });

  it("多数の Hand で、Prompt に入る Card はその時点でその CPU が知ってよい札だけ（INV-TEST-007）", async () => {
    for (let seed = 1; seed <= 20; seed++) {
      const store = new InMemoryEventStore();
      const handId = `hand-${seed}`;
      const prompts: { playerId: string; prompt: string; upto: number }[] = [];
      // Fake: Schema の enum から check → call → fold の順に選ぶ（Showdown まで進みやすい）。
      const fake = fakeQuery(({ prompt, options }) => {
        const playerId = /あなたの ID は (\S+?)。/.exec(prompt)?.[1] ?? "";
        prompts.push({
          playerId,
          prompt,
          upto: store.read(handId).length - 1,
        });
        const schema = options.outputFormat?.schema as {
          properties: { action: { enum: string[] } };
        };
        const choices = schema.properties.action.enum;
        const action =
          ["check", "call", "fold"].find((a) => choices.includes(a)) ?? "fold";
        return [
          {
            type: "result",
            subtype: "success",
            is_error: false,
            structured_output: { action },
          },
        ];
      });
      const orchestrator = new HandOrchestrator({
        store,
        setup: PHASE1_TABLE_SETUP,
        createOpponent: createClaudeOpponentFactory({
          model: "test-model",
          env: {},
          query: fake.query,
        }),
        botDelayMs: 0,
        opponentTimeoutMs: 1000,
        nextSeed: () => seed,
        nextHandId: () => handId,
      });
      const started = await orchestrator.startHand(null);
      if (!started.ok) throw new Error(started.error.message);
      let view: HeroView = started.value.view;
      while (view.status !== "complete") {
        const types = view.legalActions?.actions.map((a) => a.type) ?? [];
        const action: PlayerAction = types.includes("call")
          ? { type: "call" }
          : { type: "check" };
        const result = await orchestrator.heroAction(
          handId,
          view.log.at(-1)?.seq ?? -1,
          action,
        );
        if (!result.ok) throw new Error(result.error.message);
        view = result.value;
      }
      orchestrator.close();

      const log = store.read(handId).map((s) => s.event);
      expect(prompts.length).toBeGreaterThan(0);
      for (const { playerId, prompt, upto } of prompts) {
        expect(playerId).toMatch(/^cpu\d$/);
        const allowed = allowedCardsAt(log, playerId, upto);
        expect(cardsIn(prompt).filter((c) => !allowed.has(c))).toEqual([]);
        for (const word of ["deck", "seed", "DECK_SHUFFLED", "AI_ACTION"]) {
          expect(prompt).not.toContain(word);
        }
      }
    }
  });
});
