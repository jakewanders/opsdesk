/**
 * What a stale-edit conflict (409) means field by field (PRD 7.5, SIT-271). Pure, so it is tested without React.
 *
 * Three snapshots of a form's values: the BASELINE the person started from (the version they loaded), MINE (what is in the form now)
 * and LATEST (what the server holds now). A field is "changed by others" when latest differs from the baseline, "mine" when the form
 * differs from the baseline, and an OVERLAP when both changed it to different values. Only a non-overlapping set of changes can be put
 * on top of the latest version without deciding between two people's work; and even then it only fills the form: the person reviews
 * and saves, so nothing is ever written silently.
 */
export type FormSnapshot = Record<string, unknown>;

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** The keys, in the given order, whose value differs between two snapshots. */
export function changedKeys<V extends FormSnapshot>(
  from: V,
  to: V,
  keys: readonly (keyof V & string)[],
): string[] {
  return keys.filter((k) => !same(from[k], to[k]));
}

export type ConflictAnalysis = {
  /** Fields someone else changed since the person opened the record. */
  byOthers: string[];
  /** Fields the person changed. */
  mine: string[];
  /** Fields both changed, to different values. */
  overlap: string[];
  /** My changes can go on top of the latest version without overriding anyone's. */
  canApplyOnTop: boolean;
};

export function analyzeConflict<V extends FormSnapshot>(
  baseline: V,
  mine: V,
  latest: V,
  keys: readonly (keyof V & string)[],
): ConflictAnalysis {
  const byOthers = changedKeys(baseline, latest, keys);
  const myKeys = changedKeys(baseline, mine, keys);
  const overlap = myKeys.filter((k) => byOthers.includes(k) && !same(mine[k], latest[k]));
  return {
    byOthers,
    mine: myKeys,
    overlap,
    canApplyOnTop: myKeys.length > 0 && overlap.length === 0,
  };
}

/** The latest values with the person's changed fields laid over them. */
export function mergeOnTop<V extends FormSnapshot>(
  latest: V,
  mine: V,
  myKeys: readonly string[],
): V {
  const out: FormSnapshot = { ...latest };
  for (const k of myKeys) out[k] = mine[k];
  return out as V;
}

/** Plain text of the person's own changes, for "copy my changes aside". Their own text only; nothing from the server. */
export function summarizeMine(
  labels: Record<string, string>,
  mine: FormSnapshot,
  keys: readonly string[],
): string {
  const show = (v: unknown) =>
    Array.isArray(v)
      ? v.map((x) => (typeof x === "object" ? JSON.stringify(x) : String(x))).join("; ")
      : String(v ?? "");
  return keys.map((k) => `${labels[k] ?? k}: ${show(mine[k])}`).join("\n");
}

/** "Name", "Name and Status", "Name, Status and Notes". */
export function listLabels(labels: Record<string, string>, keys: readonly string[]): string {
  const names = keys.map((k) => labels[k] ?? k);
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}
