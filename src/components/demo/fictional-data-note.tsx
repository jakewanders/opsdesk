/** The standing label on every place sample data is shown: it is fictional demonstration data. */
export function FictionalDataNote({ className }: { className?: string }) {
  return (
    <p role="note" className={className ?? "text-sm text-muted-foreground"}>
      All names, companies and amounts in this workspace are fictional demonstration data. It is
      deleted when the demo ends.
    </p>
  );
}
