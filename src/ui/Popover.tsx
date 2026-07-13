import * as RPopover from "@radix-ui/react-popover";
import { forwardRef, type ReactNode, type ComponentPropsWithoutRef, type ElementRef } from "react";
import { cx } from "./cx";

// ── Popover (Radix) — painel flutuante NÃO-MODAL para config leve na toolbar ──────────────────────
// Por que existe (ADR-007): a casca fullscreen da câmera NÃO pode virar Dialog (Portal/scroll-lock
// remontaria o <canvas> e mataria o rAF). Um Popover é a superfície certa para "o que mostrar sobre
// o vídeo" (spec-tela-camera §3-C, padrão Figma layers / Verkada toggles): flutua sobre a imagem
// (ADR-003 — a imagem é soberana, o popover não empurra o vídeo) e — CRUCIAL — o Radix Popover é
// NÃO-MODAL por padrão (`modal` default = false): SEM RemoveScroll/scroll-lock, então o <canvas> não
// é remontado. O conteúdo é portalado para o body (fora do subtree da casca) — quem consome deve
// marcar o trap de foco manual para deferir ESC/Tab ao Radix enquanto aberto (via onOpenChange),
// mesmo idioma do ConfigZonaDialog (cfgOpenRef).
//
// Estilo espelha o DropdownMenu (mesmos tokens/utilities): px/hex vivem aqui porque src/ui/** está
// FORA do escopo do lint-tokens (os átomos SÃO a implementação dos tokens).
const contentCls = cx(
  "z-[150] w-[min(20rem,calc(100vw-2rem))] rounded-sm border border-border bg-panel p-[var(--sp-3)]",
  "shadow-[0_12px_32px_rgba(0,0,0,0.5)]",
  "max-h-[min(70vh,34rem)] overflow-y-auto",
  // portado p/ o body; garante clique mesmo sobre a casca
  "pointer-events-auto",
);

const Root = RPopover.Root;

const Trigger = forwardRef<
  ElementRef<typeof RPopover.Trigger>,
  ComponentPropsWithoutRef<typeof RPopover.Trigger>
>(function PopTrigger(props, ref) {
  return <RPopover.Trigger ref={ref} {...props} />;
});

const Content = forwardRef<
  ElementRef<typeof RPopover.Content>,
  ComponentPropsWithoutRef<typeof RPopover.Content>
>(function PopContent({ className, sideOffset = 6, children, ...rest }, ref) {
  return (
    <RPopover.Portal>
      <RPopover.Content
        ref={ref}
        className={cx(contentCls, className)}
        sideOffset={sideOffset}
        collisionPadding={8}
        {...rest}
      >
        {children}
      </RPopover.Content>
    </RPopover.Portal>
  );
});

type PopoverProps = {
  /** Gatilho (recebe asChild — encaminhe a ref, ex.: <Button/> ou <Toggle/>). */
  trigger: ReactNode;
  children: ReactNode;
  align?: RPopover.PopoverContentProps["align"];
  side?: RPopover.PopoverContentProps["side"];
  ariaLabel?: string;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
};

// ── Alto nível — trigger + conteúdo flutuante. NÃO-MODAL por construção (Root sem `modal`). ──
function PopoverComponent({
  trigger,
  children,
  align = "end",
  side = "top",
  ariaLabel,
  open,
  defaultOpen,
  onOpenChange,
}: PopoverProps) {
  return (
    <Root open={open} defaultOpen={defaultOpen} onOpenChange={onOpenChange}>
      <Trigger asChild>{trigger}</Trigger>
      <Content align={align} side={side} aria-label={ariaLabel}>
        {children}
      </Content>
    </Root>
  );
}

export const Popover = Object.assign(PopoverComponent, { Root, Trigger, Content });
