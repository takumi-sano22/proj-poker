// Poker Vocabulary の詳細表示（docs/06 §7）。卓の上の用語（Term）を Hover（マウス）・Click / タップ・キーボード（Enter / Space）で開くと、
// Definition・Current Hand Example・Related Concept・Advanced Detail を出す。
// 詳細の面は 1 つだけを body 直下に出す（卓の overflow や transform に切られず、どの席の用語からでも同じ位置計算で出せる）。
import type { HeroView } from "@proj-poker/engine";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { termLabel } from "../lib/format.js";
import { VOCABULARY, type VocabId } from "../lib/vocabulary.js";
import { useShowBB } from "./BbDisplay.js";

/** Hover で開くまでの待ち（流し見で明滅させない）と、離れてから閉じるまでの猶予（用語から詳細の面へ移る間）。 */
const HOVER_OPEN_MS = 250;
const HOVER_CLOSE_MS = 200;
/** 詳細の面と用語との間隔と、画面端に残す余白（px。狭い画面の左右の余白 16px に揃える）。 */
const GAP = 8;
const EDGE = 16;

interface OpenState {
  readonly id: VocabId;
  readonly anchor: HTMLElement;
  /** 開いた用語の印（Term ごとの useId）。aria-expanded を付ける用語を決める。 */
  readonly anchorKey: string;
  /** Click / キーボードで開いた（閉じる操作まで残す）。false は Hover で開いた（離れたら閉じる）。 */
  readonly pinned: boolean;
  /** キーボードで開いた（詳細の面へ focus を移し、閉じたら用語へ戻す）。 */
  readonly viaKeyboard: boolean;
}

interface VocabularyApi {
  /** 詳細を開いている用語の印（無ければ null）。 */
  readonly openKey: string | null;
  readonly hoverStart: (id: VocabId, anchor: HTMLElement, key: string) => void;
  readonly hoverEnd: () => void;
  readonly toggle: (
    id: VocabId,
    anchor: HTMLElement,
    key: string,
    viaKeyboard: boolean,
  ) => void;
}

const VocabularyCtx = createContext<VocabularyApi | null>(null);

interface ProviderProps {
  readonly view: HeroView;
  readonly nameOf: (playerId: string) => string;
  readonly children: ReactNode;
}

export function VocabularyProvider({ view, nameOf, children }: ProviderProps) {
  const [open, setOpen] = useState<OpenState | null>(null);
  const openTimer = useRef<number | undefined>(undefined);
  const closeTimer = useRef<number | undefined>(undefined);

  const clearTimers = useCallback(() => {
    window.clearTimeout(openTimer.current);
    window.clearTimeout(closeTimer.current);
  }, []);

  useEffect(() => clearTimers, [clearTimers]);

  const close = useCallback(() => {
    clearTimers();
    // キーボードで開いた詳細を閉じたら、開いた用語へ focus を戻す（focus の行き場を失わせない）。
    if (open?.viaKeyboard && open.anchor.isConnected) open.anchor.focus();
    setOpen(null);
  }, [clearTimers, open]);

  const hoverStart = useCallback(
    (id: VocabId, anchor: HTMLElement, anchorKey: string) => {
      window.clearTimeout(closeTimer.current);
      window.clearTimeout(openTimer.current);
      openTimer.current = window.setTimeout(() => {
        // Click で開いている詳細は Hover で置き換えない。
        setOpen((current) =>
          current?.pinned
            ? current
            : { id, anchor, anchorKey, pinned: false, viaKeyboard: false },
        );
      }, HOVER_OPEN_MS);
    },
    [],
  );

  const hoverEnd = useCallback(() => {
    window.clearTimeout(openTimer.current);
    window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => {
      setOpen((current) => (current?.pinned ? current : null));
    }, HOVER_CLOSE_MS);
  }, []);

  const toggle = useCallback(
    (
      id: VocabId,
      anchor: HTMLElement,
      anchorKey: string,
      viaKeyboard: boolean,
    ) => {
      clearTimers();
      setOpen((current) =>
        current?.pinned && current.anchorKey === anchorKey
          ? null
          : { id, anchor, anchorKey, pinned: true, viaKeyboard },
      );
    },
    [clearTimers],
  );

  const api = useMemo<VocabularyApi>(
    () => ({
      openKey: open?.anchorKey ?? null,
      hoverStart,
      hoverEnd,
      toggle,
    }),
    [open, hoverStart, hoverEnd, toggle],
  );

  return (
    <VocabularyCtx.Provider value={api}>
      {children}
      {open !== null && (
        <TermPopover
          state={open}
          view={view}
          nameOf={nameOf}
          onClose={close}
          onSelect={(id) =>
            setOpen((current) =>
              current === null ? null : { ...current, id, pinned: true },
            )
          }
          onPointerEnter={() => window.clearTimeout(closeTimer.current)}
          onPointerLeave={hoverEnd}
        />
      )}
    </VocabularyCtx.Provider>
  );
}

interface TermProps {
  readonly id: VocabId;
  /** 見える表記（既定は「日本語（標準 Term）」）。記号だけの表記（Dealer Button の D など）でも、読み上げは用語の名前にする。 */
  readonly children?: ReactNode;
  readonly className?: string;
}

