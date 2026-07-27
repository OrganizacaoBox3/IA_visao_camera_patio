// Trap de FOCO manual da casca fullscreen da câmera (ADR-007: a casca NÃO vira Radix Dialog —
// Portal/scroll-lock remontaria o <canvas> e mataria o rAF/editor de zonas). ESC fecha; Tab
// circula entre os focáveis; com QUALQUER camada modal do Radix aberta, ESC/Tab são deferidos
// a ela (é o Radix que traça o círculo de foco enquanto ela existe).
import { useEffect, type RefObject } from "react";

// ── "Existe camada modal do Radix aberta AGORA?" ─────────────────────────────────────────────
// POR QUE NÃO BASTA UM REF: o `cfgOpenRef` só conhece os diálogos que a PRÓPRIA câmera abre. Um
// modal aberto por OUTRA parte do app sobre a câmera em tela cheia — hoje o drawer de alarmes,
// que abre SOZINHO ao chegar alarme crítico — não passava por ele: o ESC funcionava (o Radix
// dismissa no capture e marca defaultPrevented, ver abaixo), mas o TAB era puxado de volta para a
// casca e o drawer ficava navegável só a mouse. Um alarme crítico exigindo mouse é falha de
// acessibilidade num caminho de segurança. E somar mais um ref por camada nova é uma corrida que
// se perde sempre: a próxima camada nasce sem ninguém lembrar de registrá-la.
//
// O SINAL: @radix-ui/react-focus-guards mantém DOIS <span data-radix-focus-guard> nas pontas do
// <body> enquanto houver ≥1 camada modal montada (contador global do pacote; Dialog, AlertDialog,
// Select, DropdownMenu e Popover modal chamam useFocusGuards) e os remove quando o contador zera.
// Presença ⟺ alguém está trapando foco — é a MESMA contabilidade que o Radix usa para si, não uma
// heurística nossa. Preferido ao seletor por classe da casa (`.ui-dialog, [role="listbox"],
// [role="menu"]`, usado no ESC do usePolygonEditorCore): `ui-dialog` é MARCADOR de e2e/CSS, com
// prazo declarado ("enquanto o ui.css viver"), e amarrar a a11y do trap a um nome de classe faz
// a camada nova que esquecer a classe voltar a prender o Tab — em silêncio.
//
// NÃO substitui o `cfgOpenRef`: o popover "Exibição" é NÃO-MODAL por construção (src/ui/Popover.tsx
// — sem RemoveScroll para não remontar o <canvas>), logo não instala guardas. Os dois sinais são
// complementares, e é por isso que a checagem é um OU.
const radixModalOpen = (): boolean => !!document.querySelector("[data-radix-focus-guard]");

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
      // Camada modal aberta (a da câmera OU a de qualquer outro dono) → Radix trata ESC/Tab.
      if (cfgOpenRef.current || radixModalOpen()) return;
      if (e.key === "Escape") {
        // Nem o ref NEM as guardas bastam para o ESC que FECHA a camada: o Radix (DismissableLayer)
        // dismissa no CAPTURE do document, e o React 19 flusha o setState discreto + passive
        // effects num microtask ENTRE os listeners do MESMO keydown (evento trusted) — quando
        // este bubble roda, o cfgOpenRef já virou false, o Dialog já saiu do DOM e as guardas já
        // foram removidas pelo cleanup do efeito. A marca síncrona e por-evento é o próprio
        // evento: toda camada Radix que dismissa por ESC chama event.preventDefault() antes
        // (dismissable-layer). ESC já consumido → ignora. (O Tab não tem essa corrida: ele não
        // desmonta camada nenhuma, então a checagem acima decide sozinha.)
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
