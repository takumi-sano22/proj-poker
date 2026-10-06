// Local KB の入口（#80）。起動時に loadKb で読み、以降は searchKb で検索する。
export {
  DEFAULT_KB_DIR,
  KbValidationError,
  loadKb,
  parseKbEntry,
} from "./load.js";
export type { KbManifest, LoadedKb } from "./load.js";
export { getKbEntry, searchKb } from "./search.js";
export { KB_TOPICS, kbEvidenceId } from "./types.js";
export type {
  KbEntry,
  KbHit,
  KbQuery,
  KbRef,
  KbSearchResult,
  KbSpot,
  KbSpotKind,
  KbTopic,
} from "./types.js";
