// Design system (átomos/moléculas) — Radix Primitives + tokens do projeto. Importe daqui.
import "./ui.css";

export { Button, IconButton, type ButtonProps } from "./Button";
export { Input, Textarea, Field, FieldLabel } from "./form";
export { Select, type SelectOption } from "./Select";
export { Switch, Checkbox, CheckboxRow, Slider } from "./controls";
export { ToggleRow } from "./ToggleRow";
export { SegmentedControl, type SegOption } from "./SegmentedControl";
export { Tooltip, TooltipProvider } from "./Tooltip";
export { HelpTip } from "./HelpTip";
export { Dialog } from "./Dialog";
export { ToastProvider, useToast, type ToastTone } from "./Toast";
// KPI: o átomo da casa é o Kpi/KpiRow/Delta de ./Kpi (movido de routes/report/KpiRow.tsx, que
// agora reexporta daqui). O antigo KpiCard duplicado foi removido.
export { Kpi, KpiRow, Delta } from "./Kpi";
export { Badge, Spinner, Skeleton, SkeletonText, Alert, EmptyState, type Tone } from "./misc";
export { Meter } from "./Meter";
export { Loading } from "./Loading";
export { StatusDot } from "./StatusDot";
export { Card } from "./Card";
export { InlineEdit } from "./InlineEdit";
export { SectionTitle } from "./SectionTitle";
export { PageHeader } from "./PageHeader";
export { Panel } from "./Panel";
export { Table, Th, TableEmpty, type TableColumn } from "./Table";
export { Tabs, TabsContent, type TabItem } from "./Tabs";
export { ScrollArea, type ScrollAreaProps } from "./ScrollArea";
export { DropdownMenu, type DropdownItem } from "./DropdownMenu";
export { Popover } from "./Popover";
export {
  AlertDialog,
  ConfirmProvider,
  useConfirm,
  type AlertDialogVariant,
  type ConfirmOptions,
} from "./AlertDialog";
export { Toggle, ToggleGroup, ToggleGroupItem, type ToggleGroupOption } from "./Toggle";
