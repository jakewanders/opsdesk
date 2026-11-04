import { ViewTransition, type ReactNode } from "react";

/**
 * The name a list row and its detail page share, so the browser can morph one into the other when you open it. Both sides
 * must come from here: the name is the only thing that pairs them.
 */
export function morphName(entity: "customer" | "opportunity", id: string): string {
  return `${entity}-${id}`;
}

/**
 * Wrap the name text (not the whole row) of a customer or opportunity, in the list and again in the detail header. Only
 * the paired morph animates; everything else on the page ignores unrelated transitions.
 */
export function Morph({
  entity,
  id,
  children,
}: {
  entity: "customer" | "opportunity";
  id: string;
  children: ReactNode;
}) {
  return (
    <ViewTransition name={morphName(entity, id)} share="morph" default="none">
      {children}
    </ViewTransition>
  );
}