/** 卓の上の用語。押すと詳細を開く button（Provider の外では詳細を開かない表記だけになる）。 */
export function Term({ id, children, className }: TermProps) {
  const api = useContext(VocabularyCtx);
  const key = useId();
  const entry = VOCABULARY[id];
  const label = termLabel(entry);
  const expanded = api !== null && api.openKey === key;

  const onPointerEnter = (e: ReactPointerEvent<HTMLButtonElement>) => {
    // Hover はマウスだけ（タッチには Hover が無く、タップは Click として開く）。
    if (e.pointerType === "mouse") api?.hoverStart(id, e.currentTarget, key);
  };
  const onPointerLeave = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (e.pointerType === "mouse") api?.hoverEnd();
  };

  return (
    <button
      type="button"
      className={`term${className === undefined ? "" : ` ${className}`}`}
      data-term={id}
      aria-haspopup="dialog"
      aria-expanded={expanded}
      aria-label={children === undefined ? undefined : label}
      title={children === undefined ? undefined : label}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onClick={(e) =>
        // detail が 0 の click はキーボード（Enter / Space）で押されたもの。
        api?.toggle(id, e.currentTarget, key, e.detail === 0)
      }
    >
      {children ?? label}
    </button>
  );
}

interface PopoverProps {
  readonly state: OpenState;
  readonly view: HeroView;
  readonly nameOf: (playerId: string) => string;
  readonly onClose: () => void;
  readonly onSelect: (id: VocabId) => void;
  readonly onPointerEnter: () => void;
  readonly onPointerLeave: () => void;
}

function TermPopover({
  state,
  view,
  nameOf,
  onClose,
  onSelect,
  onPointerEnter,
  onPointerLeave,
}: PopoverProps) {
  const entry = VOCABULARY[state.id];
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{
    top: number;
    left: number;
  } | null>(null);

  // 用語の位置から、画面内に収まる位置を測る（下に出せなければ上。左右は画面端で止める）。
  useLayoutEffect(() => {
    const place = () => {
      const panel = ref.current;
      if (panel === null) return;
      const a = state.anchor.getBoundingClientRect();
      const width = panel.offsetWidth;
      const height = panel.offsetHeight;
      const vw = document.documentElement.clientWidth;
      const vh = window.innerHeight;
      const left = Math.min(
        Math.max(EDGE, a.left + a.width / 2 - width / 2),
        Math.max(EDGE, vw - width - EDGE),
      );
      const below = a.bottom + GAP;
      const above = a.top - GAP - height;
      const top =
        below + height <= vh - GAP || above < GAP
          ? Math.min(below, Math.max(GAP, vh - height - GAP))
          : above;
      setPosition({ top, left });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [state.anchor, state.id]);

  // キーボードで開いたら詳細の面へ focus を移す（body 直下にあるので、Tab だけでは届かないため）。
  // 関連の用語を選んだときも、押した button が描き直しで消えるので面へ focus を移す。
  // 位置を測るまでは visibility: hidden で focus できないので、位置が決まってから移す。
  const selected = useRef(false);
  const placed = position !== null;
  useEffect(() => {
    if (!placed) return;
    if (state.viaKeyboard || selected.current) ref.current?.focus();
    selected.current = false;
  }, [state.viaKeyboard, state.id, placed]);

  // 開いた用語が描き直しで消えたら（裁定が変わって Hero 欄の用語が入れ替わったなど）、置き場が無いので閉じる。
  useEffect(() => {
    if (!state.anchor.isConnected) onClose();
  });

  // Escape で閉じる。Click で開いた詳細は、面と用語の外を押したら閉じる。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (
        target !== null &&
        !ref.current?.contains(target) &&
        !state.anchor.contains(target)
      ) {
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [onClose, state.anchor]);

  return createPortal(
    <div
      ref={ref}
      className="vocab"
      role="dialog"
      aria-labelledby={titleId}
      tabIndex={-1}
      data-vocab={entry.id}
      style={
        position === null
          ? { visibility: "hidden", top: 0, left: 0 }
          : { top: position.top, left: position.left }
      }
      onPointerEnter={onPointerEnter}
      onPointerLeave={(e) => {
        if (e.pointerType === "mouse") onPointerLeave();
      }}
    >
      <div className="vocab__head">
        <h2 id={titleId} className="vocab__title">
          {entry.ja}
          <span className="vocab__term">{entry.term}</span>
        </h2>
        <button
          type="button"
          className="vocab__close"
          aria-label="用語の説明を閉じる"
          onClick={onClose}
        >
          ×
        </button>
      </div>
      <VocabBody
        id={state.id}
        view={view}
        nameOf={nameOf}
        onSelect={(id) => {
          selected.current = true;
          onSelect(id);
        }}
      />
    </div>,
    document.body,
  );
}

interface BodyProps {
  readonly id: VocabId;
  readonly view: HeroView;
  readonly nameOf: (playerId: string) => string;
  readonly onSelect: (id: VocabId) => void;
}

/** 詳細の中身（4 項目）。静的な描画のテストでも使えるよう、位置・focus の制御から分けている。 */
export function VocabBody({ id, view, nameOf, onSelect }: BodyProps) {
  const showBB = useShowBB();
  const entry = VOCABULARY[id];
  return (
    <dl className="vocab__body">
      <dt>意味（Definition）</dt>
      <dd>{entry.definition}</dd>
      <dt>この Hand では（Current Hand Example）</dt>
      <dd>{entry.example({ view, nameOf, showBB })}</dd>
      <dt>関連（Related Concept）</dt>
      <dd>
        <ul className="vocab__related">
          {entry.related.map((r) => (
            <li key={r}>
              <button
                type="button"
                className="vocab__link"
                onClick={() => onSelect(r)}
              >
                {termLabel(VOCABULARY[r])}
              </button>
            </li>
          ))}
        </ul>
      </dd>
      <dt>詳しく（Advanced Detail）</dt>
      <dd>{entry.advanced}</dd>
    </dl>
  );
}
