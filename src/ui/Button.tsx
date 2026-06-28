import { forwardRef, type ButtonHTMLAttributes } from "react";

type Variant = "default" | "primary" | "danger" | "ghost";
export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md"; active?: boolean; block?: boolean };

const cx = (...c: (string | false | undefined)[]) => c.filter(Boolean).join(" ");

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "default", size = "md", active, block, className, type, ...rest }, ref
) {
  return (
    <button ref={ref} type={type ?? "button"} className={cx("ui-btn", variant !== "default" && `ui-btn--${variant}`, size === "sm" && "ui-btn--sm", active && "ui-btn--active", block && "ui-btn--block", className)} {...rest} />
  );
});

export type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean };
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, active, className, type, children, ...rest }, ref
) {
  return (
    <button ref={ref} type={type ?? "button"} aria-label={label} title={label} className={cx("ui-iconbtn", active && "ui-iconbtn--active", className)} {...rest}>{children}</button>
  );
});
