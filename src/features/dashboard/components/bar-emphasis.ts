/** Opacity of a bar while another one is hovered. Hovering is a pointer aid only; every bar keeps its text label. */
export const DIMMED = 0.45;

export function barOpacity(active: string | null, stage: string): number {
  return active === null || active === stage ? 1 : DIMMED;
}
