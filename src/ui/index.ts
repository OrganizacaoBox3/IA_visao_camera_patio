// Design system (átomos/moléculas) — Radix Primitives + tokens do projeto. Importe daqui.
import "./ui.css";

export { Button, IconButton, type ButtonProps } from "./Button";
export { Input, Textarea, Field, FieldLabel } from "./form";
export { Select, type SelectOption } from "./Select";
export { Switch, Checkbox, CheckboxRow, Slider } from "./controls";
export { ToggleRow } from "./ToggleRow";
export { SegmentedControl, type SegOption } from "./SegmentedControl";
export { Tooltip, TooltipProvider } from "./Tooltip";
export { Dialog } from "./Dialog";
export { ToastProvider, useToast, type ToastTone } from "./Toast";
// KPI: o átomo da casa é o Kpi/KpiRow de routes/report/KpiRow.tsx (o antigo KpiCard daqui
// era duplicata sem consumidor).
export { Badge, Spinner, Skeleton, SkeletonText, Alert, EmptyState, type Tone } from "./misc";
export { SectionTitle } from "./SectionTitle";
export { PageHeader } from "./PageHeader";
export { Tabs, TabsContent, type TabItem } from "./Tabs";
export { ScrollArea, type ScrollAreaProps } from "./ScrollArea";
export { DropdownMenu, type DropdownItem } from "./DropdownMenu";
export {
  AlertDialog,
  ConfirmProvider,
  useConfirm,
  type AlertDialogVariant,
  type ConfirmOptions,
} from "./AlertDialog";
export { Toggle, ToggleGroup, ToggleGroupItem, type ToggleGroupOption } from "./Toggle";
