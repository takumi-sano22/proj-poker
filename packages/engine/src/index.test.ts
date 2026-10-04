import { describe, expect, it } from "vitest";
import { ENGINE_PACKAGE_NAME } from "./index.js";

// Phase 0 の動作確認用。Vitest が Engine を読み込んで実行できることだけを見る（ポーカーのロジックは Phase 1）。
describe("engine placeholder", () => {
  it("パッケージ名を公開している", () => {
    expect(ENGINE_PACKAGE_NAME).toBe("@proj-poker/engine");
  });
});
