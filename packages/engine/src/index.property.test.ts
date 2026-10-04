import fc from "fast-check";
import { describe, it } from "vitest";
import { ENGINE_PACKAGE_NAME } from "./index.js";

// Phase 0 の動作確認用。fast-check のプロパティテストが動くことだけを見る。
// Chip 総量保存などの Invariant は Phase 1 で Engine と一緒に足す（docs/09 §3）。
describe("engine placeholder (property)", () => {
  it("任意の接頭辞を付けても元のパッケージ名を含む", () => {
    fc.assert(
      fc.property(fc.string(), (prefix) => {
        return (prefix + ENGINE_PACKAGE_NAME).endsWith(ENGINE_PACKAGE_NAME);
      }),
    );
  });
});
