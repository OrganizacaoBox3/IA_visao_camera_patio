import * as RDialog from "@radix-ui/react-dialog";
import { forwardRef, type ReactNode, type ElementRef } from "react";
import { IconButton } from "./Button";

// Diálogo acessível (foco preso, ESC fecha, ARIA). `trigger` opcional (controlado por open/onOpenChange).
// `forwardRef` encaminha p/ o Content (DOM) para foco/medição programática.
export const Dialog = forwardRef<ElementRef<typeof RDialog.Content>, {
  open?: boolean; onOpenChange?: (o: boolean) => void; title: ReactNode; description?: ReactNode;
  children: ReactNode; trigger?: ReactNode; footer?: ReactNode;
}>(function Dialog({ open, onOpenChange, title, description, children, trigger, footer }, ref) {
  return (
    <RDialog.Root open={open} onOpenChange={onOpenChange}>
      {trigger && <RDialog.Trigger asChild>{trigger}</RDialog.Trigger>}
      <RDialog.Portal>
        <RDialog.Overlay className="ui-overlay" />
        <RDialog.Content ref={ref} className="ui-dialog" aria-describedby={description ? undefined : "ui-dialog-no-desc"}>
          <div className="ui-dialog-head">
            <RDialog.Title className="ui-dialog-title">{title}</RDialog.Title>
            <RDialog.Close asChild><IconButton label="Fechar">✕</IconButton></RDialog.Close>
          </div>
          {description && <RDialog.Description className="ui-hint" style={{ padding: "0 var(--sp-3)" }}>{description}</RDialog.Description>}
          <div className="ui-dialog-body">{children}</div>
          {footer && <div className="ui-dialog-head" style={{ borderTop: "1px solid var(--border)", borderBottom: "none", justifyContent: "flex-end" }}>{footer}</div>}
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
});
