"use client";

import { useId, type ReactNode } from "react";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

/** Props to spread onto the control (input, select trigger, textarea) inside a FormField. */
export type FieldControlProps = {
  id: string;
  "aria-invalid"?: true;
  "aria-required"?: true;
  "aria-describedby"?: string;
};

type FormFieldProps = {
  label: string;
  /** Visible helper text under the label, for example the allowed format. */
  hint?: string;
  /** Put the hint under the control instead of between label and control, so controls in a row of fields line up. */
  hintBelow?: boolean;
  /** Error message for this field. Linked to the control and announced with the summary. */
  error?: string;
  required?: boolean;
  /** Overrides the generated id. Use the same id in `ErrorSummary` items. */
  id?: string;
  className?: string;
  children: (control: FieldControlProps) => ReactNode;
};

/**
 * The form pattern: every control has a visible label, helper text and the error are linked
 * with `aria-describedby`, and an invalid control is marked `aria-invalid`. Errors name the
 * problem in words ("Error: ...") so color is never the only signal.
 *
 * ```tsx
 * <FormField label="Email" error={errors.email} required>
 *   {(control) => <Input type="email" {...control} />}
 * </FormField>
 * ```
 */
export function FormField({
  label,
  hint,
  hintBelow,
  error,
  required,
  id: idProp,
  className,
  children,
}: FormFieldProps) {
  const generated = useId();
  const id = idProp ?? generated;
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(" ");

  const control: FieldControlProps = {
    id,
    ...(error ? { "aria-invalid": true as const } : {}),
    ...(required ? { "aria-required": true as const } : {}),
    ...(describedBy ? { "aria-describedby": describedBy } : {}),
  };

  const hintLine = (
    <p id={hintId} className="text-sm text-muted-foreground">
      {hint}
    </p>
  );

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <Label htmlFor={id}>
        {label}
        {required ? (
          <>
            <span aria-hidden="true" className="text-muted-foreground">
              *
            </span>
            <span className="sr-only">(required)</span>
          </>
        ) : null}
      </Label>
      {hint && !hintBelow ? hintLine : null}
      {children(control)}
      {hint && hintBelow ? hintLine : null}
      {error ? (
        <p
          id={errorId}
          className="text-sm font-medium text-destructive duration-(--motion-base) animate-in slide-in-from-top-1"
        >
          <span className="sr-only">Error:</span> {error}
        </p>
      ) : null}
    </div>
  );
}
