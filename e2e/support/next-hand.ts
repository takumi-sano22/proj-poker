// 「次の Hand へ」を押して、画面が新しい Hand に切り替わるまで待つ（#133）。
// 押した直後は開始の応答待ちの間（Button は disabled）も前の Hand の「Hand が終了しました。」が出たままなので、続けて Hand の終わりを
// 画面の文言で判定すると、前の Hand の表示を見て即座に「終わった」と読み、もう一度「次の Hand へ」を押そうとして待ち続ける。
// そこで開始の応答（新しい Hand の handId）を受け取り、前の Hand の終了表示が消える（新しい Hand の画面になる）か、新しい Hand が
// Hero の手番なしに終わった（server の一覧で complete）まで待ってから返す。テストの手順だけの待ちで、プロダクトの挙動は変えない。
import { expect, type Page } from "@playwright/test";

/** Replay の一覧（進行中の Hand も含む）で、handId の Hand が終わったか。 */
async function handComplete(page: Page, handId: string): Promise<boolean> {
  const res = await page.request.get("/api/replay/hands");
  if (!res.ok()) return false;
  const { hands } = (await res.json()) as {
    hands: { handId: string; complete: boolean; aborted: boolean }[];
  };
  const hand = hands.find((h) => h.handId === handId);
  return hand !== undefined && (hand.complete || hand.aborted);
}

/** 「次の Hand へ」を押し、新しい Hand の handId を返す（画面が新しい Hand を映すまで待つ）。 */
export async function startNextHand(page: Page): Promise<string> {
  const dock = page.getByRole("region", { name: "Hero" });
  const done = dock.getByText(/Hand が終了しました。|Session が終了しました。/);
  const [res] = await Promise.all([
    page.waitForResponse(
      (r) =>
        r.request().method() === "POST" &&
        new URL(r.url()).pathname === "/api/hands",
    ),
    page.getByRole("button", { name: "次の Hand へ" }).click(),
  ]);
  expect(res.ok(), "次の Hand の開始").toBe(true);
  const { handId } = (await res.json()) as { handId: string };
  await expect
    .poll(
      async () =>
        !(await done.isVisible()) || (await handComplete(page, handId)),
      { timeout: 30_000, message: "画面が新しい Hand に切り替わる" },
    )
    .toBe(true);
  return handId;
}
