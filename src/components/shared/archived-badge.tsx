/** Marks a linked record that is archived. It stays reachable; the badge says why it may look different. Words, not colour. */
export function ArchivedBadge() {
  return (
    <span className="ml-1.5 rounded-md border border-border px-1.5 py-0.5 text-xs text-muted-foreground">
      Archived
    </span>
  );
}
