// Trap de FOCO manual da casca fullscreen da câmera (ADR-007: a casca NÃO vira Radix Dialog —
// Portal/scroll-lock remontaria o <canvas> e mataria o rAF/editor de zonas). ESC fecha; Tab
// circula entre os focáveis; com o diálogo de config (Radix) aberto, ESC/Tab são deferidos a ele.
import { useEffect, type RefObject } from "react";

export function useFocusTrap(
  active: boolean,
  rootRef: RefObject<HTMLElement | null>,
  cfgOpenRef: RefObject<boolean>,
  onCloseRef: RefObject<(() => void) | undefined>,
): void {
  useEffect(() => {
    if (!active) return;
    const root = rootRef.current;
    if (!root) return;
    const prevFocus = document.activeElement as HTMLElement | null;
    const focusables = (): HTMLElement[] =>
      Array.from(
        root.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ),
      ).filter(
        (el) =>
          !el.hasAttribute("disabled") &&
          el.tabIndex !== -1 &&
          (el.offsetWidth > 0 || el.offsetHeight > 0 || el === document.activeElement),
      );
    const onKey = (e: KeyboardEvent) => {
      if (cfgOpenRef.current) return; // diálogo aberto → Radix trata ESC/Tab
      if (e.key === "Escape") {
        // cfgOpenRef NÃO basta para o ESC que fecha o diálogo: o Radix (DismissableLayer)
        // dismissa no CAPTURE do document, e o React 19 flusha o setState discreto + passive
        // effects num microtask ENTRE os listeners do MESMO keydown (evento trusted) — quando
        // este bubble roda, cfgOpenRef já virou false e o Dialog já saiu do DOM. A marca
        // síncrona e por-evento é o próprio evento: toda camada Radix que dismissa por ESC
        // chama event.preventDefault() antes (dismissable-layer). ESC já consumido → ignora.
        if (e.defaultPrevented) return;
        e.preventDefault();
        onCloseRef.current?.();
        return;
      }
      if (e.key !== "Tab") return;
      const list = focusables();
      if (!list.length) {
        e.preventDefault();
        root.focus();
        return;
      }
      const first = list[0],
        last = list[list.length - 1],
        active2 = document.activeElement as HTMLElement | null;
      if (e.shiftKey && (active2 === first || !root.contains(active2))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active2 === last || !root.contains(active2))) {
        e.preventDefault();
        first.focus();
      }
    };
    root.focus({ preventScroll: true });
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      prevFocus?.focus?.();
    };
  }, [active, rootRef, cfgOpenRef, onCloseRef]);
}
