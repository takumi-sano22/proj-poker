// Chip の Drag（D44: Click と Drag の両方）。Pointer Events で書く（HTML の Drag and Drop はタッチで動かないため、
// 375px のモバイルでも同じ操作にする）。Drag しなかった押下は通常の Click として扱い、Click だけでも操作が完結する。
// 落とした先が Betting Area かは、離した位置と Betting Area の矩形で判定する（離した瞬間の位置で読む）。
import {
  useCallback,
  useRef,
  useState,
  type MouseEvent,
  type PointerEvent,
  type RefObject,
} from "react";

/** 押してからこの距離（px）を超えて動いたら Drag とみなす（それ未満は Click）。 */
const DRAG_THRESHOLD_PX = 6;

/** Drag 中の表示（指・カーソルに付いてくる Chip）と、Betting Area の上にいるか。 */
export interface DragState<S> {
  readonly source: S;
  readonly x: number;
  readonly y: number;
  readonly overTarget: boolean;
}

/** Drag の元の要素に付ける handler。 */
export interface DragHandlers {
  readonly onPointerDown: (e: PointerEvent<HTMLElement>) => void;
  readonly onPointerMove: (e: PointerEvent<HTMLElement>) => void;
  readonly onPointerUp: (e: PointerEvent<HTMLElement>) => void;
  readonly onPointerCancel: () => void;
  readonly onClickCapture: (e: MouseEvent<HTMLElement>) => void;
}

interface Pressed<S> {
  readonly source: S;
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  moved: boolean;
}

function isInside(target: HTMLElement | null, x: number, y: number): boolean {
  if (target === null) return false;
  const r = target.getBoundingClientRect();
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}

export function useChipDrag<S>(
  target: RefObject<HTMLElement | null>,
  onDrop: (source: S) => void,
  disabled: boolean,
): {
  readonly drag: DragState<S> | null;
  readonly bind: (source: S) => DragHandlers;
} {
  const [drag, setDrag] = useState<DragState<S> | null>(null);
  const pressed = useRef<Pressed<S> | null>(null);
  // Drag で終えた押下の直後に来る click を 1 回だけ捨てる（Drag と Click の両方の操作にしない）。
  const suppressClick = useRef(false);

  const reset = useCallback(() => {
    pressed.current = null;
    setDrag(null);
  }, []);

  const bind = useCallback(
    (source: S): DragHandlers => ({
      onPointerDown: (e) => {
        if (disabled || e.button !== 0) return;
        suppressClick.current = false;
        pressed.current = {
          source,
          pointerId: e.pointerId,
          startX: e.clientX,
          startY: e.clientY,
          moved: false,
        };
        // 要素の外へ動いても move / up を受け取る。
        e.currentTarget.setPointerCapture(e.pointerId);
      },
      onPointerMove: (e) => {
        const p = pressed.current;
        if (p === null || p.pointerId !== e.pointerId) return;
        if (!p.moved) {
          const dx = e.clientX - p.startX;
          const dy = e.clientY - p.startY;
          if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
          p.moved = true;
        }
        setDrag({
          source: p.source,
          x: e.clientX,
          y: e.clientY,
          overTarget: isInside(target.current, e.clientX, e.clientY),
        });
      },
      onPointerUp: (e) => {
        const p = pressed.current;
        if (p === null || p.pointerId !== e.pointerId) return;
        if (p.moved) {
          // マウスでは同じ押下の click がこの直後に来る。タッチでは来ないことがあるので、次の操作まで持ち越さず消す。
          suppressClick.current = true;
          setTimeout(() => {
            suppressClick.current = false;
          }, 0);
          if (isInside(target.current, e.clientX, e.clientY)) {
            // 落とした結果の描画（元の要素が押せなくなる等）は、この押下の一連のイベント（touchend）を配り終えてから行う。
            // 途中で元の要素が変わると、タッチでは次のタップが Click にならないことがある（Chromium で実測）。
            const source = p.source;
            setTimeout(() => onDrop(source), 0);
          }
        }
        reset();
      },
      onPointerCancel: reset,
      onClickCapture: (e) => {
        if (!suppressClick.current) return;
        suppressClick.current = false;
        e.preventDefault();
        e.stopPropagation();
      },
    }),
    [disabled, onDrop, reset, target],
  );

  return { drag, bind };
}
