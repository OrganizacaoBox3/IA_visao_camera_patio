import * as RDialog from "@radix-ui/react-dialog";
import { forwardRef, type ReactNode, type ElementRef } from "react";
import { IconButton } from "./Button";

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
        <RDialog.Overlay className="ui-overlay" />
        <RDialog.Content
          ref={ref}
          className="ui-dialog"
          aria-describedby={description ? undefined : "ui-dialog-no-desc"}
          onInteractOutside={(e) => {
            if (layerOpenAtPointerDown) e.preventDefault();
          }}
        >
          <div className="ui-dialog-head">
            <RDialog.Title className="ui-dialog-title">{title}</RDialog.Title>
            <RDialog.Close asChild>
              <IconButton label="Fechar">✕</IconButton>
            </RDialog.Close>
          </div>
          {description && (
            <RDialog.Description className="ui-hint" style={{ padding: "0 var(--sp-3)" }}>
              {description}
            </RDialog.Description>
          )}
          <div className="ui-dialog-body">{children}</div>
          {footer && (
            <div
              className="ui-dialog-head"
              style={{
                borderTop: "1px solid var(--border)",
                borderBottom: "none",
                justifyContent: "flex-end",
              }}
            >
              {footer}
            </div>
          )}
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
});
