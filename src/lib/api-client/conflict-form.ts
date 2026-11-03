import type { FieldValues, Path, PathValue, UseFormReturn } from "react-hook-form";

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * Puts the outcome of a conflict into a react-hook-form form. The form's baseline becomes the latest server values either way. For a
 * reload that is the whole story (the form is clean). For "apply my changes on top" each field where `values` differs from the latest
 * is set again and marked dirty, so the form shows exactly what saving would change and the person reviews it first.
 */
export function applyConflictToForm<V extends FieldValues>(
  form: UseFormReturn<V>,
  values: V,
  latest: V,
  how: "reload" | "merge",
  setBaseline: (latest: V) => void,
): void {
  form.reset(latest as never);
  setBaseline(latest);
  if (how === "reload") return;
  for (const key of Object.keys(values) as Array<Path<V>>) {
    if (!same(values[key], latest[key]))
      form.setValue(key, values[key] as PathValue<V, Path<V>>, {
        shouldDirty: true,
        shouldTouch: true,
      });
  }
}
