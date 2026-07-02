import * as RDialog from "@radix-ui/react-dialog";
import { forwardRef, type ReactNode, type ElementRef } from "react";
import { IconButton } from "./Button";

const cx = (...c: (string | false | undefined)[]) => c.filter(Boolean).join(" ");

// Tailwind v4 (tokens mapeados no @theme; não-mapeados = arbitrary var(--...)).
// Keyframes ui-fade/ui-pop continuam no ui.css e são referenciados via animate-[...];
// animação só no estado open (Radix), idêntico ao CSS anterior (rodava no mount).

// `ui-overlay`/`ui-dialog` permanecem como HOOKS do e2e (app.spec.ts seleciona por elas);
// os estilos agora vêm das utilities — na purga do ui.css, os nomes viram marcadores puros.

// Scrim do overlay (ex-.ui-overlay): rgba(2,6,12,.6), z-100, fade 150ms.
export const OVERLAY_CLS =
  "ui-overlay fixed inset-0 z-[100] bg-[rgba(2,6,12,0.6)] data-[state=open]:animate-[ui-fade_0.15s_ease]";

// Casca do diálogo (ex-.ui-dialog): centrado via transform (NÃO translate-x/y do Tailwind —
// o keyframe ui-pop anima `transform`, e a propriedade `translate` separada dobraria o offset).
export const DIALOG_CONTENT_CLS = cx(
  "ui-dialog fixed top-1/2 left-1/2 [transform:translate(-50%,-50%)] z-[101]",
  "flex max-h-[85vh] flex-col overflow-hidden",
  "bg-panel border border-border rounded-md",
  "shadow-[0_24px_64px_rgba(0,0,0,0.55)]",
  "data-[state=open]:animate-[ui-pop_0.15s_ease]",
  "max-[640px]:w-[96vw]",
);

// Header (ex-.ui-dialog-head). Compartilhado com AlertDialog.
export const DIALOG_HEAD_CLS =
  "flex items-center justify-between p-[var(--sp-3)] border-b border-border";
// Footer do Dialog: mesmo padding do head, borda em cima, alinhado à direita (sem gap, como antes).
const FOOT_CLS = "flex items-center justify-end p-[var(--sp-3)] border-t border-border";
export const DIALOG_TITLE_CLS = "text-[14px] font-semibold text-text";
// "ui-dialog-body" é MARCADOR (sem regra em ui.css): alarms.css estiliza o corpo do
// drawer de alarmes via .ui-dialog:has(.alarm-drawer__list) .ui-dialog-body.
export const DIALOG_BODY_CLS = "ui-dialog-body p-[var(--sp-3)] overflow-auto";
// ex-.ui-hint + padding lateral que era inline style.
const DESC_CLS = "text-[11px] text-text-muted px-[var(--sp-3)]";

// Radix dismissa só a camada de cima no ESC, mas no pointerdown-fora o Dialog
// avaliaria o MESMO evento e fecharia junto com o Select/Menu aberto. Não dá pra
// consultar o DOM no onInteractOutside: o Radix já dismissou (removeu) o Select
// antes dele rodar. Então capturamos no pointerdown (fase de captura, ANTES do
// Radix) se havia uma camada sobreposta aberta naquele instante.
let layerOpenAtPointerDown = false;
if (typeof document !== "undefined") {
  document.addEventListener(
    "pointerdown",
    () => {
      layerOpenAtPointerDown = !!document.querySelector('[role="listbox"],[role="menu"]');
    },
    true,
  );
}

// Diálogo acessível (foco preso, ESC fecha, ARIA). `trigger` opcional (controlado por open/onOpenChange).
// `forwardRef` encaminha p/ o Content (DOM) para foco/medição programática.
export const Dialog = forwardRef<
  ElementRef<typeof RDialog.Content>,
  {
    open?: boolean;
    onOpenChange?: (o: boolean) => void;
    title: ReactNode;
    description?: ReactNode;
    children: ReactNode;
    trigger?: ReactNode;
    footer?: ReactNode;
  }
>(function Dialog({ open, onOpenChange, title, description, children, trigger, footer }, ref) {
  return (
    <RDialog.Root open={open} onOpenChange={onOpenChange}>
      {trigger && <RDialog.Trigger asChild>{trigger}</RDialog.Trigger>}
      <RDialog.Portal>
        <RDialog.Overlay className={OVERLAY_CLS} />
        <RDialog.Content
          ref={ref}
          className={cx(DIALOG_CONTENT_CLS, "w-[min(560px,92vw)]")}
          aria-describedby={description ? undefined : "ui-dialog-no-desc"}
          onInteractOutside={(e) => {
            if (layerOpenAtPointerDown) e.preventDefault();
          }}
        >
          <div className={DIALOG_HEAD_CLS}>
            <RDialog.Title className={DIALOG_TITLE_CLS}>{title}</RDialog.Title>
            <RDialog.Close asChild>
              <IconButton label="Fechar">✕</IconButton>
            </RDialog.Close>
          </div>
          {description && (
            <RDialog.Description className={DESC_CLS}>{description}</RDialog.Description>
          )}
          <div className={DIALOG_BODY_CLS}>{children}</div>
          {footer && <div className={FOOT_CLS}>{footer}</div>}
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
});
