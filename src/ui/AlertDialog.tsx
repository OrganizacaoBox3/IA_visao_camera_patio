import * as RAlert from "@radix-ui/react-alert-dialog";
import { forwardRef, createContext, useCallback, useContext, useRef, useState, type ReactNode, type ComponentPropsWithoutRef, type ElementRef } from "react";
import { Button } from "./Button";

const cx = (...c: (string | false | undefined)[]) => c.filter(Boolean).join(" ");

// ── Compound (baixo nível) — Radix faz foco preso, ESC, scroll-lock e ARIA alertdialog ──
const Root = RAlert.Root;

const Trigger = forwardRef<ElementRef<typeof RAlert.Trigger>, ComponentPropsWithoutRef<typeof RAlert.Trigger>>(
  function ADTrigger(props, ref) {
    return <RAlert.Trigger ref={ref} {...props} />;
  }
);

const Content = forwardRef<ElementRef<typeof RAlert.Content>, ComponentPropsWithoutRef<typeof RAlert.Content>>(
  function ADContent({ className, children, ...rest }, ref) {
    return (
      <RAlert.Portal>
        <RAlert.Overlay className="ui-overlay" />
        <RAlert.Content ref={ref} className={cx("ui-dialog", "ui-alertdialog", className)} {...rest}>
          {children}
        </RAlert.Content>
      </RAlert.Portal>
    );
  }
);

const Title = forwardRef<ElementRef<typeof RAlert.Title>, ComponentPropsWithoutRef<typeof RAlert.Title>>(
  function ADTitle({ className, ...rest }, ref) {
    return <RAlert.Title ref={ref} className={cx("ui-dialog-title", className)} {...rest} />;
  }
);

const Description = forwardRef<ElementRef<typeof RAlert.Description>, ComponentPropsWithoutRef<typeof RAlert.Description>>(
  function ADDescription({ className, ...rest }, ref) {
    return <RAlert.Description ref={ref} className={cx("ui-hint", className)} {...rest} />;
  }
);

const Cancel = RAlert.Cancel;
const Action = RAlert.Action;

export type AlertDialogVariant = "danger" | "default";

type AlertDialogProps = {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  confirmLabel?: ReactNode;
  cancelLabel?: ReactNode;
  onConfirm?: () => void;
  onCancel?: () => void;
  /** "danger" usa botão vermelho (default p/ destruição). */
  variant?: AlertDialogVariant;
  /** Gatilho opcional (recebe asChild). Omita p/ uso totalmente controlado. */
  trigger?: ReactNode;
  /** Desabilita o botão de confirmação (ex.: durante request). */
  busy?: boolean;
};

// ── Alto nível — confirmação destrutiva controlada ("tem certeza?") ──
function AlertDialogComponent({
  open, onOpenChange, title, description,
  confirmLabel = "Confirmar", cancelLabel = "Cancelar",
  onConfirm, onCancel, variant = "danger", trigger, busy,
}: AlertDialogProps) {
  return (
    <Root open={open} onOpenChange={onOpenChange}>
      {trigger && <Trigger asChild>{trigger}</Trigger>}
      <Content>
        <div className="ui-dialog-head">
          <Title>{title}</Title>
        </div>
        {description && <div className="ui-dialog-body"><Description>{description}</Description></div>}
        <div className="ui-dialog-foot">
          <RAlert.Cancel asChild>
            <Button onClick={onCancel}>{cancelLabel}</Button>
          </RAlert.Cancel>
          <RAlert.Action asChild>
            <Button variant={variant === "danger" ? "danger" : "primary"} onClick={onConfirm} disabled={busy}>{confirmLabel}</Button>
          </RAlert.Action>
        </div>
      </Content>
    </Root>
  );
}

export const AlertDialog = Object.assign(AlertDialogComponent, {
  Root, Trigger, Content, Title, Description, Cancel, Action,
});

// ── Hook imperativo — confirm(): Promise<boolean>. Monte <ConfirmProvider> na raiz ──
export type ConfirmOptions = {
  title: ReactNode;
  description?: ReactNode;
  confirmLabel?: ReactNode;
  cancelLabel?: ReactNode;
  variant?: AlertDialogVariant;
};

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;
const ConfirmContext = createContext<ConfirmFn | null>(null);

export function useConfirm(): ConfirmFn {
  const c = useContext(ConfirmContext);
  if (!c) throw new Error("useConfirm precisa estar dentro de <ConfirmProvider>");
  return c;
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [opts, setOpts] = useState<ConfirmOptions | null>(null);
  const [open, setOpen] = useState(false);
  const resolver = useRef<((v: boolean) => void) | null>(null);

  const settle = useCallback((value: boolean) => {
    resolver.current?.(value);
    resolver.current = null;
    setOpen(false);
  }, []);

  const confirm = useCallback<ConfirmFn>((options) => {
    setOpts(options);
    setOpen(true);
    return new Promise<boolean>((resolve) => { resolver.current = resolve; });
  }, []);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <AlertDialog
        open={open}
        onOpenChange={(o) => { if (!o) settle(false); }}
        title={opts?.title ?? ""}
        description={opts?.description}
        confirmLabel={opts?.confirmLabel}
        cancelLabel={opts?.cancelLabel}
        variant={opts?.variant ?? "danger"}
        onConfirm={() => settle(true)}
        onCancel={() => settle(false)}
      />
    </ConfirmContext.Provider>
  );
}
