import type { ReactNode } from "react";

export const INPUT = "border border-line bg-bg px-2 py-1.5 text-xs text-fg outline-none focus:border-fg";

/** A labelled form control, label above, in the console's micro-typography. */
export function Field({ label, className = "", children }: { label: string; className?: string; children: ReactNode }) {
  return (
    <label className={`flex flex-col gap-1 text-xs uppercase tracking-wider text-fg-dim ${className}`}>
      {label}
      {children}
    </label>
  );
}

/** One label/value pair in a telemetry readout row. */
export function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wider text-fg-dim">{label}</dt>
      <dd className="text-xs text-fg">{children}</dd>
    </div>
  );
}
