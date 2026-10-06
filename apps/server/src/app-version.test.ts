import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { APP_VERSION, readAppVersion } from "./app-version.js";

const dirs: string[] = [];

/** 一時ディレクトリに package.json を書き、その URL を返す。 */
function packageJson(content: string): URL {
  const dir = mkdtempSync(join(tmpdir(), "proj-poker-version-"));
  dirs.push(dir);
  const path = join(dir, "package.json");
  writeFileSync(path, content);
  return pathToFileURL(path);
}

afterEach(() => {
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

describe("readAppVersion（#97）", () => {
  it("apps/server の package.json の version を読む（APP_VERSION も同じ値）", () => {
    expect(readAppVersion(packageJson('{"version":"1.2.3"}'))).toBe("1.2.3");
    expect(APP_VERSION).toBe(readAppVersion());
    expect(APP_VERSION).not.toBe("");
  });

  it("version が無い・空・文字列でなければ誤りとして止める（Metadata に黙って別の値を残さない）", () => {
    for (const content of ["{}", '{"version":""}', '{"version":1}']) {
      expect(() => readAppVersion(packageJson(content))).toThrow(
        /version が無い/,
      );
    }
  });
});
