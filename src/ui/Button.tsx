import { forwardRef, type ButtonHTMLAttributes, type Ref } from "react";
import { Slot } from "@radix-ui/react-slot";

type Variant = "default" | "primary" | "danger" | "ghost";
export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md"; active?: boolean; block?: boolean; asChild?: boolean };

const cx = (...c: (string | false | undefined)[]) => c.filter(Boolean).join(" ");

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "default", size = "md", active, block, asChild, className, type, ...rest }, ref
) {
  const cls = cx("ui-btn", variant !== "default" && `ui-btn--${variant}`, size === "sm" && "ui-btn--sm", active && "ui-btn--active", block && "ui-btn--block", className);
  // asChild: compõe estilo no filho (ex.: <Button asChild><a/></Button> ou Trigger de Dialog/Tooltip/DropdownMenu).
  if (asChild) return <Slot ref={ref as Ref<HTMLElement>} className={cls} {...rest} />;
  return <button ref={ref} type={type ?? "button"} className={cls} {...rest} />;
});

export type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean; asChild?: boolean };
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, active, asChild, className, type, children, ...rest }, ref
) {
  const cls = cx("ui-iconbtn", active && "ui-iconbtn--active", className);
  if (asChild) return <Slot ref={ref as Ref<HTMLElement>} aria-label={label} className={cls} {...rest}>{children}</Slot>;
  return <button ref={ref} type={type ?? "button"} aria-label={label} title={label} className={cls} {...rest}>{children}</button>;
});
