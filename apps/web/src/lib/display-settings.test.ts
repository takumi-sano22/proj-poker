import { describe, expect, it } from "vitest";
import {
  BB_DISPLAY_KEY,
  DEFAULT_PRESENTATION_SPEED,
  PRESENTATION_SPEED_KEY,
  loadPresentationSpeed,
  loadShowBB,
  savePresentationSpeed,
  saveShowBB,
  type SettingsStorage,
} from "./display-settings.js";

/** 読み書きを記録するメモリ上の Storage。 */
function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  const storage: SettingsStorage = {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
  };
  return { storage, data };
}

/** 読み書きのどちらも例外を投げる Storage（保存の拒否・容量超過・プライベートウィンドウ）。 */
const throwingStorage: SettingsStorage = {
  getItem: () => {
    throw new Error("denied");
  },
  setItem: () => {
    throw new Error("denied");
  },
};

describe("BB 補助表示の設定（viewer ごとの保存。D49）", () => {
  it("保存が無ければ既定（BB 補助を出す）", () => {
    expect(loadShowBB(memoryStorage().storage)).toBe(true);
  });

  it("OFF にして保存した値を、次に読んだときに復元する", () => {
    const { storage, data } = memoryStorage();
    saveShowBB(false, storage);
    expect(data.get(BB_DISPLAY_KEY)).toBe("off");
    expect(loadShowBB(storage)).toBe(false);
    saveShowBB(true, storage);
    expect(loadShowBB(storage)).toBe(true);
  });

  it("知らない値は既定に戻す（壊れた保存で画面を崩さない）", () => {
    expect(
      loadShowBB(memoryStorage({ [BB_DISPLAY_KEY]: "maybe" }).storage),
    ).toBe(true);
  });

  it("Storage が使えない（無い・読み書きが例外）でも例外にせず、既定の表示で動く", () => {
    expect(loadShowBB(null)).toBe(true);
    expect(loadShowBB(throwingStorage)).toBe(true);
    expect(() => saveShowBB(false, null)).not.toThrow();
    expect(() => saveShowBB(false, throwingStorage)).not.toThrow();
  });

  it("引数を省くとグローバルの localStorage を使い、無い環境（Node）でも例外にしない", () => {
    expect(() => saveShowBB(true)).not.toThrow();
    expect(loadShowBB()).toBe(true);
  });
});

describe("表示演出の速度の保存（#222・D140 Q19）", () => {
  it("保存した速度を読み、無い・知らない値なら標準", () => {
    expect(loadPresentationSpeed(memoryStorage().storage)).toBe(
      DEFAULT_PRESENTATION_SPEED,
    );
    expect(DEFAULT_PRESENTATION_SPEED).toBe("standard");
    expect(
      loadPresentationSpeed(
        memoryStorage({ [PRESENTATION_SPEED_KEY]: "turbo" }).storage,
      ),
    ).toBe("turbo");
    expect(
      loadPresentationSpeed(
        memoryStorage({ [PRESENTATION_SPEED_KEY]: "warp" }).storage,
      ),
    ).toBe("standard");
  });

  it("切り替えた速度を保存し、保存・読み込みが拒否されても例外にしない", () => {
    const { storage, data } = memoryStorage();
    savePresentationSpeed("none", storage);
    expect(data.get(PRESENTATION_SPEED_KEY)).toBe("none");
    expect(() => savePresentationSpeed("fast", throwingStorage)).not.toThrow();
    expect(loadPresentationSpeed(throwingStorage)).toBe("standard");
    expect(loadPresentationSpeed(null)).toBe("standard");
  });
});
