import * as RToast from "@radix-ui/react-toast";
import { createContext, useCallback, useContext, useState, type ReactNode } from "react";

// Tailwind v4 (tokens do @theme; keyframe ui-toast-in permanece em ui.css → animate-[...]).
const cx = (...c: (string | false | undefined)[]) => c.filter(Boolean).join(" ");

export type ToastTone = "default" | "alert" | "ok";
type Item = { id: number; msg: string; tone: ToastTone };
type Ctx = { toast: (msg: string, tone?: ToastTone) => void };

const ToastCtx = createContext<Ctx | null>(null);
export function useToast(): Ctx {
  const c = useContext(ToastCtx);
  if (!c) throw new Error("useToast precisa estar dentro de <ToastProvider>");
  return c;
}

// Viewport: fixo embaixo/centralizado; bottom inclui safe-area-inset-bottom (--safe-b)
// p/ não colar no home-indicator (iOS). z-200 = acima do dialog (overlay 100 / content 101).
const TOAST_VP = cx(
  "fixed left-1/2 -translate-x-1/2 bottom-[calc(var(--sp-4)+var(--safe-b,0px))]",
  "flex flex-col gap-[var(--sp-2)]",
  "w-[min(420px,94vw)] z-[200]",
  "m-0 p-0 list-none outline-none",
);
// Card: faixa esquerda 3px indica o tom (going-gray: saturação só para estado).
const TOAST_BASE = cx(
  "bg-panel text-text text-[13px]",
  "border border-border border-l-[3px]",
  "rounded-[var(--radius-sm)] py-[var(--sp-2)] px-[var(--sp-3)]",
  "shadow-[0_8px_24px_rgba(0,0,0,0.45)]",
  "animate-[ui-toast-in_0.18s_ease]",
);
const TOAST_TONE: Record<ToastTone, string> = {
  default: "border-l-accent",
  alert: "border-l-critical",
  ok: "border-l-ok",
};

let seq = 0;
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Item[]>([]);
  const toast = useCallback((msg: string, tone: ToastTone = "default") => {
    setItems((p) => [...p, { id: ++seq, msg, tone }]);
  }, []);
  const remove = (id: number) => setItems((p) => p.filter((x) => x.id !== id));
  return (
    <ToastCtx.Provider value={{ toast }}>
      <RToast.Provider duration={5000} swipeDirection="down">
        {children}
        {items.map((it) => (
          <RToast.Root
            key={it.id}
            className={cx(TOAST_BASE, TOAST_TONE[it.tone])}
            onOpenChange={(o) => {
              if (!o) remove(it.id);
            }}
          >
            <RToast.Description>{it.msg}</RToast.Description>
          </RToast.Root>
        ))}
        <RToast.Viewport className={TOAST_VP} />
      </RToast.Provider>
    </ToastCtx.Provider>
  );
}
