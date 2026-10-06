// 情報漏れ検査（INV-TEST-007 の Runtime 側）。API・SSE・CPU 入力の値を丸ごと走査し、
// 「その時点でその Player が知ってよい Card」以外が 1 枚でもあれば漏れとする（フィールド名に頼らない）。
import {
  cardToString,
  foldHandEvents,
  type Card,
  type HandEvent,
} from "@proj-poker/engine";
import { PERSONA_PRESETS, PERSONA_PRESET_IDS } from "../opponents/persona.js";

/** seq が uptoSeq 以下の Event だけで、viewer が知ってよい Card（自分の札・公開 Board・Showdown で公開された札）。 */
export function allowedCardsAt(
  events: readonly HandEvent[],
  viewerId: string,
  uptoSeq: number,
): Set<string> {
  const state = foldHandEvents(events.filter((e) => e.seq <= uptoSeq));
  const allowed = new Set(state.board.map(cardToString));
  for (const p of state.players) {
    if ((p.playerId === viewerId || p.shown) && p.holeCards !== null) {
      p.holeCards.forEach((c) => allowed.add(cardToString(c)));
    }
  }
  return allowed;
}

/** 値の中の Card（rank と suit を持つ object）を全部拾う。 */
export function collectCards(value: unknown, found: Card[] = []): Card[] {
  if (Array.isArray(value)) {
    value.forEach((v) => collectCards(v, found));
  } else if (typeof value === "object" && value !== null) {
    if ("rank" in value && "suit" in value) {
      found.push(value as Card);
    } else {
      Object.values(value).forEach((v) => collectCards(v, found));
    }
  }
  return found;
}

/** 漏れていた Card の表記（空なら漏れなし）。 */
export function leakedCards(
  payload: unknown,
  events: readonly HandEvent[],
  viewerId: string,
  uptoSeq: number,
): string[] {
  const allowed = allowedCardsAt(events, viewerId, uptoSeq);
  return collectCards(payload)
    .map(cardToString)
    .filter((c) => !allowed.has(c));
}

/**
 * Deck・seed・engine / system Visibility の Event（CPU の判断の経緯を含む）・CPU の Persona を指す語が
 * JSON に含まれていないか（Card 以外の経路の漏れ）。
 */
export function forbiddenKeys(payload: unknown): string[] {
  const json = JSON.stringify(payload);
  return [
    ...[
      '"deck"',
      '"seed"',
      "DECK_SHUFFLED",
      '"engine"',
      "AI_ACTION_INVALID",
      "AI_FALLBACK_USED",
      '"system"',
    ].filter((k) => json.includes(k)),
    ...personaTerms(payload),
  ];
}

/** CPU の Persona（Secret Persona。#51）を指す語（Preset の ID・名前・"persona"）が JSON に含まれていないか。 */
export function personaTerms(payload: unknown): string[] {
  const json = JSON.stringify(payload);
  return [
    "persona",
    "Persona",
    ...PERSONA_PRESET_IDS.map((id) => `"${id}"`),
    ...Object.values(PERSONA_PRESETS).map((p) => p.label),
  ].filter((k) => json.includes(k));
}
