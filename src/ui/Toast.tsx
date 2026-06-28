import * as RToast from "@radix-ui/react-toast";
import { createContext, useCallback, useContext, useState, type ReactNode } from "react";

export type ToastTone = "default" | "alert" | "ok";
type Item = { id: number; msg: string; tone: ToastTone };
type Ctx = { toast: (msg: string, tone?: ToastTone) => void };

const ToastCtx = createContext<Ctx | null>(null);
export function useToast(): Ctx {
  const c = useContext(ToastCtx);
  if (!c) throw new Error("useToast precisa estar dentro de <ToastProvider>");
  return c;
}

let seq = 0;
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Item[]>([]);
  const toast = useCallback((msg: string, tone: ToastTone = "default") => { setItems((p) => [...p, { id: ++seq, msg, tone }]); }, []);
  const remove = (id: number) => setItems((p) => p.filter((x) => x.id !== id));
  return (
    <ToastCtx.Provider value={{ toast }}>
      <RToast.Provider duration={5000} swipeDirection="down">
        {children}
        {items.map((it) => (
          <RToast.Root key={it.id} className={`ui-toast ${it.tone !== "default" ? `ui-toast--${it.tone}` : ""}`} onOpenChange={(o) => { if (!o) remove(it.id); }}>
            <RToast.Description>{it.msg}</RToast.Description>
          </RToast.Root>
        ))}
        <RToast.Viewport className="ui-toast-vp" />
      </RToast.Provider>
    </ToastCtx.Provider>
  );
}
