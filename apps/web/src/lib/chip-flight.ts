// Stack → 手元 → Betting Area の Chip の移動の演出（UX-05 #220・D138）。表示層だけで完結させ、下書き（TurnDraft）の変更・送信の
// 時点を遅らせない（呼ぶ側は先に下書きを変え、演出は並行して流すだけ）。演出の要素は pointer-events を持たず、Click / Drag の
// 判定（elementFromPoint・Betting Area の矩形）にも関わらない。所要時間は styles.css の --duration-chip で、演出なし・
// prefers-reduced-motion では 0 になり、要素を作らない（動きだけを省き、操作の結果は同じ。D140）。

/** 飛ばす Chip の見た目（額面の色の class 名と、面に書く額）。 */
export interface FlightChip {
  readonly color: string;
  readonly label: string;
}

/** CSS の時間（"260ms" / "0.26s"）をミリ秒に読む。読めなければ 0（演出しない）。 */
export function parseDurationMs(value: string): number {
  const v = value.trim();
  const n = Number.parseFloat(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return v.endsWith("ms") ? n : v.endsWith("s") ? n * 1000 : 0;
}

/**
 * from の中心から to の中心へ Chip を 1 枚飛ばす。from / to が無い・所要時間が 0・Web Animations が使えない環境では何もしない。
 * 要素は document.body に一時的に足し、終わったら（取り消されても）外す。
 */
export function flyChip(
  from: Element | null,
  to: Element | null,
  chip: FlightChip,
): void {
  if (from === null || to === null) return;
  const duration = parseDurationMs(
    getComputedStyle(from).getPropertyValue("--duration-chip"),
  );
  if (duration === 0) return;
  const a = from.getBoundingClientRect();
  const b = to.getBoundingClientRect();
  const node = document.createElement("span");
  node.className = `chip-flight chip-token chip--${chip.color}`;
  node.setAttribute("aria-hidden", "true");
  node.textContent = chip.label;
  node.style.left = `${a.left + a.width / 2}px`;
  node.style.top = `${a.top + a.height / 2}px`;
  if (typeof node.animate !== "function") return;
  document.body.appendChild(node);
  const dx = b.left + b.width / 2 - (a.left + a.width / 2);
  const dy = b.top + b.height / 2 - (a.top + a.height / 2);
  const animation = node.animate(
    [
      { transform: "translate(-50%, -50%) scale(1)", opacity: 1 },
      {
        transform: `translate(calc(${dx}px - 50%), calc(${dy}px - 50%)) scale(0.55)`,
        opacity: 0.4,
      },
    ],
    { duration, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" },
  );
  const remove = () => node.remove();
  animation.onfinish = remove;
  animation.oncancel = remove;
}
